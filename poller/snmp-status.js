/**
 * SNMP status diagnosis (used by agent.js, mikrotik.js and probe.js).
 *
 * "No SNMP answer" has several different causes. This module tells them
 * apart using what the network actually returns, from wherever the agent is
 * connected right now — nothing here depends on a fixed IP or subnet:
 *
 *   responding   the device answered SNMP
 *   unreachable  no path to the device from the agent's current network
 *                (no ping reply, no SNMP reply) — says nothing about whether
 *                SNMP is enabled on it
 *   disabled     the device is reachable and refused UDP 161 (ICMP "port
 *                unreachable"): nothing is listening, SNMP is switched off
 *   auth_failed  the device is reachable, SNMP answered before, and now it is
 *                silent: it is refusing this agent (community changed, or the
 *                agent's current address is not in the allowed list).
 *                SNMP v1/v2c never sends an explicit "access denied" — a
 *                refused request is simply ignored — so this is inferred.
 *   timeout      the device is reachable but there was no SNMP reply and no
 *                refusal: wrong community, address not allowed, a firewall
 *                dropping UDP 161, or packet loss
 */

const os    = require('os')
const dgram = require('dgram')
const { exec, execFile } = require('child_process')
const { promisify } = require('util')
const snmp = require('net-snmp')

const execAsync     = promisify(exec)
const execFileAsync = promisify(execFile)
const isWindows = process.platform === 'win32'

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const SYS_UPTIME = '1.3.6.1.2.1.1.3.0'

const LABEL = {
  responding:  'SNMP responding',
  unreachable: 'SNMP unreachable',
  disabled:    'SNMP disabled',
  auth_failed: 'SNMP authentication failed',
  timeout:     'SNMP timeout',
}

// ── Where is the agent right now? ────────────────────────────────────────────
function ownAddresses() {
  const out = new Set()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4') out.add(a.address)
  }
  return out
}

// The local address the OS would use to reach `ip` (follows the routing
// table, so it is right for routed targets too). No packet is sent.
function sourceAddressFor(ip) {
  return new Promise(resolve => {
    if (!IPV4.test(ip)) return resolve(null)
    const s = dgram.createSocket('udp4')
    const done = v => { try { s.close() } catch {} resolve(v) }
    s.once('error', () => done(null))
    try { s.connect(9, ip, () => { try { done(s.address().address) } catch { done(null) } }) }
    catch { done(null) }
  })
}

async function agentLocation(ip) {
  const src = await sourceAddressFor(ip)
  if (!src || src === '0.0.0.0') return 'the agent has no network connection'
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    const hit = (list ?? []).find(a => a.family === 'IPv4' && a.address === src)
    if (hit) return `the agent is at ${src} on ${name}`
  }
  return `the agent is at ${src}`
}

// ── Checks ───────────────────────────────────────────────────────────────────
// ICMP echo: true only for a real reply from the target
async function ping(ip, tries = 2) {
  if (!IPV4.test(ip)) return false
  const cmd = isWindows ? `ping -n ${tries} -w 1000 ${ip}` : `ping -c ${tries} -W 1 ${ip}`
  let stdout = ''
  try { ({ stdout } = await execAsync(cmd, { timeout: tries * 1500 + 2000, windowsHide: true })) }
  catch (e) { stdout = e.stdout ?? '' }
  return new RegExp(`from ${ip.replace(/\./g, '\\.')}(?!\\d)[^\\n]*ttl[=:]`, 'i').test(stdout)
}

// MAC address the OS currently has for `ip` (same network only), or null
async function neighborMac(ip) {
  if (!IPV4.test(ip)) return null
  try {
    let mac
    if (isWindows) {
      const ps = `Get-NetNeighbor -AddressFamily IPv4 -IPAddress ${ip} -ErrorAction SilentlyContinue | Where-Object { $_.State -in 'Reachable','Stale','Delay','Probe' } | Select-Object -First 1 -ExpandProperty LinkLayerAddress`
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 8000, windowsHide: true })
      mac = stdout.trim()
    } else {
      const { stdout } = await execFileAsync('ip', ['-4', 'neigh', 'show', ip], { timeout: 5000 })
      mac = stdout.match(/lladdr ((?:[\da-f]{2}:){5}[\da-f]{2}) (REACHABLE|STALE|DELAY|PROBE)/i)?.[1]
    }
    if (!mac || !/^(?:[\da-f]{2}[:-]){5}[\da-f]{2}$/i.test(mac)) return null
    return mac.replace(/-/g, ':').toUpperCase()
  } catch {
    return null
  }
}

// '1' → SNMP v1, anything else → v2c (the default)
const versionOf = v => (String(v ?? '2c') === '1' ? snmp.Version1 : snmp.Version2c)

