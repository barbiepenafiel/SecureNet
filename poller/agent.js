/**
 * NetWatch Local Agent
 *
 * Runs on a campus machine that has LAN access.
 * Pushes all data to Supabase so the Vercel dashboard can read it.
 *
 * Every 15 s  — network scan (ping sweep + verified ARP) → scan_results,
 *               then automatic discovery: new devices are added to `devices`,
 *               every device's status is updated (Online / Unreachable /
 *               Offline after 3 missed checks / Unknown) and online/offline
 *               alerts are created
 * Every 60 s  — SNMP poll manually added devices → traffic_samples, cpu, mem
 *
 * Usage:
 *   cd poller
 *   node agent.js
 */

const path   = require('path')
const os     = require('os')
const { exec }  = require('child_process')
const { promisify } = require('util')

// Load .env from poller/ first, then fall back to project root
require('dotenv').config({ path: path.join(__dirname, '.env') })
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: false })

const snmp = require('net-snmp')
const { createClient } = require('@supabase/supabase-js')
const mikrotik = require('./mikrotik')   // MikroTik RouterOS SNMP collector
const generic  = require('./snmp-generic') // SNMP poll for every other SNMP device
const jobs     = require('./jobs')       // LAN requests from the (hosted) dashboard
const standby  = require('./standby')    // only one agent monitors at a time

const execAsync = promisify(exec)

// ── Supabase ──────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
)

// 1 s, so slow-but-alive devices are measured as high latency (Warning), not as "no reply"
const PING_MS       = parseInt(process.env.PING_TIMEOUT_MS  ?? '1000',  10)
const POLL_MS       = parseInt(process.env.POLL_INTERVAL_MS ?? '60000', 10)
const SCAN_MS       = parseInt(process.env.SCAN_INTERVAL_MS ?? '15000', 10) // 15 s
const SCAN_BATCH    = parseInt(process.env.SCAN_BATCH       ?? '64',    10)
const MIN_PREFIX    = parseInt(process.env.SCAN_MIN_PREFIX  ?? '22',    10) // cap sweep at 1022 hosts
const isWindows     = process.platform === 'win32'

// ── Helpers ───────────────────────────────────────────────────────────────────
const ipToInt = ip => ip.split('.').reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0)
const intToIp = n => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.')

function pingHost(ip) {
  const cmd = isWindows
    ? `ping -n 1 -w ${PING_MS} ${ip}`
    : `ping -c 1 -W ${Math.ceil(PING_MS / 1000)} ${ip}`
  return execAsync(cmd, { timeout: PING_MS + 1000, windowsHide: true })
    .then(({ stdout }) => {
      // A real echo reply comes FROM the target and carries a TTL. Windows also prints
      // "Reply from <own IP>: Destination host unreachable" for dead hosts — not a reply.
      const fromTarget = new RegExp(`from ${ip.replace(/\./g, '\\.')}(?!\\d)`).test(stdout)
      const responded  = fromTarget && /ttl=/i.test(stdout)
      const m = stdout.match(/time[=<]\s*(\d+(?:\.\d+)?)\s*ms/i)
      return { responded, latency_ms: responded ? (m ? Math.round(parseFloat(m[1])) : 0) : null }
    })
    .catch(() => ({ responded: false, latency_ms: null }))
}

// Neighbor (ARP) entries confirmed during the sweep. Every host in range is pinged first,
// which forces the OS to re-verify each cached entry: dead ones turn Unreachable/Delay/Probe,
// live ones are Reachable (or decay to Stale after confirmation). Old cache junk is excluded.
async function getLiveNeighbors() {
  const map = new Map()
  const add = (ip, mac) => {
    mac = mac.replace(/-/g, ':').toUpperCase()
    if (/^(00:){5}00$|^(FF:){5}FF$|^01:00:5E/.test(mac)) return
    map.set(ip, mac)
  }
  try {
    if (isWindows) {
      const ps = "Get-NetNeighbor -AddressFamily IPv4 | Where-Object { $_.State -in 'Reachable','Stale' } | ForEach-Object { $_.IPAddress + ' ' + $_.LinkLayerAddress }"
      const { stdout } = await execAsync(`powershell -NoProfile -Command "${ps}"`, { timeout: 15000, windowsHide: true })
      for (const line of stdout.split(/\r?\n/)) {
        const [ip, mac] = line.trim().split(/\s+/)
        if (ip && mac && /^(?:[\da-fA-F]{2}-){5}[\da-fA-F]{2}$/.test(mac)) add(ip, mac)
      }
    } else {
      const { stdout } = await execAsync('ip -4 neigh show', { timeout: 5000, windowsHide: true })
      for (const line of stdout.split('\n')) {
        const m = line.match(/^([\d.]+) .*lladdr ((?:[\da-f]{2}:){5}[\da-f]{2}) (REACHABLE|STALE)/i)
        if (m) add(m[1], m[2])
      }
    }
  } catch (e) {
    console.log(`  [scan] neighbor table unavailable: ${e.message}`)
  }
  return map
}

