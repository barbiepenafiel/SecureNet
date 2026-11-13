/**
 * Generic SNMP poll for non-MikroTik devices (Linux servers, switches, …),
 * used by agent.js every minute.
 *
 * Does on the agent what the dashboard's /api/snmp route does when the
 * dashboard runs on the LAN — so it keeps working when the dashboard is
 * hosted on Vercel, which cannot reach the devices:
 *   system     sysDescr → model + firmware, sysUpTime → uptime
 *   CPU / RAM  UCD-SNMP (net-snmp agents)
 *   traffic    ifInOctets / ifOutOctets for interfaces 1–6 → Mbps
 * MikroTik routers are handled by mikrotik.js instead.
 */

const snmp = require('net-snmp')

const OID_SYS_DESCR = '1.3.6.1.2.1.1.1.0'
const OID_SYS_NAME  = '1.3.6.1.2.1.1.5.0'
const OID_UPTIME    = '1.3.6.1.2.1.1.3.0'
const OID_CPU_IDLE  = '1.3.6.1.4.1.2021.11.11.0'
const OID_MEM_TOTAL = '1.3.6.1.4.1.2021.4.5.0'
const OID_MEM_FREE  = '1.3.6.1.4.1.2021.4.6.0'

const MAX_IF = 6
const ifOids = idx => [
  `1.3.6.1.2.1.2.2.1.2.${idx}`,    // ifDescr
  `1.3.6.1.2.1.2.2.1.10.${idx}`,   // ifInOctets
  `1.3.6.1.2.1.2.2.1.16.${idx}`,   // ifOutOctets
]

function snmpGet(ip, community, port, oids, version = snmp.Version2c) {
  return new Promise(resolve => {
    let s = null
    try {
      s = snmp.createSession(ip, community, { port, timeout: 3000, retries: 1, version })
      s.on('error', () => { try { s.close() } catch {} resolve([]) })   // socket errors must not crash the agent
      s.get(oids, (err, vb) => { try { s.close() } catch {} resolve(err ? [] : (vb ?? [])) })
    } catch {
      try { s?.close() } catch {}
      resolve([])
    }
  })
}

// SNMP v2c answers a missing OID with a "no such object" marker, not an error
const val = vb => (vb && !snmp.isVarbindError(vb) && vb.value != null ? vb.value : undefined)

// sysDescr → { model, firmware } (same rules as the dashboard's /api/snmp)
function parseSysDescr(raw) {
  if (!raw || raw.trim().length === 0) return { model: null, firmware: null }
  const d = raw.trim()
  let m

  if ((m = d.match(/^Linux\s+\S+\s+([\d.\-\w]+)/i))) {
    const distro = /ubuntu/i.test(d) ? 'Ubuntu Server' : /debian/i.test(d) ? 'Debian Server'
                 : /centos/i.test(d) ? 'CentOS Server' : /alpine/i.test(d) ? 'Alpine Linux'
                 : /fedora/i.test(d) ? 'Fedora Server' : 'Linux Server'
    return { model: distro, firmware: m[1] }
  }
  if ((m = d.match(/Cisco IOS[^\n]*Version\s+([\d.()A-Za-z]+)/i))) {
    const hw = d.match(/(?:cisco )([\w-]+) Software/i)
    return { model: hw ? `Cisco ${hw[1]}` : 'Cisco IOS', firmware: m[1] }
  }
  if ((m = d.match(/Cisco Adaptive Security Appliance.*?Version\s+([\d.()]+)/i))) return { model: 'Cisco ASA', firmware: m[1] }
  if ((m = d.match(/Cisco NX-OS.*?Version\s+([\d.()A-Za-z]+)/i)))                return { model: 'Cisco NX-OS', firmware: m[1] }
  if ((m = d.match(/RouterOS\s+(\S+)\s+([\d.]+)/i)))                             return { model: `MikroTik ${m[1]}`, firmware: m[2] }
  if ((m = d.match(/MikroTik\s+RouterOS[,\s]*([\d.]+)/i)))                       return { model: 'MikroTik RouterOS', firmware: m[1] }
  if ((m = d.match(/HP\s+(\S+)\s+([^,]+),\s*revision\s+([\w.]+)/i)))             return { model: `HP ${m[2].trim()}`, firmware: m[3] }
  if ((m = d.match(/JUNOS\s+([\d.A-Za-z]+)/i)))                                  return { model: 'Juniper', firmware: m[1] }
  if ((m = d.match(/Windows[^\n]*Version\s+([\d.]+)/i)))                         return { model: 'Windows', firmware: m[1] }
  if ((m = d.match(/Fortinet\s+(\S+)[^v]*v([\d.]+)/i)))                          return { model: `Fortinet ${m[1]}`, firmware: `v${m[2]}` }
  return { model: d.slice(0, 60).replace(/\s+/g, ' '), firmware: null }
}

