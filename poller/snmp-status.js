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

// One quick SNMP request (1 s, no retries) → the reply, or null
function quickGet(ip, community, port, oids = [SYS_UPTIME]) {
  return new Promise(resolve => {
    let s = null
    try {
      s = snmp.createSession(ip, community, { port, version: snmp.Version2c, timeout: 1000, retries: 0 })
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
    return {
      status: 'unreachable',
      detail: `${ip} cannot be reached from the agent's current network (${where}) — it does not answer. ` +
              `The device is off, or it is on a network this agent has no route to. This says nothing about whether SNMP is enabled on it.`,
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

module.exports = {
  IPV4, LABEL, ownAddresses, sourceAddressFor, agentLocation,
  ping, neighborMac, quickGet, udpPortState, diagnoseNoAnswer, writeDeviceStatus,
}
