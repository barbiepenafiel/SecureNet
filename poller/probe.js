/**
 * Live check of one IP, run by the agent for the dashboard's Add Device form
 * (job type "probe", see jobs.js). Same checks and result shape as the
 * dashboard's lib/device-probe.ts, which is used when the dashboard itself
 * runs on the LAN:
 *   ICMP  ping ×3 → reply, latency, TTL
 *   ARP   neighbour table right after the ping → MAC → vendor (same network only)
 *   SNMP  v2c, then v1 → sysName, sysDescr, sysObjectID, uptime, location, contact
 *   DNS   reverse lookup → hostname
 * Read-only: nothing is written to the device.
 */

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const dns  = require('dns').promises
const { exec }      = require('child_process')
const { promisify } = require('util')
const snmp = require('net-snmp')
const st   = require('./snmp-status')

const execAsync = promisify(exec)
const isWindows = process.platform === 'win32'

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

// MAC prefix → vendor/type, from the dashboard's lib/oui.ts (one shared list)
const OUI = new Map()
try {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'oui.ts'), 'utf8')
  for (const m of src.matchAll(/'([0-9A-F]{6})':\s*\{\s*vendor:\s*'([^']+)',\s*device_type:\s*'([^']+)'/g)) {
    OUI.set(m[1], { vendor: m[2], type: m[3] })
  }
} catch { /* vendor lookup unavailable */ }
const VM_OUI = { '080027': 'VirtualBox VM', '000C29': 'VMware VM', '005056': 'VMware VM', '00155D': 'Hyper-V VM', '525400': 'QEMU/KVM VM' }

// ── ICMP ─────────────────────────────────────────────────────────────────────
async function icmp(ip) {
  const cmd = isWindows ? `ping -n 3 -w 1000 ${ip}` : `ping -c 3 -W 1 ${ip}`
  let stdout = ''
  try { ({ stdout } = await execAsync(cmd, { timeout: 8000, windowsHide: true })) }
  catch (e) { stdout = e.stdout ?? '' }   // ping exits 1 when some replies are lost
  // Only real echo replies from the target count (Windows also prints
  // "Reply from <own IP>: Destination host unreachable")
  const esc = ip.replace(/\./g, '\\.')
  const replies = stdout.split(/\r?\n/).filter(l => new RegExp(`from ${esc}(?!\\d)`, 'i').test(l) && /ttl[=:]/i.test(l))
  if (!replies.length) return { ok: false, latencyMs: null, ttl: null }
  const times = replies.map(l => Number(l.match(/time[=<]\s*(\d+(?:\.\d+)?)/i)?.[1] ?? 0))
  const ttl = Number(replies[0].match(/ttl[=:]\s*(\d+)/i)?.[1] ?? NaN)
  return { ok: true, latencyMs: Math.round(times.reduce((a, b) => a + b, 0) / times.length), ttl: Number.isFinite(ttl) ? ttl : null }
}

// ── ARP ──────────────────────────────────────────────────────────────────────
function onLocalNetwork(ip) {
  const toInt = a => a.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0)
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.cidr) continue
      const prefix = Number(a.cidr.split('/')[1])
      const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
      if (((toInt(a.address) & mask) >>> 0) === ((toInt(ip) & mask) >>> 0)) return true
    }
  }
  return false
}

async function arp(ip) {
  try {
    let mac
    if (isWindows) {
      const ps = `Get-NetNeighbor -AddressFamily IPv4 -IPAddress ${ip} -ErrorAction SilentlyContinue | Where-Object { $_.State -in 'Reachable','Stale','Delay','Probe' } | Select-Object -First 1 -ExpandProperty LinkLayerAddress`
      const { stdout } = await execAsync(`powershell -NoProfile -Command "${ps}"`, { timeout: 8000, windowsHide: true })
      mac = stdout.trim()
    } else {
      const { stdout } = await execAsync(`ip -4 neigh show ${ip}`, { timeout: 5000 })
      mac = stdout.match(/lladdr ((?:[\da-f]{2}:){5}[\da-f]{2}) (REACHABLE|STALE|DELAY|PROBE)/i)?.[1]
    }
    if (!mac || !/^(?:[\da-f]{2}[:-]){5}[\da-f]{2}$/i.test(mac)) return null
    mac = mac.replace(/-/g, ':').toUpperCase()
    return /^(00:){5}00$|^(FF:){5}FF$/.test(mac) ? null : mac
  } catch {
    return null
  }
}

// ── SNMP ─────────────────────────────────────────────────────────────────────
const SYS = ['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.2.0', '1.3.6.1.2.1.1.3.0', '1.3.6.1.2.1.1.4.0', '1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.6.0']
const MIKROTIK_VERSION = '1.3.6.1.4.1.14988.1.1.4.4.0'