// The network this PC actually uses to reach the internet, with its real prefix length
// (school Wi-Fi is often /22 or larger, not /24).
async function detectNetwork() {
  let selfIp = null
  let gateway = null
  try {
    if (isWindows) {
      const { stdout } = await execAsync('route print -4 0.0.0.0', { timeout: 5000, windowsHide: true })
      const routes = [...stdout.matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+([\d.]+)\s+([\d.]+)\s+(\d+)/gm)]
        .sort((a, b) => Number(a[3]) - Number(b[3]))
      selfIp  = routes[0]?.[2] ?? null
      gateway = routes[0]?.[1] ?? null
    } else {
      const { stdout } = await execAsync('ip -4 route get 1.1.1.1', { timeout: 5000, windowsHide: true })
      selfIp  = stdout.match(/src ([\d.]+)/)?.[1] ?? null
      gateway = stdout.match(/via ([\d.]+)/)?.[1] ?? null
    }
  } catch {}
  if (!selfIp) return null

  let ifaceName = null
  let iface = null
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    const hit = (list ?? []).find(a => a.family === 'IPv4' && a.address === selfIp)
    if (hit) { ifaceName = name; iface = hit; break }
  }
  if (!iface?.cidr) return null

  let prefix = Number(iface.cidr.split('/')[1])
  if (prefix < MIN_PREFIX) {
    console.log(`  [scan] network is /${prefix}; limiting sweep to the /${MIN_PREFIX} around ${selfIp}`)
    prefix = MIN_PREFIX
  }
  const mask      = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
  const network   = (ipToInt(selfIp) & mask) >>> 0
  const broadcast = (network | ~mask) >>> 0
  const hosts = []
  for (let n = network + 1; n < broadcast; n++) hosts.push(intToIp(n))
  const selfMac = iface.mac && iface.mac !== '00:00:00:00:00:00' ? iface.mac.toUpperCase() : null
  return { selfIp, selfMac, gateway, ifaceName, cidr: `${intToIp(network)}/${prefix}`, hosts }
}

// The machine's other networks (e.g. a VirtualBox host-only network), each
// capped at /24, so VMs and wired neighbours get discovered too.
function otherNetworks(net) {
  const out = new Map()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.') || !a.cidr) continue
      if (a.address === net.selfIp) continue
      const prefix = Math.max(24, Number(a.cidr.split('/')[1]))
      const mask = (0xFFFFFFFF << (32 - prefix)) >>> 0
      const network = (ipToInt(a.address) & mask) >>> 0
      const cidr = `${intToIp(network)}/${prefix}`
      if (cidr === net.cidr || out.has(cidr)) continue
      const hosts = []
      for (let n = network + 1; n < ((network | ~mask) >>> 0); n++) {
        const ip = intToIp(n)
        if (ip !== a.address) hosts.push(ip)
      }
      out.set(cidr, { cidr, selfIp: a.address, hosts })
    }
  }
  return [...out.values()]
}

// Every IPv4 network this machine is attached to (for "can the agent see this device?")
function localNetworks() {
  const nets = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.') || !a.cidr) continue
      const prefix = Number(a.cidr.split('/')[1])
      const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
      nets.push({ network: (ipToInt(a.address) & mask) >>> 0, mask })
    }
  }
  return nets
}
const inLocalNetwork = (ip, nets) => nets.some(n => ((ipToInt(ip) & n.mask) >>> 0) === n.network)

// ── SNMP ──────────────────────────────────────────────────────────────────────
const OID = {
  sysDescr:    '1.3.6.1.2.1.1.1.0',
  sysName:     '1.3.6.1.2.1.1.5.0',
  sysUpTime:   '1.3.6.1.2.1.1.3.0',
  cpuIdle:     '1.3.6.1.4.1.2021.11.11.0',
  memTotal:    '1.3.6.1.4.1.2021.4.5.0',
  memFree:     '1.3.6.1.4.1.2021.4.6.0',
  ifInOctets:  (i) => `1.3.6.1.2.1.2.2.1.10.${i}`,
  ifOutOctets: (i) => `1.3.6.1.2.1.2.2.1.16.${i}`,
  ifDescr:     (i) => `1.3.6.1.2.1.2.2.1.2.${i}`,
}

function snmpGet(ip, community, port, oids) {
  return new Promise(resolve => {
    const session = snmp.createSession(ip, community, {
      port, retries: 1, timeout: 3000, version: snmp.Version2c,
    })
    session.get(oids, (err, vb) => {
      session.close()
      resolve(err ? [] : (vb ?? []))
    })
  })
}

const prevCounters = new Map()

async function pollSnmpDevice(dev) {
  const community = dev.snmp_community ?? 'public'
  const port      = dev.snmp_port      ?? 161
  const vb = await snmpGet(dev.ip, community, port, [
    OID.sysDescr, OID.sysName, OID.sysUpTime, OID.cpuIdle, OID.memTotal, OID.memFree,
    OID.ifInOctets(1), OID.ifOutOctets(1), OID.ifDescr(1),
  ])
  if (!vb.length) return null

  const uptimeTicks = Number(vb[2]?.value ?? 0)
  const totalSecs   = Math.floor(uptimeTicks / 100)
  const days  = Math.floor(totalSecs / 86400)
  const hrs   = Math.floor((totalSecs % 86400) / 3600)
  const mins  = Math.floor((totalSecs % 3600) / 60)
  const uptime = days > 0 ? `${days}d ${hrs}h ${mins}m` : `${hrs}h ${mins}m`

  const cpuIdle  = Number(vb[3]?.value ?? 100)
  const cpu      = Math.max(0, Math.min(100, 100 - cpuIdle))
  const memTotal = Number(vb[4]?.value ?? 1)
  const memFree  = Number(vb[5]?.value ?? 1)
  const mem      = memTotal > 0 ? Math.round(((memTotal - memFree) / memTotal) * 100) : 0

  const inOctets  = Number(vb[6]?.value ?? 0)
  const outOctets = Number(vb[7]?.value ?? 0)
  const ifName    = vb[8]?.value?.toString() ?? 'eth0'
  const now       = Date.now()
  const key       = `${dev.ip}:${ifName}`
  const prev      = prevCounters.get(key)
  let inMbps = 0, outMbps = 0
  if (prev && prev.ts < now) {
    const elapsed = (now - prev.ts) / 1000
    const dIn  = inOctets  >= prev.in  ? inOctets  - prev.in  : 0xFFFFFFFF - prev.in  + inOctets
    const dOut = outOctets >= prev.out ? outOctets - prev.out : 0xFFFFFFFF - prev.out + outOctets
    inMbps  = parseFloat(((dIn  * 8) / elapsed / 1_000_000).toFixed(4))
    outMbps = parseFloat(((dOut * 8) / elapsed / 1_000_000).toFixed(4))
  }
  prevCounters.set(key, { in: inOctets, out: outOctets, ts: now })

  return { uptime, cpu, mem, inMbps, outMbps, ifName }
}