// ── Route analysis ───────────────────────────────────────────────────────────
// How would this computer reach `ip` right now? SNMP is ordinary UDP: it
// crosses networks only where the operating system has a route.
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/
const routeCache = new Map()   // ip → { info, at }

async function routeInfo(ip) {
  const hit = routeCache.get(ip)
  if (hit && Date.now() - hit.at < 30_000) return hit.info

  const toInt = a => a.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0)
  let onLink = null   // adapter name when `ip` is in one of this computer's own networks
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.cidr) continue
      const prefix = Number(a.cidr.split('/')[1])
      const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
      if (((toInt(a.address) & mask) >>> 0) === ((toInt(ip) & mask) >>> 0)) onLink = name
    }
  }

  const source = await sourceAddressFor(ip)
  let prefix = null, nextHop = null
  try {
    if (isWindows) {
      const ps = `$r = Find-NetRoute -RemoteIPAddress ${ip} -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix } | Select-Object -First 1; if ($r) { $r.DestinationPrefix + ' ' + $r.NextHop }`
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 8000, windowsHide: true })
      ;[prefix, nextHop] = stdout.trim().split(/\s+/)
    } else {
      const { stdout } = await execFileAsync('ip', ['-4', 'route', 'show', 'to', 'match', ip], { timeout: 5000 })
      // most specific route = longest prefix
      const routes = stdout.split('\n').filter(Boolean).map(l => ({ p: l.split(' ')[0], via: l.match(/via ([\d.]+)/)?.[1] ?? null }))
      routes.sort((a, b) => Number((b.p.split('/')[1]) ?? (b.p === 'default' ? 0 : 32)) - Number((a.p.split('/')[1]) ?? (a.p === 'default' ? 0 : 32)))
      if (routes[0]) { prefix = routes[0].p === 'default' ? '0.0.0.0/0' : routes[0].p; nextHop = routes[0].via }
    }
  } catch { /* routing table unavailable */ }

  const info = {
    source: source && source !== '0.0.0.0' ? source : null,
    onLink,
    viaDefault: !onLink && (!prefix || prefix === '0.0.0.0/0'),   // no route of its own: goes to the default gateway
    nextHop: nextHop && nextHop !== '0.0.0.0' ? nextHop : null,
    prefix: prefix ?? null,
    private: PRIVATE.test(ip),
  }
  routeCache.set(ip, { info, at: Date.now() })
  return info
}

// One line: how traffic for `ip` leaves this computer
function describeRoute(ip, r) {
  if (!r.source) return 'This computer has no network connection.'
  if (r.onLink) return `${ip} is on the same network as this computer (${r.onLink}, this computer is ${r.source}).`
  if (r.viaDefault) return `No route of its own: traffic for ${ip} is sent to the default gateway${r.nextHop ? ` ${r.nextHop}` : ''} (this computer is ${r.source}).`
  return `Routed: ${r.prefix} via ${r.nextHop ?? 'a local adapter'} (this computer is ${r.source}).`
}

// Why there is no path, and what network setup would create one
function explainNoPath(ip, r) {
  if (!r.source) return `This computer has no network connection, so ${ip} cannot be reached.`
  if (r.onLink) {
    return `${ip} is on the same network as this computer (${r.onLink}) but does not answer — it is powered off, unplugged, or now has a different address.`
  }
  const net = ip.split('.').slice(0, 3).join('.') + '.0/24'
  if (r.viaDefault && r.private) {
    return `${ip} is a private address on a different network, and this computer (${r.source}) has no route to it: the traffic goes to the default gateway${r.nextHop ? ` ${r.nextHop}` : ''}, which does not know that network. ` +
      `SNMP cannot cross between two separate networks by itself. To monitor the device from here, one of these is needed: ` +
      `(1) connect this computer to the device's network; ` +
      `(2) a route — a router that reaches ${net}, a route to it on this computer, a route back on the device, and this computer's address allowed in the device's SNMP settings and firewall; ` +
      `(3) a VPN between this computer and the device's network, then use the device's VPN address as its SNMP address; ` +
      `(4) run the SecureNet agent on a computer inside the device's network.`
  }
  if (r.viaDefault) {
    return `${ip} is a public address that does not answer from here (this computer is ${r.source}). The device's SNMP port is not reachable from the internet — and should not be: SNMP v1/v2c is unencrypted. Use a VPN to the device's network instead.`
  }
  return `There is a route to ${ip} (${r.prefix} via ${r.nextHop ?? 'a local adapter'}, this computer is ${r.source}) but nothing answers. ` +
    `Either the device is off, a firewall on the way blocks ping and UDP 161, or the device has no route back to this computer's network.`
}

