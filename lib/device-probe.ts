// Live check of a single IP for the Add Device form (server only).
// Asks the device directly — nothing is guessed from stored data:
//   ICMP  ping ×3 → reply, latency, TTL
//   ARP   neighbour table right after the ping → MAC → vendor (same network only)
//   SNMP  v2c, then v1 → sysName, sysDescr, sysObjectID, uptime, location, contact
//   DNS   reverse lookup → hostname
import { exec } from 'child_process'
import { promisify } from 'util'
import { promises as dns } from 'dns'
import os from 'os'
import * as snmp from 'net-snmp'
import { lookupOui } from '@/lib/oui'

const execAsync = promisify(exec)

export const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
export const DEVICE_TYPES = ['Router', 'Switch', 'Access Point', 'Firewall', 'Server', 'Computer', 'Client'] as const

export interface ProbeResult {
  ip: string
  probedAt: string
  reachable: boolean
  localNetwork: boolean              // same subnet as this server (ARP possible)
  icmp: { ok: boolean; latencyMs: number | null; ttl: number | null }
  arp:  { ok: boolean; mac: string | null }
  snmp: {
    ok: boolean; community: string | null; port: number; version: 'v2c' | 'v1' | null
    sysName: string | null; sysDescr: string | null; sysObjectID: string | null
    uptime: string | null; location: string | null; contact: string | null
    tried: string[]
  }
  hostname: string | null
  vendor: string | null
  model: string | null
  firmware: string | null
  osHint: string | null
  suggested: { name: string; type: string; method: 'ICMP' | 'ARP' | 'SNMP' | null }
}