// ── Device naming helpers ─────────────────────────────────────────────────────
const dns = require('dns').promises
const fs  = require('fs')

// MAC prefix → vendor/type, read from the dashboard's lib/oui.ts so there's one list
const OUI = new Map()
try {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'oui.ts'), 'utf8')
  for (const m of src.matchAll(/'([0-9A-F]{6})':\s*\{\s*vendor:\s*'([^']+)',\s*device_type:\s*'([^']+)'/g)) {
    OUI.set(m[1], { vendor: m[2], type: m[3] })
  }
} catch { /* vendor lookup unavailable */ }

// Phones and laptops use a random "locally administered" MAC per Wi-Fi network
const isRandomMac = mac => /^.[26AE]/i.test(mac ?? '')

// Virtual machine network cards
const VM_OUI = {
  '080027': 'VirtualBox VM', '000C29': 'VMware VM', '005056': 'VMware VM',
  '00155D': 'Hyper-V VM', '525400': 'QEMU/KVM VM',
}

function guessDevice(ip, mac, net) {
  if (net && ip === net.selfIp) return { vendor: null, type: 'Computer' }
  const prefix = mac ? mac.replace(/[^0-9A-F]/gi, '').toUpperCase().slice(0, 6) : ''
  if (VM_OUI[prefix]) return { vendor: VM_OUI[prefix], type: 'Server' }
  const hit = mac ? OUI.get(prefix) : null
  if (net && ip === net.gateway) return { vendor: hit?.vendor ?? null, type: 'Router' }
  if (hit) return { vendor: hit.vendor, type: hit.type === 'Unknown' ? 'Client' : hit.type }
  if (isRandomMac(mac)) return { vendor: 'Private MAC (phone/laptop)', type: 'Client' }
  return { vendor: null, type: 'Client' }
}

async function reverseName(ip) {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
    ])
    const n = names?.[0]
    return n && !/^\d+\.\d+\.\d+\.\d+/.test(n) ? n.replace(/\.$/, '') : null
  } catch { return null }
}

// ── Alerts (same format as the dashboard's lib/alert-monitor.ts) ─────────────
const FAILS_BEFORE_OFFLINE = 3
const SYSTEM_USER = 'System (agent)'

// The alert history is each device's last announced state (offline/online),
// so restarts never repeat an alert. Cached per IP after the first lookup.
const announced = new Map()   // ip → 'online' | 'offline' | null
async function lastAnnounced(ip) {
  if (announced.has(ip)) return announced.get(ip)
  const state = await queryAnnounced(ip)
  announced.set(ip, state)
  return state
}
// Re-read from the database (and refresh the cache) right before alerting
async function freshAnnounced(ip) {
  const state = await queryAnnounced(ip)
  announced.set(ip, state)
  return state
}
async function queryAnnounced(ip) {
  const latest = async severity => {
    const { data } = await supabase.from('alerts').select('created_at')
      .ilike('meta', `%IP: ${ip} %`).eq('severity', severity)
      .order('created_at', { ascending: false }).limit(1)
    return data?.[0]?.created_at
  }
  const [off, on] = await Promise.all([latest('crit'), latest('info')])
  if (!off && !on) return null
  return off && (!on || off > on) ? 'offline' : 'online'
}

async function insertAlert(dev, kind, method) {
  const online = kind !== 'offline'
  const discovered = dev.source === 'discovered'
  const meta = `${discovered ? '[Discovered] ' : ''}IP: ${dev.ip} · MAC: ${dev.mac ?? '—'} · Location: ${dev.location || 'Unassigned'} · Method: ${method} · Status: ${online ? 'Online' : 'Offline'}`
  const base = {
    severity:   online ? 'info' : 'crit',
    title:      kind === 'new' ? `${dev.name} connected (new device)` : online ? `${dev.name} is back online` : `${dev.name} is offline`,
    meta,
    acked:      online,
    suppressed: false,
    root_cause: kind === 'new'
      ? `First seen on ${dev.subnet ?? 'the network'} via ${method}`
      : online
        ? `Device answered via ${method}`
        : `No ICMP or ARP response from ${dev.ip} for ${FAILS_BEFORE_OFFLINE} consecutive checks — check cable, power or Wi-Fi`,
  }
  const full = {
    ...base, device_name: dev.name, device_ip: dev.ip, device_mac: dev.mac ?? null,
    location: dev.location || 'Unassigned', detection_method: method, status: online ? 'online' : 'offline',
  }
  const { error } = await supabase.from('alerts').insert(full)
  if (error && /column|schema cache/i.test(error.message)) await supabase.from('alerts').insert(base)
  announced.set(dev.ip, online ? 'online' : 'offline')
  if (online) {
    // Close the open offline alert for this IP
    await supabase.from('alerts')
      .update({ acked: true, resolved_at: new Date().toISOString(), resolved_by: SYSTEM_USER, resolution_notes: 'Device is back online' })
      .ilike('meta', `%IP: ${dev.ip} %`).eq('severity', 'crit').is('resolved_at', null)
  }
}