// One quick SNMP request (1 s, no retries) → the reply, or null
function quickGet(ip, community, port, oids = [SYS_UPTIME], version = snmp.Version2c) {
  return new Promise(resolve => {
    let s = null
    try {
      s = snmp.createSession(ip, community, { port, version, timeout: 1000, retries: 0 })
      s.on('error', () => { try { s.close() } catch {} resolve(null) })
      s.get(oids, (err, vb) => { try { s.close() } catch {} resolve(err ? null : vb) })
    } catch {
      try { s?.close() } catch {}
      resolve(null)
    }
  })
}

// Is anything listening on UDP `port`?  'closed' = the device refused it
// (ICMP port unreachable), 'reply' = something answered, 'silent' = neither.
// Node hides the refusal on Windows, so .NET is used there.
const portCache = new Map()   // `${ip}:${port}` → { state, at }
const PORT_CACHE_MS = 5 * 60_000

async function udpPortState(ip, port) {
  if (!IPV4.test(ip) || !Number.isInteger(port) || port < 1 || port > 65535) return 'silent'
  if (ownAddresses().has(ip)) return 'silent'   // our own address proves nothing about a device
  const key = `${ip}:${port}`
  const hit = portCache.get(key)
  if (hit && Date.now() - hit.at < PORT_CACHE_MS) return hit.state

  let state = 'silent'
  try {
    if (isWindows) {
      const script =
        `$u = New-Object System.Net.Sockets.UdpClient; try { $u.Client.ReceiveTimeout = 1500; $u.Connect('${ip}', ${port}); ` +
        `[void]$u.Send([byte[]](0x30, 0x00), 2); $ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0); ` +
        `[void]$u.Receive([ref]$ep); 'reply' } catch [System.Net.Sockets.SocketException] { ` +
        `if ($_.Exception.SocketErrorCode -eq 'ConnectionReset') { 'closed' } else { 'silent' } } catch { 'silent' } finally { $u.Close() }`
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10_000, windowsHide: true })
      const out = stdout.trim()
      if (out === 'closed' || out === 'reply') state = out
    } else {
      state = await new Promise(resolve => {
        const s = dgram.createSocket('udp4')
        const done = v => { clearTimeout(t); try { s.close() } catch {} resolve(v) }
        const t = setTimeout(() => done('silent'), 1500)
        s.once('error', e => done(e.code === 'ECONNREFUSED' ? 'closed' : 'silent'))
        s.once('message', () => done('reply'))
        try { s.connect(port, ip, () => s.send(Buffer.from([0x30, 0x00]), err => { if (err) done(err.code === 'ECONNREFUSED' ? 'closed' : 'silent') })) }
        catch { done('silent') }
      })
    }
  } catch { /* probe unavailable — treated as silent */ }
  portCache.set(key, { state, at: Date.now() })
  return state
}

// ── Diagnosis for a device that did not answer SNMP ──────────────────────────
//   reachable     true / false when the caller already knows (e.g. from the
//                 agent's own ICMP/ARP check); undefined → ping it here
//   everAnswered  SNMP has answered for this device before
async function diagnoseNoAnswer({ ip, port = 161, community = null, reachable, everAnswered = false }) {
  const where = await agentLocation(ip)
  if (reachable === undefined) reachable = await ping(ip)

  if (!reachable) {
    // Say why there is no path and what would create one — never "SNMP disabled"
    return {
      status: 'unreachable',
      detail: `${explainNoPath(ip, await routeInfo(ip))} This says nothing about whether SNMP is enabled on the device.`,
    }
  }

  if (await udpPortState(ip, port) === 'closed') {
    return {
      status: 'disabled',
      detail: `${ip} is reachable but refused UDP port ${port} — the SNMP service is not running on it. Enable SNMP on the device.`,
    }
  }

  if (everAnswered) {
    return {
      status: 'auth_failed',
      detail: `${ip} is reachable and SNMP answered before, but it now ignores this agent (${where}). ` +
              `The device is refusing access: check that the community${community ? ` "${community}"` : ''} is still correct and that the agent's current address is in the device's allowed SNMP addresses.`,
    }
  }

  return {
    status: 'timeout',
    detail: `${ip} is reachable but did not answer SNMP on UDP ${port} and did not refuse it (${where}). ` +
            `Either the community${community ? ` "${community}"` : ''} is wrong, the agent's address is not allowed by the device, a firewall is dropping UDP ${port}, or SNMP is not enabled.`,
  }
}

