/**
 * NetWatch Local Agent
 *
 * Runs on a campus machine that has LAN access.
 * Pushes all data to Supabase so the Vercel dashboard can read it.
 *
 * Every 60 s  — ping every device in the `devices` table → update status
 * Every 60 s  — SNMP poll SNMP-enabled devices → traffic_samples, cpu, mem
 * Every 5 min — network scan (ipconfig + arp + ping sweep) → scan_results
 *
 * Usage:
 *   cd poller
 *   node agent.js
 */

const path   = require('path')
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
const SCAN_MS       = parseInt(process.env.SCAN_INTERVAL_MS ?? '300000',10) // 5 min
const SCAN_BATCH    = parseInt(process.env.SCAN_BATCH       ?? '30',    10)
const isWindows     = process.platform === 'win32'

// ── Helpers ───────────────────────────────────────────────────────────────────
function pingHost(ip) {
  const cmd = isWindows
    ? `ping -n 1 -w ${PING_MS} ${ip}`
    : `ping -c 1 -W ${Math.ceil(PING_MS / 1000)} ${ip}`
  return execAsync(cmd, { timeout: PING_MS + 1000 })
    .then(({ stdout }) => {
      const responded = stdout.includes('Reply from') || /TTL=/i.test(stdout) ||
                        stdout.includes('1 received') || /time[<=]\d/i.test(stdout)
      const m = stdout.match(/Average\s*=\s*(\d+)ms/) ??
                stdout.match(/time[<=](\d+)ms/) ??
                stdout.match(/time=(\d+\.?\d*)\s*ms/)
      return { responded, latency_ms: m ? Math.round(parseFloat(m[1])) : responded ? 1 : null }
    })
    .catch(() => ({ responded: false, latency_ms: null }))
}

async function getArpTable() {
  const map = new Map()
  try {
    const { stdout } = await execAsync('arp -a', { timeout: 5000 })
    for (const line of stdout.split('\n')) {
      const m = line.match(
        /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+((?:[\da-fA-F]{2}[-:]){5}[\da-fA-F]{2})\b/
      )
      if (m) map.set(m[1], m[2].replace(/-/g, ':').toUpperCase())
    }
  } catch {}
  return map
}

async function detectSubnets() {
  // Use the default gateway's subnet — the network this PC uses to reach the internet.
  // This is always the correct campus network, even on multi-homed machines.
  try {
    if (isWindows) {
      // "route print 0.0.0.0" lists the default route; grab the gateway IP
      const { stdout: routeOut } = await execAsync('route print 0.0.0.0', { timeout: 5000 })
      const gwMatch = routeOut.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+([\d.]+)/m)
      if (gwMatch) {
        const sub = gwMatch[1].split('.').slice(0, 3).join('.')
        return [sub]
      }
      // Fallback: parse ipconfig for the gateway line
      const { stdout: cfgOut } = await execAsync('ipconfig', { timeout: 5000 })
      const gwLine = cfgOut.match(/Default Gateway[.\s]+:\s*([\d.]+)/i)
      if (gwLine) return [gwLine[1].split('.').slice(0, 3).join('.')]
    } else {
      // Linux: "ip route show default" → "default via GATEWAY_IP dev IFACE"
      const { stdout } = await execAsync('ip route show default', { timeout: 5000 })
      const m = stdout.match(/default via ([\d.]+)/)
      if (m) return [m[1].split('.').slice(0, 3).join('.')]
    }
  } catch {}
  return []
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
  const subnets = await detectSubnets()
  if (!subnets.length) {
    console.log('  [scan] no subnets detected')
    return
  }
  console.log(`  [scan] scanning ${subnets.join(', ')} …`)

  const arpTable = await getArpTable()

  const allIps = []
  for (const sub of subnets)
    for (let i = 1; i <= 254; i++) allIps.push(`${sub}.${i}`)

  // Ping in batches
  const icmpMap = new Map()
  for (let i = 0; i < allIps.length; i += SCAN_BATCH) {
    const batch = allIps.slice(i, i + SCAN_BATCH)
    const res = await Promise.all(batch.map(async ip => ({ ip, ...(await pingHost(ip)) })))
    for (const r of res) icmpMap.set(r.ip, { responded: r.responded, latency_ms: r.latency_ms })
  }

  const scanned_at = new Date().toISOString()
  const rows = []
  for (const ip of allIps) {
    const inArp = arpTable.has(ip)
    const icmp  = icmpMap.get(ip)
    if (!icmp?.responded && !inArp) continue
    const mac = arpTable.get(ip) ?? null
    rows.push({
      ip,
      mac,
      hostname:    null,
      vendor:      null,
      device_type: null,
      scan_type:   icmp?.responded && inArp ? 'both' : inArp ? 'arp' : 'icmp',
      responded:   icmp?.responded ?? false,
      latency_ms:  icmp?.latency_ms ?? null,
      scanned_at,
    })
  }

  // Write to Supabase (keep 30-day history)
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  await supabase.from('scan_results').delete().lt('scanned_at', cutoff)
  if (rows.length) await supabase.from('scan_results').insert(rows)

  console.log(`  [scan] found ${rows.length} hosts across ${subnets.length} subnet(s)`)
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function runPoll() {
  const ts = new Date().toISOString()
  console.log(`\n[${ts}] Running monitor + SNMP poll`)
  await Promise.all([monitorDevices(), pollSnmp()])
}

async function runScan() {
  const ts = new Date().toISOString()
  console.log(`\n[${ts}] Running network scan`)
  await scanNetwork()
}

console.log('NetWatch Local Agent')
console.log(`  Platform : ${process.platform}`)
console.log(`  Monitor  : every ${POLL_MS / 1000}s`)
console.log(`  Scan     : every ${SCAN_MS / 1000}s`)
console.log('  Press Ctrl+C to stop.\n')

// Run immediately, then on schedule
runPoll()
runScan()
setInterval(runPoll, POLL_MS)
setInterval(runScan, SCAN_MS)