// ── Job 1: Discovery + online/offline status ──────────────────────────────────
//
// Evidence a device is online, strongest first:
//   ICMP reply · ARP (the device answered address resolution) · SNMP reply
// A device whose MAC we know is matched by MAC wherever it shows up, so an
// IP change updates the record instead of creating a duplicate, and a ping
// reply from a *different* device that took over its old IP isn't counted.
//
// Statuses:  up (Online) · unreachable (missed 1–2 checks) · down (Offline,
// 3 checks in a row with no evidence) · unknown (the agent isn't on that
// device's network, so it can't tell).

const deviceFails = new Map()   // device id → consecutive checks without evidence
const lastSeenWrite = new Map() // device id → ms of last last_seen write (throttle)
const dnsTried = new Map()      // device id → ms of last reverse-DNS attempt
// Registration needs supabase/migration_auto_discovery.sql. If it's missing we
// pause registration and try again every minute (so running the migration
// later takes effect without restarting the agent).
let discoveryColumns = true
let discoveryRetryAt = 0

async function loadDevices() {
  const { data, error } = await supabase.from('devices').select('*')
  if (error) { console.log(`  [devices] read failed: ${error.message}`); return null }
  return data ?? []
}

async function updateDevice(id, patch) {
  const { error } = await supabase.from('devices').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)
  if (error && /column|schema cache|check constraint/i.test(error.message)) {
    // Migration not run yet: keep only the original columns and statuses
    const { status, ip } = patch
    const basic = {}
    if (status !== undefined && ['up', 'warn', 'down', 'maint'].includes(status)) basic.status = status
    if (ip !== undefined) basic.ip = ip
    if (Object.keys(basic).length) await supabase.from('devices').update(basic).eq('id', id)
  } else if (error) {
    console.log(`  [devices] update failed: ${error.message}`)
  }
}

async function registerDevice(host, net) {
  const guess = guessDevice(host.ip, host.mac, net)
  const hostname = host.ip === net.selfIp ? os.hostname() : await reverseName(host.ip)
  const tail = host.mac ? host.mac.slice(-5).replace(':', '') : host.ip.split('.').pop()
  let name = hostname
    || (host.ip === net.gateway ? `Gateway ${host.ip}` : null)
    || (guess.vendor && !guess.vendor.startsWith('Private') ? `${guess.vendor} ${tail}` : null)
    || `Device ${host.ip}`
  if (host.ip === net.selfIp) name = `${os.hostname()} (agent)`

  const now = new Date().toISOString()
  const row = {
    name, type: guess.type, ip: host.ip, location: 'Unassigned', status: 'up',
    uptime: '—', cpu: 0, mem: 0,
    mac: host.mac, hostname, vendor: guess.vendor, source: 'discovered',
    subnet: host.cidr ?? net.cidr, first_seen: now, last_seen: now, last_method: host.method,
  }
  let { data, error } = await supabase.from('devices').insert(row).select('*').single()
  if (error?.code === '23505' && /name/i.test(error.message)) {
    // Name already used by another record — make it unique
    row.name = `${name} (${host.ip})`
    ;({ data, error } = await supabase.from('devices').insert(row).select('*').single())
  }
  if (error) {
    if (/column|schema cache|check constraint/i.test(error.message)) {
      if (discoveryColumns) console.log('  [discovery] run supabase/migration_auto_discovery.sql to enable automatic registration (retrying every minute)')
      discoveryColumns = false
      discoveryRetryAt = Date.now() + 60_000
    } else if (error.code !== '23505') {
      console.log(`  [discovery] could not add ${host.ip}: ${error.message}`)
    }
    return null
  }
  console.log(`  [discovery] new device: ${data.name} ${data.ip} ${data.mac ?? ''}`)
  await insertAlert(data, 'new', host.method)
  return data
}

// ── Warning: high latency ─────────────────────────────────────────────────────
//
// Thresholds come from Settings → Latency Warning / Latency Critical (the
// alert_config table); 100 / 250 ms until that's set up. A device is Warning
// when the AVERAGE of its last 3 ping times reaches the warning threshold, so
// one slow reply (common on Wi-Fi phones) doesn't trigger it. It goes back to
// Online once the average drops below 80 % of the threshold, so it doesn't
// flip back and forth around the limit.
const LATENCY_SAMPLES = 3
const LATENCY_CLEAR_RATIO = 0.8
const latencyLimits = { warnMs: 100, critMs: 250, loadedAt: 0 }
const latencySamples = new Map()   // device id → last ping times (ms)
const latencyWarned = new Set()    // device ids with an open latency warning

async function loadLatencyLimits() {
  if (Date.now() - latencyLimits.loadedAt < 60_000) return
  latencyLimits.loadedAt = Date.now()
  const { data } = await supabase.from('alert_config').select('latency_warn_ms, latency_crit_ms').limit(1).maybeSingle()
  if (data?.latency_warn_ms > 0) latencyLimits.warnMs = data.latency_warn_ms
  if (data?.latency_crit_ms > 0) latencyLimits.critMs = data.latency_crit_ms
}