// ── Connection test (dashboard: "Test connection") ───────────────────────────
// Runs every step from the network the agent is on right now and reports
// where the path breaks: route → ping → SNMP request → (UDP port check).
const vbText = vb => {
  if (!vb || snmp.isVarbindError(vb) || vb.value == null) return null
  const v = Buffer.isBuffer(vb.value) ? vb.value.toString('utf8') : String(vb.value)
  return v.replace(/\0/g, '').trim() || null
}
const vbNumber = vb => {
  if (!vb || snmp.isVarbindError(vb) || vb.value == null) return null
  if (Buffer.isBuffer(vb.value)) return Number(vb.value.reduce((a, b) => (a << 8n) | BigInt(b), 0n))
  const n = Number(vb.value)
  return Number.isFinite(n) ? n : null
}

function openSession(ip, community, port, version, timeout = 2000, retries = 1) {
  const s = snmp.createSession(ip, community, { port, version, timeout, retries })
  s.on('error', () => {})
  return s
}
const sessionGet = (s, oids) => new Promise(resolve => s.get(oids, (err, vb) => resolve(err ? null : vb)))
// One table column → Map(row index → varbind), at most `max` rows
const walkColumn = (s, oid, max = 48) => new Promise(resolve => {
  const out = new Map()
  let done = false
  const finish = () => { if (!done) { done = true; resolve(out) } }
  try {
    s.subtree(oid, 20, vbs => {
      for (const vb of vbs) {
        if (snmp.isVarbindError(vb) || out.size >= max) continue
        out.set(vb.oid.slice(oid.length + 1), vb)
      }
    }, finish)
  } catch { finish() }
})

const SYS_GROUP = ['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.3.0', '1.3.6.1.2.1.1.4.0', '1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.6.0', '1.3.6.1.2.1.2.1.0']
const IF_STATUS = { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'not present', 7: 'lower layer down' }

async function connectionTest({ host, port = 161, community, version = '2c', everAnswered = false }) {
  host = String(host ?? '').trim()
  port = Number(port)
  community = String(community ?? '')
  version = String(version) === '1' ? '1' : '2c'
  if (!IPV4.test(host)) throw new Error('Enter a valid IPv4 address')   // never pass anything else to the shell
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SNMP port must be 1–65535')
  if (!community || community.length > 64) throw new Error('Enter the SNMP community (up to 64 characters)')

  const steps = []
  const step = (name, state, detail) => steps.push({ name, state, detail })   // state: ok | warn | fail

  // 1. Route
  const route = await routeInfo(host)
  step('Route', !route.source ? 'fail' : route.onLink || !route.viaDefault ? 'ok' : 'warn', describeRoute(host, route))

  // 2. Ping (some devices block it — SNMP is still tried)
  const pinged = route.source ? await ping(host, 2) : false
  step('Ping', pinged ? 'ok' : 'warn', pinged ? `${host} answers ping.` : `No ping reply from ${host}.`)

  // 3. SNMP request, with the configured version; then the other one to spot a version mismatch
  let s = openSession(host, community, port, versionOf(version))
  let vb = route.source ? await sessionGet(s, SYS_GROUP) : null
  let answeredVersion = vb ? version : null
  if (!vb && route.source) {
    s.close()
    const other = version === '1' ? '2c' : '1'
    s = openSession(host, community, port, versionOf(other), 1500, 0)
    vb = await sessionGet(s, SYS_GROUP)
    if (vb) answeredVersion = other
  }

  let status, detail, info = null
  if (vb) {
    const ticks = vbNumber(vb[1])
    const secs = ticks === null ? null : Math.floor(ticks / 100)
    const [names, oper, inO, outO] = [
      await walkColumn(s, '1.3.6.1.2.1.2.2.1.2'), await walkColumn(s, '1.3.6.1.2.1.2.2.1.8'),
      await walkColumn(s, '1.3.6.1.2.1.2.2.1.10'), await walkColumn(s, '1.3.6.1.2.1.2.2.1.16'),
    ]
    info = {
      name: vbText(vb[3]), description: vbText(vb[0]), location: vbText(vb[4]), contact: vbText(vb[2]),
      uptime: secs === null ? null : `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h ${Math.floor((secs % 3600) / 60)}m`,
      interfaceCount: vbNumber(vb[5]) ?? names.size,
      interfaces: [...names.keys()].map(i => ({
        index: Number(i), name: vbText(names.get(i)) ?? `if${i}`,
        status: IF_STATUS[vbNumber(oper.get(i))] ?? 'unknown',
        inBytes: vbNumber(inO.get(i)), outBytes: vbNumber(outO.get(i)),
      })),
    }
    status = 'responding'
    detail = answeredVersion === version
      ? `Connected: ${host} answered SNMP ${version === '1' ? 'v1' : 'v2c'} on UDP ${port}.`
      : `Connected, but only with SNMP ${answeredVersion === '1' ? 'v1' : 'v2c'} — the device does not answer ${version === '1' ? 'v1' : 'v2c'}. Change the SNMP version to ${answeredVersion === '1' ? 'v1' : 'v2c'}.`
    step('SNMP', answeredVersion === version ? 'ok' : 'warn', detail)
  } else {
    const diag = await diagnoseNoAnswer({ ip: host, port, community, reachable: pinged, everAnswered })
    status = diag.status
    detail = diag.detail
    step('SNMP', 'fail', `No SNMP reply on UDP ${port} (tried v${version === '1' ? '1' : '2c'} and v${version === '1' ? '2c' : '1'} with this community).`)
    if (pinged) {
      const p = await udpPortState(host, port)
      step('UDP port', p === 'closed' ? 'fail' : 'warn', p === 'closed'
        ? `The device refused UDP ${port}: nothing is listening — SNMP is switched off.`
        : `UDP ${port} was neither answered nor refused: the request is being ignored or dropped on the way.`)
    }
  }
  try { s.close() } catch {}

  return {
    host, port, version, testedAt: new Date().toISOString(),
    agent: { source: route.source, adapter: route.onLink },
    steps, status, label: status === 'responding' ? 'Connected' : LABEL[status].replace(/^SNMP /, '').replace(/^\w/, c => c.toUpperCase()),
    detail, answeredVersion, info,
  }
}