// ── ICMP ─────────────────────────────────────────────────────────────────────
async function icmp(ip: string) {
  const cmd = process.platform === 'win32' ? `ping -n 3 -w 1000 ${ip}` : `ping -c 3 -W 1 ${ip}`
  let stdout = ''
  try { ({ stdout } = await execAsync(cmd, { timeout: 8000, windowsHide: true })) }
  catch (e) { stdout = (e as { stdout?: string }).stdout ?? '' }   // ping exits 1 when some replies are lost
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
function onLocalNetwork(ip: string) {
  const toInt = (a: string) => a.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0)
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

async function arp(ip: string): Promise<string | null> {
  try {
    let mac: string | undefined
    if (process.platform === 'win32') {
      const ps = `Get-NetNeighbor -AddressFamily IPv4 -IPAddress ${ip} -ErrorAction SilentlyContinue | Where-Object { $_.State -in 'Reachable','Stale','Delay','Probe' } | Select-Object -First 1 -ExpandProperty LinkLayerAddress`
      const { stdout } = await execAsync(`powershell -NoProfile -Command "${ps}"`, { timeout: 8000, windowsHide: true })
      mac = stdout.trim()
    } else {
      const { stdout } = await execAsync(`ip -4 neigh show ${ip}`, { timeout: 5000, windowsHide: true })
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

function snmpGet(ip: string, community: string, port: number, version: number, oids: string[]): Promise<snmp.VarBind[] | null> {
  return new Promise(resolve => {
    let s: ReturnType<typeof snmp.createSession> | null = null
    try {
      s = snmp.createSession(ip, community, { port, version, timeout: 1500, retries: 1 })
      ;(s as unknown as { on?: (e: string, cb: () => void) => void }).on?.('error', () => { s?.close(); resolve(null) })
      s.get(oids, (err, vb) => { s?.close(); resolve(err ? null : vb) })
    } catch {
      s?.close(); resolve(null)
    }
  })
}

// noSuchObject / noSuchInstance / endOfMibView (missing from the type definitions)
const isVbError = (vb: snmp.VarBind) =>
  (snmp as unknown as { isVarbindError: (v: snmp.VarBind) => boolean }).isVarbindError(vb)

const vbStr = (vb?: snmp.VarBind) => {
  if (!vb || isVbError(vb) || vb.value == null) return null
  const v = Buffer.isBuffer(vb.value) ? vb.value.toString('utf8') : String(vb.value)
  return v.replace(/\0/g, '').trim() || null
}

function fmtTicks(ticks: number) {
  const s = Math.floor(ticks / 100)
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`
}

// ── Identification ───────────────────────────────────────────────────────────
// SNMP enterprise number (from sysObjectID) → vendor and usual device type
const ENTERPRISE: Record<string, [string, string]> = {
  '9': ['Cisco', 'Router'], '14988': ['MikroTik', 'Router'], '311': ['Microsoft', 'Computer'],
  '8072': ['Net-SNMP (Linux)', 'Server'], '2021': ['Net-SNMP (Linux)', 'Server'],
  '41112': ['Ubiquiti', 'Access Point'], '10002': ['Ubiquiti', 'Access Point'], '14823': ['Aruba', 'Access Point'],
  '11': ['HP', 'Switch'], '25506': ['H3C', 'Switch'], '2011': ['Huawei', 'Switch'],
  '12356': ['Fortinet', 'Firewall'], '25461': ['Palo Alto Networks', 'Firewall'], '8741': ['SonicWall', 'Firewall'],
  '2604': ['Sophos', 'Firewall'], '12325': ['pfSense / FreeBSD', 'Firewall'], '2636': ['Juniper', 'Router'],
  '4526': ['Netgear', 'Switch'], '11863': ['TP-Link', 'Switch'], '171': ['D-Link', 'Switch'],
  '1916': ['Extreme Networks', 'Switch'], '30065': ['Arista', 'Switch'], '4413': ['Broadcom', 'Switch'],
  '674': ['Dell', 'Server'], '6876': ['VMware', 'Server'], '207': ['Allied Telesis', 'Switch'],
  '1588': ['Brocade', 'Switch'], '3955': ['Linksys', 'Router'], '6486': ['Alcatel-Lucent', 'Switch'],
}

function fromSysDescr(d: string | null): { model: string | null; firmware: string | null } {
  if (!d) return { model: null, firmware: null }
  let m
  if ((m = d.match(/RouterOS\s+(\S+)/i)))                          return { model: `MikroTik ${m[1]}`, firmware: null }
  if ((m = d.match(/^Linux\s+\S+\s+([\w.\-]+)/i)))                return { model: /ubuntu/i.test(d) ? 'Ubuntu Linux' : /debian/i.test(d) ? 'Debian Linux' : 'Linux', firmware: m[1] }
  if ((m = d.match(/Windows[^\n]*Version\s+([\d.]+)(?:\s*\(Build\s+(\d+))?/i))) return { model: 'Windows', firmware: m[2] ? `${m[1]} build ${m[2]}` : m[1] }
  if ((m = d.match(/Cisco IOS[^\n]*Version\s+([\w.()]+)/i)))       return { model: d.match(/Cisco IOS[^,]*,\s*([\w-]+)\s+Software/i)?.[1] ? `Cisco ${d.match(/Cisco IOS[^,]*,\s*([\w-]+)\s+Software/i)![1]}` : 'Cisco IOS', firmware: m[1] }
  if ((m = d.match(/JUNOS\s+([\w.]+)/i)))                          return { model: 'Juniper', firmware: m[1] }
  if ((m = d.match(/FortiGate[-\s]?(\w+)?.*?v([\d.]+)/i)))          return { model: `FortiGate ${m[1] ?? ''}`.trim(), firmware: m[2] }
  return { model: d.replace(/\s+/g, ' ').slice(0, 60), firmware: null }
}

function osFromTtl(ttl: number | null) {
  if (ttl === null) return null
  if (ttl <= 64)  return 'Linux / Unix / mobile / embedded (TTL ≤ 64)'
  if (ttl <= 128) return 'Windows (TTL ≤ 128)'
  return 'Network equipment (TTL > 128)'
}

// ── Probe ────────────────────────────────────────────────────────────────────
export async function probeDevice(ip: string, community: string | null, port = 161): Promise<ProbeResult> {
  const localNetwork = onLocalNetwork(ip)

  // ICMP first (it also refreshes the ARP entry), SNMP and DNS in parallel
  const communities = community ? [community] : ['public']
  const snmpTask = (async () => {
    const tried: string[] = []
    for (const c of communities) {
      for (const [version, label] of [[snmp.Version2c, 'v2c'], [snmp.Version1, 'v1']] as const) {
        tried.push(`${c} (${label})`)
        const vb = await snmpGet(ip, c, port, version, SYS)
        if (vb) return { vb, community: c, version: label, tried }
      }
    }
    return { vb: null, community: null, version: null, tried }
  })()
  const dnsTask = dns.reverse(ip).then(n => n[0] ?? null, () => null)

  const ping = await icmp(ip)
  const mac  = localNetwork ? await arp(ip) : null
  const [s, hostname] = await Promise.all([snmpTask, dnsTask])

  const sysDescr    = vbStr(s.vb?.[0])
  const sysObjectID = vbStr(s.vb?.[1])
  const ticks       = s.vb && !isVbError(s.vb[2]) ? Number(s.vb[2].value) : null
  let { model, firmware } = fromSysDescr(sysDescr)

  // Vendor / type: SNMP identity first, then MAC vendor, then nothing
  const ent   = sysObjectID?.match(/^1\.3\.6\.1\.4\.1\.(\d+)/)?.[1]
  const byEnt = ent ? ENTERPRISE[ent] : undefined
  const oui   = mac ? lookupOui(mac) : null
  const vendor = byEnt?.[0] ?? (oui && oui.vendor !== 'Unknown' ? oui.vendor : null)
  let type = byEnt?.[1] ?? (oui && oui.device_type !== 'Unknown' ? oui.device_type : null)
    ?? (lookupOui(null, ip).device_type === 'Router' ? 'Router' : 'Client')   // .1 / .254 are usually gateways
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
    },
    hostname,
    vendor,
    model,
    firmware,
    osHint: osFromTtl(ping.ttl),
    suggested: { name, type, method },
  }
}

// Recent probe results, so saving uses what the server measured — not what the browser sends
const g = globalThis as unknown as { __probeCache?: Map<string, ProbeResult> }
const cache = (g.__probeCache ??= new Map())
const CACHE_MS = 10 * 60 * 1000
const cacheKey = (ip: string, community: string | null, port: number) => `${ip}|${community ?? ''}|${port}`

export function rememberProbe(r: ProbeResult, community: string | null) {
  cache.set(cacheKey(r.ip, community, r.snmp.port), r)
  for (const [k, v] of cache) if (Date.now() - new Date(v.probedAt).getTime() > CACHE_MS) cache.delete(k)
}
export function recentProbe(ip: string, community: string | null, port: number) {
  const r = cache.get(cacheKey(ip, community, port))
  return r && Date.now() - new Date(r.probedAt).getTime() < CACHE_MS ? r : null
}