// → { state: 'up' | 'warn', avg } or null when there's no ping time this round
function latencyState(id, latency, wasWarn) {
  if (latency == null) return null
  const samples = [...(latencySamples.get(id) ?? []), latency].slice(-LATENCY_SAMPLES)
  latencySamples.set(id, samples)
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
  if (samples.length < 2) return { state: wasWarn ? 'warn' : 'up', avg }   // wait for a 2nd sample
  if (avg >= latencyLimits.warnMs) return { state: 'warn', avg }
  if (wasWarn && avg >= latencyLimits.warnMs * LATENCY_CLEAR_RATIO) return { state: 'warn', avg }
  return { state: 'up', avg }
}

// ── Latency history (dashboard chart) ─────────────────────────────────────────
// Each round's ping time and status are collected per device; once a minute
// one averaged row per device goes to latency_samples (7 days are kept).
const minuteSamples = new Map()   // device id → { name, ip, status, lat: [] }
let samplesFlushedAt = Date.now()
let samplesPrunedAt = 0
let samplesTableOk = true
let samplesRetryAt = 0

function recordSample(d, ip, status, latency) {
  const s = minuteSamples.get(d.id) ?? { name: d.name, ip, status, lat: [] }
  s.name = d.name; s.ip = ip; s.status = status            // latest status in the minute
  if (latency != null) s.lat.push(latency)
  minuteSamples.set(d.id, s)
}

async function flushSamples() {
  if (Date.now() - samplesFlushedAt < 60_000 || !minuteSamples.size) return
  if (!samplesTableOk && Date.now() < samplesRetryAt) { minuteSamples.clear(); samplesFlushedAt = Date.now(); return }
  const sampled_at = new Date().toISOString()
  const rows = [...minuteSamples].map(([id, s]) => ({
    device_id: id, device_name: s.name, ip: s.ip, status: s.status, sampled_at,
    latency_ms: s.lat.length ? Math.round(s.lat.reduce((a, b) => a + b, 0) / s.lat.length) : null,
  }))
  minuteSamples.clear()
  samplesFlushedAt = Date.now()
  const { error } = await supabase.from('latency_samples').insert(rows)
  if (error) {
    if (samplesTableOk) console.log(`  [latency] not saved (${error.message}) — run supabase/migration_latency_history.sql; retrying every 5 min`)
    samplesTableOk = false
    samplesRetryAt = Date.now() + 5 * 60_000
    return
  }
  samplesTableOk = true
  // Keep 7 days
  if (Date.now() - samplesPrunedAt > 60 * 60_000) {
    samplesPrunedAt = Date.now()
    await supabase.from('latency_samples').delete()
      .lt('sampled_at', new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString()).then(() => {}, () => {})
  }
}

function openWarningQuery(ip) {
  return supabase.from('alerts').select('id')
    .ilike('meta', `%IP: ${ip} %`).eq('severity', 'warn').is('resolved_at', null).eq('suppressed', false)
}

// One open warning per device (checked in the database, so restarts don't repeat it)
async function raiseLatencyWarning(dev, avg) {
  if (latencyWarned.has(dev.id)) return
  const { data: open } = await openWarningQuery(dev.ip).limit(1)
  latencyWarned.add(dev.id)
  if (open?.length) return

  const critical = avg >= latencyLimits.critMs
  const meta = `${dev.source === 'discovered' ? '[Discovered] ' : ''}IP: ${dev.ip} · MAC: ${dev.mac ?? '—'} · Location: ${dev.location || 'Unassigned'} · Method: ICMP · Status: Warning`
  const base = {
    severity:   'warn',
    title:      `${dev.name} ${critical ? 'very high' : 'high'} latency`,
    meta,
    acked:      false,
    suppressed: false,
    root_cause: `Average ping ${avg} ms over the last ${LATENCY_SAMPLES} checks — `
      + (critical
        ? `above the critical limit of ${latencyLimits.critMs} ms`
        : `above the warning limit of ${latencyLimits.warnMs} ms`)
      + '. Check for congestion, weak Wi-Fi signal or an overloaded device.',
  }
  const full = { ...base, device_name: dev.name, device_ip: dev.ip, device_mac: dev.mac ?? null,
    location: dev.location || 'Unassigned', detection_method: 'ICMP' }
  const { error } = await supabase.from('alerts').insert(full)
  if (error && /column|schema cache/i.test(error.message)) await supabase.from('alerts').insert(base)
  console.log(`  [warning] ${dev.name} ${dev.ip} latency ${avg} ms (limit ${latencyLimits.warnMs} ms)`)
}

async function clearLatencyWarning(dev, note) {
  latencyWarned.delete(dev.id)
  await supabase.from('alerts')
    .update({ acked: true, resolved_at: new Date().toISOString(), resolved_by: SYSTEM_USER, resolution_notes: note })
    .ilike('meta', `%IP: ${dev.ip} %`).eq('severity', 'warn').is('resolved_at', null)
    .then(() => {}, () => {})
}