function snmpGet(ip, community, port, version, oids) {
  return new Promise(resolve => {
    let s = null
    try {
      s = snmp.createSession(ip, community, { port, version, timeout: 1500, retries: 1 })
      s.on('error', () => { try { s.close() } catch {} resolve(null) })
      s.get(oids, (err, vb) => { try { s.close() } catch {} resolve(err ? null : vb) })
    } catch {
      try { s?.close() } catch {}
      resolve(null)
    }
  })
}

const vbStr = vb => {
  if (!vb || snmp.isVarbindError(vb) || vb.value == null) return null
  const v = Buffer.isBuffer(vb.value) ? vb.value.toString('utf8') : String(vb.value)
  return v.replace(/\0/g, '').trim() || null
}

function fmtTicks(ticks) {
  const s = Math.floor(ticks / 100)
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`
}

// ── Identification ───────────────────────────────────────────────────────────
// SNMP enterprise number (from sysObjectID) → vendor and usual device type
const ENTERPRISE = {
  9: ['Cisco', 'Router'], 14988: ['MikroTik', 'Router'], 311: ['Microsoft', 'Computer'],
  8072: ['Net-SNMP (Linux)', 'Server'], 2021: ['Net-SNMP (Linux)', 'Server'],
  41112: ['Ubiquiti', 'Access Point'], 10002: ['Ubiquiti', 'Access Point'], 14823: ['Aruba', 'Access Point'],
  11: ['HP', 'Switch'], 25506: ['H3C', 'Switch'], 2011: ['Huawei', 'Switch'],
  12356: ['Fortinet', 'Firewall'], 25461: ['Palo Alto Networks', 'Firewall'], 8741: ['SonicWall', 'Firewall'],
  2604: ['Sophos', 'Firewall'], 12325: ['pfSense / FreeBSD', 'Firewall'], 2636: ['Juniper', 'Router'],
  4526: ['Netgear', 'Switch'], 11863: ['TP-Link', 'Switch'], 171: ['D-Link', 'Switch'],
  1916: ['Extreme Networks', 'Switch'], 30065: ['Arista', 'Switch'], 4413: ['Broadcom', 'Switch'],
  674: ['Dell', 'Server'], 6876: ['VMware', 'Server'], 207: ['Allied Telesis', 'Switch'],
  1588: ['Brocade', 'Switch'], 3955: ['Linksys', 'Router'], 6486: ['Alcatel-Lucent', 'Switch'],
}

function fromSysDescr(d) {
  if (!d) return { model: null, firmware: null }
  let m
  if ((m = d.match(/RouterOS\s+(\S+)/i)))             return { model: `MikroTik ${m[1]}`, firmware: null }
  if ((m = d.match(/^Linux\s+\S+\s+([\w.\-]+)/i)))    return { model: /ubuntu/i.test(d) ? 'Ubuntu Linux' : /debian/i.test(d) ? 'Debian Linux' : 'Linux', firmware: m[1] }
  if ((m = d.match(/Windows[^\n]*Version\s+([\d.]+)(?:\s*\(Build\s+(\d+))?/i))) return { model: 'Windows', firmware: m[2] ? `${m[1]} build ${m[2]}` : m[1] }
  if ((m = d.match(/Cisco IOS[^\n]*Version\s+([\w.()]+)/i))) {
    const hw = d.match(/Cisco IOS[^,]*,\s*([\w-]+)\s+Software/i)?.[1]
    return { model: hw ? `Cisco ${hw}` : 'Cisco IOS', firmware: m[1] }
  }
  if ((m = d.match(/JUNOS\s+([\w.]+)/i)))             return { model: 'Juniper', firmware: m[1] }
  if ((m = d.match(/FortiGate[-\s]?(\w+)?.*?v([\d.]+)/i))) return { model: `FortiGate ${m[1] ?? ''}`.trim(), firmware: m[2] }
  return { model: d.replace(/\s+/g, ' ').slice(0, 60), firmware: null }
}

function osFromTtl(ttl) {
  if (ttl === null) return null
  if (ttl <= 64)  return 'Linux / Unix / mobile / embedded (TTL ≤ 64)'
  if (ttl <= 128) return 'Windows (TTL ≤ 128)'
  return 'Network equipment (TTL > 128)'
}

function macVendor(mac) {
  if (!mac) return null
  const prefix = mac.replace(/[^0-9A-F]/gi, '').toUpperCase().slice(0, 6)
  if (VM_OUI[prefix]) return { vendor: VM_OUI[prefix], type: 'Server' }
  const hit = OUI.get(prefix)
  return hit ? { vendor: hit.vendor, type: hit.type } : null
}

// ── Probe ────────────────────────────────────────────────────────────────────
async function probeDevice(ip, community, port = 161) {
  if (!IPV4.test(ip)) throw new Error('Invalid IPv4 address')   // never pass anything else to the shell
  port = Number(port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SNMP port')
  if (community != null && (typeof community !== 'string' || community.length > 64)) throw new Error('Invalid SNMP community')

  const localNetwork = onLocalNetwork(ip)

  // ICMP first (it also refreshes the ARP entry), SNMP and DNS in parallel
  const communities = community ? [community] : ['public']
  const snmpTask = (async () => {
    const tried = []
    for (const c of communities) {
      for (const [version, label] of [[snmp.Version2c, 'v2c'], [snmp.Version1, 'v1']]) {
        tried.push(`${c} (${label})`)
        const vb = await snmpGet(ip, c, port, version, SYS)
        if (vb) return { vb, community: c, version: label, tried }
      }
    }
    return { vb: null, community: null, version: null, tried }
  })()
  const dnsTask = Promise.race([
    dns.reverse(ip).then(n => n[0] ?? null, () => null),
    new Promise(r => setTimeout(() => r(null), 3000)),
  ])

  const ping = await icmp(ip)
  const mac  = localNetwork ? await arp(ip) : null
  const [s, hostname] = await Promise.all([snmpTask, dnsTask])

  const sysDescr    = vbStr(s.vb?.[0])
  const sysObjectID = vbStr(s.vb?.[1])
  const ticks       = s.vb && !snmp.isVarbindError(s.vb[2]) ? Number(s.vb[2].value) : null
  let { model, firmware } = fromSysDescr(sysDescr)

  // Vendor / type: SNMP identity first, then MAC vendor, then nothing
  const ent   = sysObjectID?.match(/^1\.3\.6\.1\.4\.1\.(\d+)/)?.[1]
  const byEnt = ent ? ENTERPRISE[ent] : undefined
  const oui   = macVendor(mac)
  const vendor = byEnt?.[0] ?? (oui && oui.vendor !== 'Unknown' ? oui.vendor : null)
  const last   = Number(ip.split('.').pop())
  let type = byEnt?.[1] ?? (oui && oui.type !== 'Unknown' ? oui.type : null)
    ?? (last === 1 || last === 2 || last === 254 ? 'Router' : 'Client')   // .1 / .254 are usually gateways
  if (ent === '9'   && /switch|catalyst|C29|C35|C37|C38|C9[23]/i.test(sysDescr ?? '')) type = 'Switch'
  if (ent === '311' && /server/i.test(sysDescr ?? ''))                                   type = 'Server'
  if (ent === '11'  && /jetdirect|printer|laserjet/i.test(sysDescr ?? ''))               type = 'Client'

  if (ent === '14988' && s.community) {   // RouterOS version lives in MikroTik's own MIB
    const v = await snmpGet(ip, s.community, port, s.version === 'v1' ? snmp.Version1 : snmp.Version2c, [MIKROTIK_VERSION])
    const ver = vbStr(v?.[0])
    if (ver) firmware = `RouterOS ${ver}`
  }

  const sysName = vbStr(s.vb?.[4])
  const name = sysName ?? hostname?.split('.')[0] ?? (vendor ? `${vendor} ${ip}` : '')
  const method = ping.ok ? 'ICMP' : mac ? 'ARP' : s.vb ? 'SNMP' : null

  // Why SNMP didn't answer: unreachable / disabled / timeout (see snmp-status.js)
  const snmpState = s.vb
    ? { status: 'responding', detail: `Answered SNMP ${s.version} with community "${s.community}".` }
    : await st.diagnoseNoAnswer({ ip, port, community: communities[0], reachable: ping.ok || !!mac, everAnswered: false })

  return {
    ip,
    probedAt: new Date().toISOString(),
    reachable: !!method,
    localNetwork,
    icmp: ping,
    arp: { ok: !!mac, mac },
    snmp: {
      ok: !!s.vb, community: s.community, port, version: s.version,
      sysName, sysDescr, sysObjectID,
      uptime: ticks !== null && Number.isFinite(ticks) ? fmtTicks(ticks) : null,
      location: vbStr(s.vb?.[5]), contact: vbStr(s.vb?.[3]),
      tried: s.tried,
      status: snmpState.status, detail: snmpState.detail,
    },
    hostname,
    vendor,
    model,
    firmware,
    osHint: osFromTtl(ping.ttl),
    suggested: { name, type, method },
  }
}

module.exports = { probeDevice, IPV4 }