function fmtUptime(ticks) {
  const totalSecs = Math.floor(ticks / 100)
  const days = Math.floor(totalSecs / 86400)
  const hrs  = Math.floor((totalSecs % 86400) / 3600)
  const mins = Math.floor((totalSecs % 3600) / 60)
  return days > 0 ? `${days}d ${hrs}h ${mins}m` : `${hrs}h ${mins}m`
}

const prevCounters = new Map()   // `${ip}:${ifName}` → { in, out, ts }
const prevUptime   = new Map()   // ip → sysUpTime ticks (a drop means the device rebooted)
const MAX_PLAUSIBLE_MBPS = 100_000

// Returns null when the device doesn't answer SNMP
async function pollGenericDevice(dev) {
  const community = dev.snmp_community ?? 'public'
  const port      = dev.snmp_port ?? 161
  const version   = String(dev.snmp_version ?? '2c') === '1' ? snmp.Version1 : snmp.Version2c

  const vb = await snmpGet(dev.ip, community, port, [
    OID_SYS_DESCR, OID_SYS_NAME, OID_UPTIME, OID_CPU_IDLE, OID_MEM_TOTAL, OID_MEM_FREE,
  ], version)
  if (!vb.length) return null

  const { model, firmware } = parseSysDescr(val(vb[0])?.toString() ?? '')
  const ticks    = Number(val(vb[2]) ?? 0)
  const cpuIdle  = Number(val(vb[3]) ?? 100)
  const cpu      = Math.max(0, Math.min(100, Math.round(100 - cpuIdle)))
  const memTotal = Number(val(vb[4]) ?? 0)
  const memFree  = Number(val(vb[5]) ?? 0)
  const mem      = memTotal > 0 ? Math.max(0, Math.min(100, Math.round(((memTotal - memFree) / memTotal) * 100))) : 0

  // When the device reboots its counters restart at 0. Without this check
  // that looks like a 32-bit counter wrap and produces one bogus sample of
  // hundreds of Mbps — after a reboot we only take a new baseline.
  const rebooted = prevUptime.has(dev.ip) && ticks < prevUptime.get(dev.ip)
  prevUptime.set(dev.ip, ticks)

  const ifVb = await snmpGet(dev.ip, community, port, Array.from({ length: MAX_IF }, (_, i) => ifOids(i + 1)).flat(), version)
  const now = Date.now()
  const interfaces = []
  for (let i = 0; ifVb.length && i < MAX_IF; i++) {
    const descr = val(ifVb[i * 3])?.toString() ?? ''
    const inO   = Number(val(ifVb[i * 3 + 1]) ?? 0)
    const outO  = Number(val(ifVb[i * 3 + 2]) ?? 0)
    // Skip loopback, virtual bridges and interfaces that never carried traffic
    if (!descr || descr === 'lo' || descr.startsWith('virbr') || (inO === 0 && outO === 0)) continue

    const key  = `${dev.ip}:${descr}`
    const prev = prevCounters.get(key)
    if (prev && !rebooted && now > prev.ts) {
      const secs = (now - prev.ts) / 1000
      // 32-bit counters wrap at ~4.3 GB
      const dIn  = inO  >= prev.in  ? inO  - prev.in  : 0xFFFFFFFF - prev.in  + inO
      const dOut = outO >= prev.out ? outO - prev.out : 0xFFFFFFFF - prev.out + outO
      const inMbps  = parseFloat(((dIn  * 8) / secs / 1_000_000).toFixed(4))
      const outMbps = parseFloat(((dOut * 8) / secs / 1_000_000).toFixed(4))
      if (inMbps <= MAX_PLAUSIBLE_MBPS && outMbps <= MAX_PLAUSIBLE_MBPS) interfaces.push({ ifName: descr, inMbps, outMbps })
    }
    prevCounters.set(key, { in: inO, out: outO, ts: now })
  }

  return { uptime: ticks > 0 ? fmtUptime(ticks) : null, cpu, mem, model, firmware, interfaces }
}

module.exports = { pollGenericDevice, parseSysDescr }