async function reconcileDevices(net, icmpMap, neighbors, extraLive = []) {
  const devices = await loadDevices()
  if (!devices) return

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const nets = localNetworks()

  // MAC → IP from the neighbour table (plus this machine's own address)
  const macToIp = new Map()
  for (const [ip, mac] of neighbors) macToIp.set(mac, ip)
  if (net.selfMac) { macToIp.set(net.selfMac, net.selfIp); neighbors.set(net.selfIp, net.selfMac) }

  // Live hosts in the swept network
  const live = []
  for (const ip of net.hosts) {
    const icmp = icmpMap.get(ip)?.responded
    const mac = neighbors.get(ip) ?? null
    if (icmp || mac || ip === net.selfIp) live.push({ ip, mac, method: icmp ? 'ICMP' : ip === net.selfIp ? 'Local' : 'ARP', cidr: net.cidr })
  }
  // Hosts answering on the machine's other networks (VMs etc.)
  for (const h of extraLive) live.push({ ip: h.ip, mac: neighbors.get(h.ip) ?? null, method: 'ICMP', cidr: h.cidr })

  // ── Register hosts that don't match any record ─────────────────────────────
  if (!discoveryColumns && Date.now() >= discoveryRetryAt) discoveryColumns = true   // try again
  if (discoveryColumns) {
    const byMac = new Map(devices.filter(d => d.mac).map(d => [d.mac.toUpperCase(), d]))
    for (const h of live) {
      if (h.mac && byMac.has(h.mac)) continue
      const sameIp = devices.find(d => d.ip === h.ip)
      if (sameIp && (!sameIp.mac || !h.mac)) {
        // Known by IP only — learn its MAC now
        if (h.mac && !sameIp.mac) { await updateDevice(sameIp.id, { mac: h.mac }); sameIp.mac = h.mac; byMac.set(h.mac, sameIp) }
        continue
      }
      const created = await registerDevice(h, net)
      if (created) { devices.push(created); deviceFails.set(created.id, 0); if (created.mac) byMac.set(created.mac, created) }
    }
  }

  // ── Check every known device ────────────────────────────────────────────────
  await loadLatencyLimits()
  const counts = { up: 0, warn: 0, unreachable: 0, down: 0, unknown: 0 }
  const results = await Promise.all(devices.map(async d => {
    if (d.status === 'maint') return null
    const mac = d.mac?.toUpperCase() ?? null
    let ip = d.ip
    let method = null
    let latency = null                               // ICMP round-trip time (ms), when it answered ping

    if (mac && macToIp.has(mac)) {
      ip = macToIp.get(mac)                          // found by MAC (IP may have changed)
      method = icmpMap.get(ip)?.responded ? 'ICMP' : ip === net.selfIp ? 'Local' : 'ARP'
      if (icmpMap.get(ip)?.responded) latency = icmpMap.get(ip).latency_ms
    } else {
      const arpMac = neighbors.get(d.ip)
      const otherDevice = mac && arpMac && arpMac !== mac   // someone else now has this IP
      if (!otherDevice) {
        let ping = icmpMap.get(d.ip)
        if (ping === undefined) ping = await pingHost(d.ip)   // outside the swept network
        const replied = ping.responded
        if (replied) { method = 'ICMP'; latency = ping.latency_ms }
        else if (arpMac) method = 'ARP'
        else if (d.source !== 'discovered' && d.snmp_community) {
          const vb = await snmpGet(d.ip, d.snmp_community, d.snmp_port ?? 161, [OID.sysUpTime])
          if (vb.length) method = 'SNMP'
        }
      }
    }
    return { d, ip, method, latency }
  }))

  for (const r of results) {
    if (!r) continue
    const { d, ip, method, latency } = r

    if (method) {
      deviceFails.set(d.id, 0)
      const patch = {}
      // Online vs Warning is decided by measured latency (ICMP). With no
      // ping time this round (ARP/SNMP only) the current state is kept.
      const lat = latencyState(d.id, latency, d.status === 'warn')
      const target = lat ? lat.state : (d.status === 'warn' ? 'warn' : 'up')
      if (target === 'warn') counts.warn++; else counts.up++
      if (d.status !== target) patch.status = target
      recordSample(d, ip, target, latency)
      if (ip !== d.ip) { patch.ip = ip; console.log(`  [discovery] ${d.name} moved ${d.ip} → ${ip}`) }
      if (d.last_method !== method) patch.last_method = method
      if (!d.first_seen) patch.first_seen = nowIso
      if (nowMs - (lastSeenWrite.get(d.id) ?? 0) > 60_000 || Object.keys(patch).length) {
        patch.last_seen = nowIso
        lastSeenWrite.set(d.id, nowMs)
      }
      // Try to learn a name for unnamed discovered devices every 10 min
      if (d.source === 'discovered' && !d.hostname && nowMs - (dnsTried.get(d.id) ?? 0) > 600_000) {
        dnsTried.set(d.id, nowMs)
        const hn = await reverseName(ip)
        if (hn) { patch.hostname = hn; if (/^(Device |Gateway )/.test(d.name)) patch.name = hn }
      }
      if (Object.keys(patch).length) await updateDevice(d.id, patch)
      // Warning alert when latency gets high; resolved when it recovers
      if (target === 'warn' && lat) await raiseLatencyWarning({ ...d, ip }, lat.avg)
      else if (target === 'up' && (d.status === 'warn' || latencyWarned.has(d.id))) {
        await clearLatencyWarning({ ...d, ip }, lat ? `Latency back to normal (${lat.avg} ms average)` : 'Latency back to normal')
      }
      if (d.status === 'down') {
        await supabase.from('status_events').insert({ device_id: d.id, device_name: d.name, device_ip: ip, old_status: 'down', new_status: 'up' }).then(() => {}, () => {})
      }
      if (await lastAnnounced(ip) === 'offline' || (ip !== d.ip && await lastAnnounced(d.ip) === 'offline')) {
        // Confirm against the database right before alerting (another monitor may have just done it)
        if (await freshAnnounced(ip) === 'offline' || (ip !== d.ip && await freshAnnounced(d.ip) === 'offline')) {
          await insertAlert({ ...d, ip }, 'online', method)
        }
      }
      continue
    }

    // No evidence this round
    const reachable = inLocalNetwork(d.ip, nets)
    if (d.source === 'discovered' && !reachable) {
      // The agent isn't on this device's network — can't tell
      deviceFails.set(d.id, 0)
      counts.unknown++
      recordSample(d, d.ip, 'unknown', null)
      if (d.status !== 'unknown') await updateDevice(d.id, { status: 'unknown' })
      continue
    }

    const fails = (deviceFails.get(d.id) ?? 0) + 1
    deviceFails.set(d.id, fails)
    if (fails < FAILS_BEFORE_OFFLINE) {
      counts.unreachable++
      recordSample(d, d.ip, d.status === 'down' ? 'down' : 'unreachable', null)
      if (d.status === 'up' || d.status === 'unknown') await updateDevice(d.id, { status: 'unreachable' })
      continue
    }

    counts.down++
    recordSample(d, d.ip, 'down', null)
    // An offline device has no latency — close any open latency warning
    latencySamples.delete(d.id)
    if (d.status === 'warn' || latencyWarned.has(d.id)) await clearLatencyWarning(d, 'Device went offline')
    if (d.status !== 'down') {
      await updateDevice(d.id, { status: 'down' })
      await supabase.from('status_events').insert({ device_id: d.id, device_name: d.name, device_ip: d.ip, old_status: d.status, new_status: 'down' }).then(() => {}, () => {})
    }
    if (await lastAnnounced(d.ip) !== 'offline' && await freshAnnounced(d.ip) !== 'offline') {
      console.log(`  [status] ${d.name} ${d.ip} is offline`)
      await insertAlert(d, 'offline', `No response (ICMP ×${FAILS_BEFORE_OFFLINE}, ARP${d.snmp_community && d.source !== 'discovered' ? ', SNMP' : ''})`)
    }
  }

  console.log(`  [status] ${counts.up} online, ${counts.warn} warning (latency ≥ ${latencyLimits.warnMs} ms), ${counts.unreachable} unreachable, ${counts.down} offline, ${counts.unknown} unknown`)
  await flushSamples()
}