// ── Saving the status on the device record ───────────────────────────────────
// Needs supabase/migration_snmp_status.sql; without it nothing is written.
const lastWritten = new Map()   // device id → `${status}|${detail}`
let columnsMissing = false
let columnsRetryAt = 0

async function writeDeviceStatus(db, deviceId, status, detail) {
  const key = `${status}|${detail}`
  if (lastWritten.get(deviceId) === key) return          // unchanged — no write
  if (columnsMissing && Date.now() < columnsRetryAt) return
  const { error } = await db.from('devices')
    .update({ snmp_status: status, snmp_detail: detail, snmp_checked_at: new Date().toISOString() })
    .eq('id', deviceId)
  if (error) {
    if (/column|schema cache/i.test(error.message)) {
      if (!columnsMissing) console.log('  [snmp] run supabase/migration_snmp_status.sql to show SNMP status (unreachable / disabled / auth failed / timeout) on the dashboard')
      columnsMissing = true
      columnsRetryAt = Date.now() + 5 * 60_000
    }
    return
  }
  columnsMissing = false
  lastWritten.set(deviceId, key)
}

// ── SNMP monitor: Online → Warning → Offline ─────────────────────────────────
// Every device that has answered SNMP is asked for sysUpTime on its own
// schedule, from whatever network the agent is on right now:
//   online   it answered
//   warning  it missed a check — re-checked every few seconds
//   offline  no answer for SNMP_OFFLINE_AFTER_MS (2 min) and at least
//            SNMP_FAILS_BEFORE_OFFLINE checks in a row → one alert
//   unknown  the agent has no path to the device from its current network
//            (laptop on another Wi-Fi with no VPN) — nothing is concluded,
//            no failures are counted and no alert is raised
// When it answers again it is Online, the alert is resolved and the downtime
// is recorded. Only real SNMP replies count; nothing is assumed.
//
// Settings (poller/.env):
//   SNMP_CHECK_MS              how often each device is checked     (10000)
//   SNMP_RECHECK_MS            re-check interval while in Warning    (5000)
//   SNMP_OFFLINE_AFTER_MS      no answer this long → Offline         (120000)
//   SNMP_FAILS_BEFORE_OFFLINE  …and at least this many misses        (3)
//   SNMP_TIMEOUT_MS            wait per SNMP request                 (2000)
//   SNMP_RETRIES               resends per check                     (1)
const envInt = (name, def, min = 1) => {
  const n = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(n) && n >= min ? n : def
}
const MON = {
  checkMs:        envInt('SNMP_CHECK_MS', 10_000, 1000),
  recheckMs:      envInt('SNMP_RECHECK_MS', 5_000, 1000),
  offlineAfterMs: envInt('SNMP_OFFLINE_AFTER_MS', 120_000, 0),
  minFails:       envInt('SNMP_FAILS_BEFORE_OFFLINE', 3),
  timeoutMs:      envInt('SNMP_TIMEOUT_MS', 2_000, 200),
  retries:        envInt('SNMP_RETRIES', 1, 0),
}
const SYSTEM_USER = 'System (agent)'

