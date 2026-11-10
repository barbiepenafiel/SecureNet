/**
 * NetWatch Local Agent
 *
 * Runs on a campus machine that has LAN access.
 * Pushes all data to Supabase so the Vercel dashboard can read it.
 *
 * Every 60 s  — ping every device in the `devices` table → update status
 * Every 60 s  — SNMP poll SNMP-enabled devices → traffic_samples, cpu, mem
 * Every 15 s  — network scan (ping sweep + verified ARP) → scan_results
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

const execAsync = promisify(exec)

// ── Supabase ──────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
)

const PING_MS       = parseInt(process.env.PING_TIMEOUT_MS  ?? '500',   10)
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
  return execAsync(cmd, { timeout: PING_MS + 1000 })
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
      const { stdout } = await execAsync(`powershell -NoProfile -Command "${ps}"`, { timeout: 15000 })
      for (const line of stdout.split(/\r?\n/)) {
        const [ip, mac] = line.trim().split(/\s+/)
        if (ip && mac && /^(?:[\da-fA-F]{2}-){5}[\da-fA-F]{2}$/.test(mac)) add(ip, mac)
      }
    } else {
      const { stdout } = await execAsync('ip -4 neigh show', { timeout: 5000 })
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
  try {
    if (isWindows) {
      const { stdout } = await execAsync('route print -4 0.0.0.0', { timeout: 5000 })
      const routes = [...stdout.matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+([\d.]+)\s+([\d.]+)\s+(\d+)/gm)]
        .sort((a, b) => Number(a[3]) - Number(b[3]))
      selfIp = routes[0]?.[2] ?? null
    } else {
      const { stdout } = await execAsync('ip -4 route get 1.1.1.1', { timeout: 5000 })
      selfIp = stdout.match(/src ([\d.]+)/)?.[1] ?? null
    }
  } catch {}
  if (!selfIp) return null

  const iface = Object.values(os.networkInterfaces()).flat()
    .find(a => a && a.family === 'IPv4' && a.address === selfIp)
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
  return { selfIp, cidr: `${intToIp(network)}/${prefix}`, hosts }
}

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

// ── Job 1: Monitor devices (ping → status) ────────────────────────────────────
async function monitorDevices() {
  const { data: devices, error } = await supabase
    .from('devices')
    .select('id, name, ip, status')
    .neq('status', 'maint')
  if (error || !devices?.length) return

  const results = await Promise.all(devices.map(async dev => {
    const { responded, latency_ms } = await pingHost(dev.ip)
    return { id: dev.id, name: dev.name, responded, latency_ms }
  }))

  const ts = new Date().toISOString()
  for (const r of results) {
    const newStatus = r.responded ? 'up' : 'down'
    await supabase.from('devices')
      .update({ status: newStatus, updated_at: ts })
      .eq('id', r.id)
  }

  const up   = results.filter(r => r.responded).length
  const down = results.filter(r => !r.responded).length
  console.log(`  [monitor] ${up} up, ${down} down`)
}

// ── Job 2: SNMP poll (cpu, mem, traffic) ──────────────────────────────────────
async function pollSnmp() {
  const { data: devices, error } = await supabase
    .from('devices')
    .select('id, name, ip, snmp_community, snmp_port')
    .eq('status', 'up')
  if (error || !devices?.length) return

  const ts = new Date().toISOString()
  let polled = 0

  for (const dev of devices) {
    const result = await pollSnmpDevice(dev)
    if (!result) continue
    polled++

    const update = { updated_at: ts }
    if (result.uptime) update.uptime  = result.uptime
    if (result.cpu > 0) update.cpu    = result.cpu
    if (result.mem > 0) update.mem    = result.mem
    await supabase.from('devices').update(update).eq('id', dev.id)

    if (result.inMbps > 0 || result.outMbps > 0) {
      await supabase.from('traffic_samples').insert({
        device_name: dev.name,
        interface:   result.ifName,
        in_mbps:     result.inMbps,
        out_mbps:    result.outMbps,
        sampled_at:  ts,
      })
    }
  }
  console.log(`  [snmp] polled ${polled}/${devices.length} devices`)
}

// ── Job 3: Network scan ───────────────────────────────────────────────────────
async function scanNetwork() {
  const net = await detectNetwork()
  if (!net) {
    console.log('  [scan] no active network detected')
    return
  }
  const started = Date.now()
  console.log(`  [scan] sweeping ${net.cidr} (${net.hosts.length} hosts) from ${net.selfIp} …`)

  const icmpMap = new Map()
  for (let i = 0; i < net.hosts.length; i += SCAN_BATCH) {
    const batch = net.hosts.slice(i, i + SCAN_BATCH)
    const res = await Promise.all(batch.map(async ip => ({ ip, ...(await pingHost(ip)) })))
    for (const r of res) icmpMap.set(r.ip, r)
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
    rows.push({
      ip,
      mac,
      hostname:    ip === net.selfIp ? `${os.hostname()} (this agent)` : null,
      vendor:      null,
      device_type: null,
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
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function runPoll() {
  const ts = new Date().toISOString()
  console.log(`\n[${ts}] Running monitor + SNMP poll`)
  await Promise.all([monitorDevices(), pollSnmp()])
}

// Next scan starts SCAN_MS after the previous one finishes, so sweeps never overlap.
async function runScanLoop() {
  console.log(`\n[${new Date().toISOString()}] Running network scan`)
  try { await scanNetwork() } catch (e) { console.log(`  [scan] failed: ${e.message}`) }
  setTimeout(runScanLoop, SCAN_MS)
}

console.log('NetWatch Local Agent')
console.log(`  Platform : ${process.platform}`)
console.log(`  Monitor  : every ${POLL_MS / 1000}s`)
console.log(`  Scan     : every ${SCAN_MS / 1000}s`)
console.log('  Press Ctrl+C to stop.\n')

// Run immediately, then on schedule
runPoll()
runScanLoop()
setInterval(runPoll, POLL_MS)