async function heartbeat(net, hostsSeen) {
  const row = {
    id: os.hostname(), ip: net?.selfIp ?? null, subnet: net?.cidr ?? null,
    interface: net?.ifaceName ?? null, hosts_seen: hostsSeen, last_seen: new Date().toISOString(),
  }
  try {
    const { error } = await supabase.from('agent_status').upsert({ ...row, priority: standby.PRIORITY })
    // priority column not installed yet (supabase/migration_agent_jobs.sql)
    if (error && /column|schema cache/i.test(error.message)) await supabase.from('agent_status').upsert(row)
  } catch { /* heartbeat is best-effort */ }
}

// ── Job 2: SNMP poll (cpu, mem, traffic) ──────────────────────────────────────
// Which devices to ask, so the agent doesn't send SNMP to every phone each minute:
//   • devices someone added by hand, and devices that have answered SNMP before — every minute
//   • other discovered devices — once every 10 minutes, in case SNMP was enabled on them
// The dashboard's /api/snmp did this while it ran on the LAN; a hosted
// dashboard can't, so the agent does it (snmp-generic.js).
const SNMP_RETRY_MS = 10 * 60_000
const snmpAnswered  = new Set()   // device ids that answered SNMP since the agent started
const snmpTriedAt   = new Map()   // device id → ms of the last attempt that got no answer

async function pollSnmp() {
  const { data: all, error } = await supabase.from('devices').select('*')
  if (error || !all?.length) return

  // MikroTik routers are polled by mikrotik.js with RouterOS-specific OIDs
  const mikrotikIds = await mikrotik.managedIds(supabase)
  const now = Date.now()
  const devices = all.filter(d => {
    if (!d.snmp_community || mikrotikIds.has(d.id)) return false
    if (d.status !== 'up' && d.status !== 'warn') return false
    const known = snmpAnswered.has(d.id) || d.cpu > 0 || d.mem > 0 || (d.uptime && d.uptime !== '—')
    if (known || (d.source && d.source !== 'discovered')) return true
    return now - (snmpTriedAt.get(d.id) ?? 0) >= SNMP_RETRY_MS
  })
  if (!devices.length) return

  const ts = new Date().toISOString()
  let polled = 0

  const pollOne = async dev => {
    const result = await generic.pollGenericDevice(dev)
    if (!result) { snmpTriedAt.set(dev.id, Date.now()); return }
    snmpAnswered.add(dev.id)
    polled++

    const update = { updated_at: ts }
    if (result.uptime)  update.uptime = result.uptime
    if (result.cpu > 0) update.cpu    = result.cpu
    if (result.mem > 0) update.mem    = result.mem
    const extra = {}
    if (result.model)    extra.model    = result.model
    if (result.firmware) extra.firmware = result.firmware
    const { error: e } = await supabase.from('devices').update({ ...update, ...extra }).eq('id', dev.id)
    // model/firmware columns not installed (supabase/migration_devices_model_fw.sql)
    if (e && /column|schema cache/i.test(e.message)) await supabase.from('devices').update(update).eq('id', dev.id)

    if (result.interfaces.length) {
      await supabase.from('traffic_samples').insert(result.interfaces.map(i => ({
        device_name: dev.name,
        interface:   i.ifName,
        in_mbps:     i.inMbps,
        out_mbps:    i.outMbps,
        sampled_at:  ts,
      })))
    }
  }
  // A few at a time: devices that don't answer take seconds to time out
  for (let i = 0; i < devices.length; i += 8) {
    await Promise.all(devices.slice(i, i + 8).map(d => pollOne(d).catch(e => console.log(`  [snmp] ${d.ip}: ${e.message}`))))
  }
  console.log(`  [snmp] polled ${polled}/${devices.length} devices`)
}