// One SNMP request. true = the device answered (an SNMP error reply is still
// an answer — the device is up); false = silence.
function snmpAnswers(host, community, port, version) {
  return new Promise(resolve => {
    let s = null, finished = false
    const finish = v => { if (finished) return; finished = true; try { s?.close() } catch {} resolve(v) }
    try {
      s = snmp.createSession(host, community, { port, version, timeout: MON.timeoutMs, retries: MON.retries })
      s.on('error', () => finish(false))
      s.get([SYS_UPTIME], err => finish(!err || err.name === 'RequestFailedError'))
    } catch { finish(false) }
  })
}

// Identity of the network the agent is on: default gateway + its MAC.
// Two Wi-Fi networks can use the same address range (192.168.1.0/24);
// the gateway's MAC tells them apart.
let netCache = { id: null, at: 0 }
async function agentNetworkId() {
  if (Date.now() - netCache.at < 15_000) return netCache.id
  let gw = null
  try {
    if (isWindows) {
      const { stdout } = await execAsync('route print -4 0.0.0.0', { timeout: 5000, windowsHide: true })
      const routes = [...stdout.matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+([\d.]+)\s+([\d.]+)\s+(\d+)/gm)]
        .sort((a, b) => Number(a[3]) - Number(b[3]))
      gw = routes[0]?.[1] ?? null
    } else {
      const { stdout } = await execAsync('ip -4 route get 1.1.1.1', { timeout: 5000 })
      gw = stdout.match(/via ([\d.]+)/)?.[1] ?? null
    }
  } catch { /* no default route */ }
  let id = null
  if (gw && IPV4.test(gw)) {
    const mac = await neighborMac(gw)
    id = mac ? `${gw} ${mac}` : gw
  }
  netCache = { id, at: Date.now() }
  return id
}

// Can the agent judge `host` from where it is now? { ok } or { ok: false, why }
async function pathTo(host, lastOkNet) {
  const r = await routeInfo(host)
  if (!r.source) return { ok: false, why: 'This computer has no network connection.' }
  if (r.viaDefault && r.private) return { ok: false, why: explainNoPath(host, r) }
  if (r.onLink && lastOkNet) {
    const now = await agentNetworkId()
    if (now && now !== lastOkNet) {
      return { ok: false, why: `The agent is on a different network now (gateway ${now.split(' ')[0]}) than when ${host} last answered SNMP, although it uses the same address range — ${host} cannot be checked from here.` }
    }
  }
  return { ok: true }
}

const fmtDuration = ms => {
  const s = Math.max(0, Math.round(ms / 1000))
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`
}

const monitored = new Map()   // device id → state (see track())
let monDb = null
let stateColumns = true       // supabase/migration_snmp_monitoring.sql installed?
let stateRetryAt = 0
let lastDeviceLoad = 0
let deviceRows = []
let routerIps = new Map()     // device id → address the MikroTik collector last reached it at

// A device is SNMP-monitored once it has answered SNMP at least once, so
// devices without SNMP (phones, PCs) are never reported or alerted on
function answeredBefore(d) {
  return !!d.snmp_last_ok_at || d.snmp_status === 'responding' || d.snmp_status === 'auth_failed' ||
    d.cpu > 0 || d.mem > 0 || (!!d.uptime && d.uptime !== '—') || monitored.get(d.id)?.lastOkAt
}

async function loadMonitoredDevices() {
  const [{ data, error }, routers] = await Promise.all([
    monDb.from('devices').select('*'),
    monDb.from('mikrotik_routers').select('device_id, ip').then(r => r, () => ({ data: null })),
  ])
  if (error || !data) return
  routerIps = new Map((routers.data ?? []).map(r => [r.device_id, r.ip]))
  deviceRows = data.filter(d => d.snmp_community && d.status !== 'maint' && answeredBefore(d))
  const present = new Set(deviceRows.map(d => d.id))
  // No longer SNMP-monitored (never answered, in maintenance, SNMP removed):
  // clear the old Online/Warning/Offline so it isn't shown as current
  const stale = data.filter(d => d.snmp_state && !present.has(d.id)).map(d => d.id)
  if (stale.length) {
    await monDb.from('devices').update({ snmp_state: null, snmp_fail_count: 0, snmp_down_since: null }).in('id', stale)
  }
  for (const id of monitored.keys()) if (!present.has(id)) monitored.delete(id)
  for (const d of deviceRows) {
    if (monitored.has(d.id)) continue
    // Continue where the last run left off (an agent restart never repeats an alert)
    const state = d.snmp_state ?? null
    monitored.set(d.id, {
      state,
      fails:       Number(d.snmp_fail_count) || 0,
      firstFailAt: d.snmp_down_since ? Date.parse(d.snmp_down_since) : null,
      // An outage still open (Offline, or Offline and then out of reach)
      downSince:   (state === 'offline' || state === 'unknown') && d.snmp_down_since ? Date.parse(d.snmp_down_since) : null,
      lastOkAt:    d.snmp_last_ok_at ? Date.parse(d.snmp_last_ok_at) : null,
      lastOkNet:   null,
      nextAt:      0,
      busy:        false,
      savedAt:     0,
    })
  }
}

async function saveState(dev, t, force = false) {
  if (!stateColumns && Date.now() < stateRetryAt) return
  const row = {
    snmp_state:      t.state,
    snmp_fail_count: t.fails,
    snmp_down_since: t.firstFailAt ? new Date(t.firstFailAt).toISOString() : null,
    snmp_last_ok_at: t.lastOkAt ? new Date(t.lastOkAt).toISOString() : null,
  }
  const key = JSON.stringify(row)
  // Unchanged rows are not rewritten (each write refreshes the dashboard);
  // last-OK time is refreshed every 5 minutes
  if (!force && t.savedKey === key) return
  if (!force && t.savedKey && t.state === 'online' && JSON.parse(t.savedKey).snmp_state === 'online' && Date.now() - t.savedAt < 5 * 60_000) return
  const { error } = await monDb.from('devices').update(row).eq('id', dev.id)
  if (error) {
    if (/column|schema cache/i.test(error.message)) {
      if (stateColumns) console.log('  [snmp-monitor] run supabase/migration_snmp_monitoring.sql to show SNMP Online / Warning / Offline on the dashboard (monitoring and alerts work without it)')
      stateColumns = false
      stateRetryAt = Date.now() + 5 * 60_000
    }
    return
  }
  stateColumns = true
  t.savedKey = key
  t.savedAt = Date.now()
}

const alertMeta = (dev, host, port, status) =>
  `SNMP: ${host}:${port} · Device address ${dev.ip} · Location: ${dev.location || 'Unassigned'} · Method: SNMP · Status: ${status}`

async function insertAlertRow(full) {
  const { error } = await monDb.from('alerts').insert(full)
  if (error && /column|schema cache/i.test(error.message)) {
    const { severity, title, meta, acked, suppressed, root_cause } = full
    await monDb.from('alerts').insert({ severity, title, meta, acked, suppressed, root_cause })
  }
}

async function raiseOffline(dev, host, port, t, detail) {
  // One alert per outage: not if this outage already has one (SNMP's own, or
  // the ICMP monitor's offline alert for the same device)
  const [own, icmp] = await Promise.all([
    monDb.from('alerts').select('id').eq('severity', 'crit').is('resolved_at', null).ilike('meta', `SNMP: ${host}:${port} %`).limit(1),
    monDb.from('alerts').select('id').eq('severity', 'crit').is('resolved_at', null).ilike('meta', `%IP: ${dev.ip} %`).limit(1),
  ])
  if (own.data?.length) return
  if (icmp.data?.length) {
    console.log(`  [snmp-monitor] ${dev.name}: offline — already covered by the open offline alert for ${dev.ip}`)
    return
  }
  await insertAlertRow({
    severity: 'crit', title: `${dev.name} is not responding to SNMP`,
    meta: alertMeta(dev, host, port, 'Offline'), acked: false, suppressed: false,
    root_cause: `No SNMP reply from ${host}:${port} for ${fmtDuration(Date.now() - t.firstFailAt)} (${t.fails} checks in a row). ${detail}`,
    device_name: dev.name, device_ip: dev.ip, device_mac: dev.mac ?? null,
    location: dev.location || 'Unassigned', detection_method: 'SNMP', status: 'offline',
  })
}

async function recordRecovery(dev, host, port, downSince) {
  const downFor = fmtDuration(Date.now() - downSince)
  const since = new Date(downSince).toISOString()
  await monDb.from('alerts')
    .update({ acked: true, resolved_at: new Date().toISOString(), resolved_by: SYSTEM_USER, resolution_notes: `SNMP answering again — down for ${downFor} (since ${since})` })
    .eq('severity', 'crit').is('resolved_at', null).ilike('meta', `SNMP: ${host}:${port} %`)
  await insertAlertRow({
    severity: 'info', title: `${dev.name} is responding to SNMP again`,
    meta: alertMeta(dev, host, port, 'Online'), acked: true, suppressed: false,
    root_cause: `SNMP down for ${downFor} (since ${since})`,
    device_name: dev.name, device_ip: dev.ip, device_mac: dev.mac ?? null,
    location: dev.location || 'Unassigned', detection_method: 'SNMP', status: 'online',
  })
}

async function checkDevice(dev) {
  const t = monitored.get(dev.id)
  const community = dev.snmp_community
  const port      = dev.snmp_port ?? 161
  const version   = versionOf(dev.snmp_version)
  // Addresses to try: the configured SNMP address (e.g. over a VPN) or the
  // device's own, then where the MikroTik collector last reached it
  const primary = IPV4.test(dev.snmp_host ?? '') ? dev.snmp_host : dev.ip
  const hosts = [primary]
  const alt = routerIps.get(dev.id)
  if (alt && alt !== primary && IPV4.test(alt)) hosts.push(alt)

  let okHost = null
  for (const h of hosts) if (await snmpAnswers(h, community, port, version)) { okHost = h; break }
  const now = Date.now()

  if (okHost) {
    const was = t.state
    if (was === 'offline' || t.downSince) {
      const downSince = t.downSince ?? t.firstFailAt ?? now
      console.log(`  [snmp-monitor] ${dev.name} ${okHost}: Online again after ${fmtDuration(now - downSince)}`)
      await recordRecovery(dev, primary, port, downSince)
    } else if (was === 'warning') {
      console.log(`  [snmp-monitor] ${dev.name} ${okHost}: Online (missed ${t.fails} check${t.fails === 1 ? '' : 's'})`)
    } else if (was !== 'online') {
      console.log(`  [snmp-monitor] ${dev.name} ${okHost}: Online`)
    }
    const r = await routeInfo(okHost)
    Object.assign(t, { state: 'online', fails: 0, firstFailAt: null, downSince: null, lastOkAt: now })
    if (r.onLink) t.lastOkNet = await agentNetworkId()
    t.nextAt = now + MON.checkMs
    await saveState(dev, t)
    return
  }

  // No answer — first make sure the agent can reach that network at all
  const path = await pathTo(primary, t.lastOkNet)
  if (!path.ok) {
    if (t.state !== 'unknown') console.log(`  [snmp-monitor] ${dev.name} ${primary}: not checked — ${path.why}`)
    // An outage that started earlier stays open; it is closed when the device answers again
    Object.assign(t, { state: 'unknown', fails: 0, firstFailAt: t.downSince })
    t.nextAt = now + MON.checkMs
    await saveState(dev, t)
    return
  }

  t.fails += 1
  t.firstFailAt ??= now
  const failingFor = now - t.firstFailAt

  if (t.state === 'offline') {
    t.nextAt = now + MON.checkMs
    await saveState(dev, t)
    return
  }

  if (t.fails >= MON.minFails && failingFor >= MON.offlineAfterMs) {
    const diag = await diagnoseNoAnswer({ ip: primary, port, community, everAnswered: true })
    console.log(`  [snmp-monitor] ${dev.name} ${primary}: Offline — no SNMP reply for ${fmtDuration(failingFor)} (${t.fails} checks)`)
    Object.assign(t, { state: 'offline', downSince: t.firstFailAt })
    await raiseOffline(dev, primary, port, t, diag.detail)
    t.nextAt = now + MON.checkMs
    await saveState(dev, t, true)
    return
  }

  if (t.state !== 'warning') {
    console.log(`  [snmp-monitor] ${dev.name} ${primary}: Warning — missed an SNMP check, re-checking every ${MON.recheckMs / 1000}s (Offline after ${fmtDuration(MON.offlineAfterMs)})`)
  }
  t.state = 'warning'
  t.nextAt = now + MON.recheckMs
  await saveState(dev, t)
}

async function monitorTick() {
  if (Date.now() - lastDeviceLoad >= MON.checkMs) {
    lastDeviceLoad = Date.now()
    await loadMonitoredDevices()
  }
  const now = Date.now()
  // Each device on its own: a silent device never delays another
  for (const dev of deviceRows) {
    const t = monitored.get(dev.id)
    if (!t || t.busy || now < t.nextAt) continue
    t.busy = true
    checkDevice(dev)
      .catch(e => console.log(`  [snmp-monitor] ${dev.name}: ${e.message}`))
      .finally(() => { t.busy = false })
  }
}

// isActive: () => boolean — false while this agent is standing by for another one
function startMonitor(db, isActive = () => true) {
  monDb = db
  const loop = async () => {
    try { if (isActive()) await monitorTick() } catch (e) { console.log(`  [snmp-monitor] ${e.message}`) }
    setTimeout(loop, 1000)
  }
  loop()
}

// The monitor's current view of a device (used by the data poll in agent.js)
const monitorState = id => monitored.get(id)?.state ?? null

module.exports = {
  IPV4, LABEL, ownAddresses, sourceAddressFor, agentLocation,
  ping, neighborMac, quickGet, udpPortState, diagnoseNoAnswer, writeDeviceStatus,
  versionOf, routeInfo, describeRoute, explainNoPath, connectionTest,
  startMonitor, monitorState, MON,
}