// ── Job 3: Network scan → scan_results, then discovery/status ────────────────
async function scanNetwork() {
  const net = await detectNetwork()
  if (!net) {
    console.log('  [scan] no active network detected')
    await heartbeat(null, 0)
    return
  }
  const started = Date.now()
  console.log(`  [scan] sweeping ${net.cidr} (${net.hosts.length} hosts) from ${net.selfIp} on ${net.ifaceName} …`)

  const icmpMap = new Map()
  for (let i = 0; i < net.hosts.length; i += SCAN_BATCH) {
    const batch = net.hosts.slice(i, i + SCAN_BATCH)
    const res = await Promise.all(batch.map(async ip => ({ ip, ...(await pingHost(ip)) })))
    for (const r of res) icmpMap.set(r.ip, r)
  }

  // Every ~60 s also sweep the machine's other networks (VirtualBox host-only
  // etc.) so new VMs are discovered; known devices there are checked every round.
  const extraLive = []
  if (scanRound++ % EXTRA_SCAN_EVERY === 0) {
    for (const other of otherNetworks(net)) {
      const res = []
      for (let i = 0; i < other.hosts.length; i += SCAN_BATCH) {
        const batch = other.hosts.slice(i, i + SCAN_BATCH)
        res.push(...await Promise.all(batch.map(async ip => ({ ip, ...(await pingHost(ip)) }))))
      }
      for (const r of res) { icmpMap.set(r.ip, r); if (r.responded) extraLive.push({ ip: r.ip, cidr: other.cidr }) }
    }
  }

  // Read neighbors AFTER the sweep so every entry has just been re-verified.
  const neighbors = await getLiveNeighbors()

  const scanned_at = new Date().toISOString()
  const rows = []
  for (const ip of net.hosts) {
    const icmp = icmpMap.get(ip)
    const mac  = neighbors.get(ip) ?? null
    // Alive = answered the ping, or answered ARP (phones/PCs often block ping but must answer ARP).
    if (!icmp?.responded && !mac) continue
    const guess = guessDevice(ip, mac, net)
    rows.push({
      ip,
      mac,
      hostname:    ip === net.selfIp ? `${os.hostname()} (this agent)` : null,
      vendor:      guess.vendor,
      device_type: guess.type,
      scan_type:   icmp?.responded && mac ? 'both' : mac ? 'arp' : 'icmp',
      responded:   !!icmp?.responded,
      latency_ms:  icmp?.latency_ms ?? null,
      scanned_at,
    })
  }

  await supabase.from('scan_results').delete().neq('ip', '')
  if (rows.length) {
    const { error } = await supabase.from('scan_results').insert(rows)
    if (error) console.log(`  [scan] write failed: ${error.message}`)
  }

  const icmpCount = rows.filter(r => r.responded).length
  console.log(`  [scan] ${rows.length} live hosts (ICMP ${icmpCount}, ARP-only ${rows.length - icmpCount}) in ${((Date.now() - started) / 1000).toFixed(1)}s`)

  await heartbeat(net, rows.length)
  await reconcileDevices(net, icmpMap, neighbors, extraLive)
}

const EXTRA_SCAN_EVERY = 4   // other networks: every 4th round (~60 s)
let scanRound = 0

// ── Main loop ─────────────────────────────────────────────────────────────────
async function runPoll() {
  if (standby.isStandby()) return   // another agent is monitoring
  console.log(`\n[${new Date().toISOString()}] Running SNMP poll`)
  try { await pollSnmp() } catch (e) { console.log(`  [snmp] failed: ${e.message}`) }
}

// A check starts every SCAN_MS (15 s). If a sweep takes longer, the next one
// starts right after it — sweeps never overlap.
async function runScanLoop() {
  const started = Date.now()
  // Stand by (no scanning, alerts or heartbeat) while a higher-priority agent is reporting
  let idle = false
  try { idle = await standby.refresh(supabase) } catch { /* stay active */ }
  if (!idle) {
    console.log(`\n[${new Date(started).toISOString()}] Running network scan`)
    try { await scanNetwork() } catch (e) { console.log(`  [scan] failed: ${e.message}`) }
  }
  setTimeout(runScanLoop, Math.max(0, SCAN_MS - (Date.now() - started)))
}

console.log('NetWatch Local Agent')
console.log(`  Platform  : ${process.platform}`)
console.log(`  Discovery : every ${SCAN_MS / 1000}s (ICMP sweep + ARP), offline after ${FAILS_BEFORE_OFFLINE} missed checks`)
console.log(`  SNMP      : every ${POLL_MS / 1000}s`)
console.log(`  MikroTik  : every ${mikrotik.POLL_MS / 1000}s (RouterOS SNMP: system, CPU, memory, interfaces, traffic)`)
console.log(`  Requests  : every ${jobs.POLL_MS / 1000}s (Add Device / Config Backup from the dashboard)`)
console.log(`  Agent     : ${standby.AGENT_ID} · priority ${standby.PRIORITY}`)
console.log(`  Vendors   : ${OUI.size} MAC prefixes loaded`)
console.log('  Press Ctrl+C to stop.\n')

// Run immediately, then on schedule
runScanLoop()
runPoll()
setInterval(runPoll, POLL_MS)
mikrotik.start(supabase, () => !standby.isStandby())
jobs.start(supabase, () => !standby.isStandby())

// A stray network error must never stop monitoring — log it and carry on.
// (pm2 restarts the agent if it does exit.)
process.on('unhandledRejection', e => console.log(`  [agent] unhandled error: ${e?.message ?? e}`))
// Stop cleanly when the service is stopped
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.log(`\n${sig} received — agent stopping`); process.exit(0) })
