// Device online/offline monitor and alert generator (server only).
// Runs every 15 s from a server timer (instrumentation.ts) and can also be
// triggered by the dashboard through /api/monitor — both share one state.
import { exec } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import * as snmp from 'net-snmp'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const execAsync = promisify(exec)

// ── Rules ─────────────────────────────────────────────────────────────────────
export const CHECK_INTERVAL_MS    = 15_000   // check every device every 15 s
export const FAILS_BEFORE_OFFLINE = 3        // consecutive failed checks before a device is confirmed offline
const MIN_ROUND_GAP_MS            = 12_000   // extra calls inside this window reuse the last round
const SYSTEM_USER                 = 'System (auto)'

// ── State kept between rounds ────────────────────────────────────────────────
// Kept on globalThis so the API route and the server timer (which Next may
// load as separate bundles) share a single copy.
const g = globalThis as unknown as {
  __alertMonitor?: {
    failStreak: Map<string, number>                 // ip → consecutive failed checks
    inflight: Promise<RoundResult> | null           // one round at a time
    lastRound: { at: number; result: RoundResult } | null
    timer: ReturnType<typeof setInterval> | null
    known?: Map<string, KnownHost>                  // discovered hosts we keep watching
  }
}
const state = (g.__alertMonitor ??= { failStreak: new Map(), inflight: null, lastRound: null, timer: null, known: new Map() })
state.known ??= new Map()
const failStreak = state.failStreak
const known: Map<string, KnownHost> = state.known

// The scanner drops a host from scan_results as soon as it stops answering,
// so we remember every discovered host and keep checking it for this long
// after it was last seen — long enough to confirm it went offline.
const KNOWN_HOST_TTL_MS = 60 * 60 * 1000
interface KnownHost { name: string; mac: string | null; lastSeen: number }

type Method = 'ICMP' | 'ARP' | 'SNMP'

interface Target {
  ip: string
  name: string
  discovered: boolean
  deviceId?: string
  status?: string
  location: string
  mac: string | null
  snmpCommunity?: string | null
  snmpPort?: number | null
}

interface CheckResult {
  source: 'managed' | 'discovered'
  name: string
  ip: string
  up: boolean
  method?: Method
  streak: number
  skipped?: boolean
  reason?: string
  event?: 'online' | 'offline'
}

interface RoundResult {
  checked: number
  threshold: number
  managed: CheckResult[]
  discovered: CheckResult[]
  checkedAt: string
  agent?: boolean   // true when the local agent is doing the monitoring
  agentOnline?: boolean   // false = the agent stopped reporting (statuses may be out of date)
}

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
}

// ── Detection: ICMP → ARP → SNMP ─────────────────────────────────────────────

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

async function pingOnce(ip: string): Promise<boolean> {
  if (!IPV4.test(ip)) return false   // never pass anything else to the shell
  const cmd = process.platform === 'win32'
    ? `ping -n 1 -w 1000 ${ip}`
    : `ping -c 1 -W 1 ${ip}`
  try {
    const { stdout } = await execAsync(cmd, { timeout: 2500, windowsHide: true })
    // A real echo reply comes from the target and carries a TTL. Windows also
    // prints "Reply from <own IP>: Destination host unreachable" — not a reply.
    const fromTarget = new RegExp(`from ${ip.replace(/\./g, '\\.')}(?!\\d)`, 'i').test(stdout)
    return fromTarget && /ttl[=:]/i.test(stdout)
  } catch {
    return false
  }
}

// Neighbours confirmed reachable right now (the failed ping just made the OS
// re-check them, so a host that blocks ping but answers ARP shows up here).
async function arpReachable(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const add = (ip: string, mac: string) => {
    mac = mac.replace(/-/g, ':').toUpperCase()
    if (/^(00:){5}00$|^(FF:){5}FF$|^01:00:5E/.test(mac)) return
    map.set(ip, mac)
  }
  try {
    if (process.platform === 'win32') {
      const ps = "Get-NetNeighbor -AddressFamily IPv4 -State Reachable | ForEach-Object { $_.IPAddress + ' ' + $_.LinkLayerAddress }"
      const { stdout } = await execAsync(`powershell -NoProfile -Command "${ps}"`, { timeout: 8000, windowsHide: true })
      for (const line of stdout.split(/\r?\n/)) {
        const [ip, mac] = line.trim().split(/\s+/)
        if (ip && mac && /^(?:[\da-fA-F]{2}-){5}[\da-fA-F]{2}$/.test(mac)) add(ip, mac)
      }
    } else {
      const { stdout } = await execAsync('ip -4 neigh show', { timeout: 5000, windowsHide: true })
      for (const line of stdout.split('\n')) {
        const m = line.match(/^([\d.]+) .*lladdr ((?:[\da-f]{2}:){5}[\da-f]{2}) REACHABLE/i)
        if (m) add(m[1], m[2])
      }
    }
  } catch { /* neighbour table unavailable — ARP check is skipped */ }
  return map
}

function snmpAlive(ip: string, community: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    let session: ReturnType<typeof snmp.createSession> | null = null
    try {
      session = snmp.createSession(ip, community, { port, retries: 0, timeout: 1500, version: snmp.Version2c })
      // A socket error is emitted as an event; without a listener it would crash the server
      ;(session as unknown as { on?: (e: string, cb: () => void) => void })
        .on?.('error', () => { session?.close(); resolve(false) })
      session.get(['1.3.6.1.2.1.1.3.0'], (err, vb) => {   // sysUpTime
        session?.close()
        resolve(!err && Array.isArray(vb) && vb.length > 0)
      })
    } catch {
      session?.close()
      resolve(false)
    }
  })
}

// /24 prefixes of the networks this machine is on right now
function localSubnets(): Set<string> {
  const out = new Set<string>()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        out.add(subnetOf(a.address))
      }
    }
  }
  return out
}
const subnetOf = (ip: string) => ip.split('.').slice(0, 3).join('.')

// ── Alerts ────────────────────────────────────────────────────────────────────

interface AlertDetails {
  t: Target
  status: 'online' | 'offline'
  method: string
  at: string
}

// Details are stored in their own columns (if the migration was run) and also
// in `meta`, so the page can show them either way.
async function insertAlert(db: SupabaseClient, d: AlertDetails) {
  const { t, status, method, at } = d
  const mac  = t.mac ?? '—'
  const meta = `${t.discovered ? '[Discovered] ' : ''}IP: ${t.ip} · MAC: ${mac} · Location: ${t.location} · Method: ${method} · Status: ${status === 'online' ? 'Online' : 'Offline'}`

  const base = status === 'offline'
    ? {
        severity: 'crit',
        title: `${t.name} is offline`,
        meta,
        acked: false,
        suppressed: false,
        root_cause: `No response from ${t.ip} to ${FAILS_BEFORE_OFFLINE} consecutive ICMP checks, ARP or SNMP — check cable, power and upstream switch`,
        created_at: at,
      }
    : {
        severity: 'info',
        title: `${t.name} is back online`,
        meta,
        acked: true,            // informational — nothing to act on
        suppressed: false,
        root_cause: `Device answered via ${method}`,
        created_at: at,
      }

  const full = {
    ...base,
    device_name: t.name,
    device_ip: t.ip,
    device_mac: t.mac,
    location: t.location,
    detection_method: method,
    status,
  }

  const { error } = await db.from('alerts').insert(full)
  if (error && /column|schema cache/i.test(error.message)) {
    // Detail columns not added yet — store the basic alert (details stay in meta)
    await db.from('alerts').insert(base)
  }
}

// ── One monitoring round ─────────────────────────────────────────────────────

// The local agent (poller/agent.js) owns discovery, status and alerts while it
// is reporting. This server monitor is only the backup when it isn't.
const AGENT_FRESH_MS = 60_000

async function agentIsReporting(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.from('agent_status').select('last_seen')
    .order('last_seen', { ascending: false }).limit(1)
  if (error || !data?.length) return false
  return Date.now() - new Date(data[0].last_seen).getTime() < AGENT_FRESH_MS
}

async function runRound(): Promise<RoundResult> {
  const db  = adminClient()
  const now = new Date().toISOString()

  // A hosted (Vercel) server is not on the campus LAN: every ping from it
  // would fail and devices would be marked offline with false alerts. There
  // it only ever reports what the agent stored, and says whether the agent
  // is still reporting.
  const agentOnline = await agentIsReporting(db)
  if (agentOnline || process.env.VERCEL) {
    // Report the agent's view instead of checking (and alerting) twice
    const { data: devs } = await db.from('devices').select('name, ip, status, last_method').neq('status', 'maint')
    return {
      checked:    devs?.length ?? 0,
      threshold:  FAILS_BEFORE_OFFLINE,
      managed:    (devs ?? []).map(d => ({
        source: 'managed' as const, name: d.name, ip: d.ip,
        up: d.status === 'up' || d.status === 'warn',
        method: (d.last_method ?? undefined) as Method | undefined,
        streak: d.status === 'down' ? FAILS_BEFORE_OFFLINE : 0,
        skipped: d.status === 'unknown' || d.status === 'unreachable' ? true : undefined,
      })),
      discovered: [],
      checkedAt:  now,
      agent:      true,
      agentOnline,
    }
  }

  // Managed devices (location comes from the device record)
  const { data: allDevices } = await db
    .from('devices')
    .select('*')
    .neq('status', 'maint')
  // Auto-discovered devices belong to the agent; without it their status is Unknown
  const devices = (allDevices ?? []).filter(d => d.source !== 'discovered')

  const targets: Target[] = devices.map(d => ({
    ip: d.ip, name: d.name, discovered: false, deviceId: d.id, status: d.status,
    location: d.location || 'Unassigned', mac: null,
    snmpCommunity: d.snmp_community, snmpPort: d.snmp_port,
  }))
  const managedIps = new Set(targets.map(t => t.ip))

  // Discovered hosts: seen by the scanner in the last hour, plus any host
  // that still has an open offline alert (so we notice when it comes back)
  const { data: scanRows } = await db
    .from('scan_results')
    .select('ip, mac, vendor, hostname, scanned_at')
    .gte('scanned_at', new Date(Date.now() - KNOWN_HOST_TTL_MS).toISOString())
    .order('scanned_at', { ascending: false })
  const { data: openDisc } = await db
    .from('alerts')
    .select('meta, device_name, device_mac, location')
    .ilike('meta', '[Discovered]%')
    .eq('severity', 'crit')
    .is('resolved_at', null)
    .eq('suppressed', false)
  // Locations for discovered hosts come from the existing client records
  const { data: clientRows } = await db.from('clients').select('ip, mac, building')
  const clientLoc = (ip: string, mac: string | null) =>
    (clientRows ?? []).find(c => c.ip === ip || (mac && c.mac?.toUpperCase() === mac.toUpperCase()))?.building

  // Remember every host the scanner reports...
  const nowMs = Date.now()
  for (const r of scanRows ?? []) {
    if (managedIps.has(r.ip)) continue
    const prev = known.get(r.ip)
    known.set(r.ip, {
      name: r.hostname || r.vendor || prev?.name || r.ip,
      mac: r.mac ?? prev?.mac ?? null,
      lastSeen: Math.max(prev?.lastSeen ?? 0, new Date(r.scanned_at).getTime()),
    })
  }
  // ...and keep checking it for an hour after it was last seen, even once
  // it has dropped out of the scan (that's exactly when it went offline)
  const seen = new Set<string>()
  for (const [ip, h] of known) {
    if (nowMs - h.lastSeen > KNOWN_HOST_TTL_MS || managedIps.has(ip)) { known.delete(ip); continue }
    seen.add(ip)
    targets.push({
      ip, name: h.name, discovered: true,
      location: clientLoc(ip, h.mac) || 'Unassigned', mac: h.mac,
    })
  }
  for (const a of openDisc ?? []) {
    const ip = a.meta.match(/IP: ([\d.]+) /)?.[1]
    if (!ip || managedIps.has(ip) || seen.has(ip)) continue
    seen.add(ip)
    targets.push({
      ip, name: a.device_name || ip, discovered: true,
      location: a.location || clientLoc(ip, a.device_mac ?? null) || 'Unassigned', mac: a.device_mac ?? null,
    })
  }

  // 1. ICMP
  const icmp = await Promise.all(targets.map(t => pingOnce(t.ip)))

  // 2. ARP (only if something didn't answer ping)
  const arp = icmp.some(ok => !ok) ? await arpReachable() : new Map<string, string>()

  // 3. SNMP (managed devices that failed both)
  const checks = await Promise.all(targets.map(async (t, i) => {
    if (icmp[i]) return { t, up: true, method: 'ICMP' as Method }
    if (arp.has(t.ip)) return { t, up: true, method: 'ARP' as Method }
    if (!t.discovered && t.snmpCommunity && await snmpAlive(t.ip, t.snmpCommunity, t.snmpPort ?? 161)) {
      return { t, up: true, method: 'SNMP' as Method }
    }
    return { t, up: false as const, method: undefined }
  }))

  // MAC from the neighbour table when we have it
  for (const c of checks) if (arp.has(c.t.ip)) c.t.mac = arp.get(c.t.ip)!

  // Discovered hosts only: if this machine isn't on the host's network and
  // nothing on that network answered, the failure says nothing about the host
  // (e.g. the monitoring PC moved to another Wi-Fi) — don't count it.
  // Managed devices (incl. VMs) are always checked and alerted.
  const mine = localSubnets()
  const answering = new Set(checks.filter(c => c.up).map(c => subnetOf(c.t.ip)))
  const outOfReach = (t: Target) =>
    t.discovered && !mine.has(subnetOf(t.ip)) && !answering.has(subnetOf(t.ip))

  const results: CheckResult[] = []
  for (const { t, up, method } of checks) {
    const base = { source: t.discovered ? 'discovered' as const : 'managed' as const, name: t.name, ip: t.ip }

    if (up) {
      failStreak.set(t.ip, 0)
      const k = known.get(t.ip)
      if (t.discovered && k) k.lastSeen = Date.now()
      const cameBack = await markOnline(db, t, now)
      if (cameBack) await insertAlert(db, { t, status: 'online', method: method!, at: now })
      results.push({ ...base, up: true, method, streak: 0, event: cameBack ? 'online' : undefined })
      continue
    }

    if (outOfReach(t)) {
      failStreak.delete(t.ip)
      results.push({ ...base, up: false, streak: 0, skipped: true, reason: 'Monitor is not connected to this network' })
      continue
    }

    const streak = (failStreak.get(t.ip) ?? 0) + 1
    failStreak.set(t.ip, streak)
    let event: 'offline' | undefined
    if (streak >= FAILS_BEFORE_OFFLINE && await markOffline(db, t)) {
      const tried = t.discovered ? `ICMP ×${FAILS_BEFORE_OFFLINE}, ARP` : `ICMP ×${FAILS_BEFORE_OFFLINE}, ARP, SNMP`
      await insertAlert(db, { t, status: 'offline', method: `No response (${tried})`, at: now })
      event = 'offline'
    }
    results.push({ ...base, up: false, streak, event })
  }

  return {
    checked:    targets.length,
    threshold:  FAILS_BEFORE_OFFLINE,
    managed:    results.filter(r => r.source === 'managed'),
    discovered: results.filter(r => r.source === 'discovered'),
    checkedAt:  now,
  }
}

// The alert history is the record of each device's last announced state:
// the newest offline alert vs. the newest back-online alert for its IP.
async function lastAnnounced(db: SupabaseClient, ip: string): Promise<'online' | 'offline' | null> {
  const latest = async (severity: string) => {
    const { data } = await db.from('alerts').select('created_at')
      .ilike('meta', `%IP: ${ip} %`).eq('severity', severity)
      .order('created_at', { ascending: false }).limit(1)
    return data?.[0]?.created_at as string | undefined
  }
  const [off, on] = await Promise.all([latest('crit'), latest('info')])
  if (!off && !on) return null
  if (off && (!on || off > on)) return 'offline'
  return 'online'
}

// Returns true only when the device came back after an offline alert.
// The alert history decides — not the device's status column, which another
// writer (e.g. the local agent) may flip on a single missed ping.
async function markOnline(db: SupabaseClient, t: Target, now: string): Promise<boolean> {
  if (!t.discovered) {
    const { data } = await db.from('devices').update({ status: 'up' })
      .eq('id', t.deviceId).eq('status', 'down').select('id')
    if (data?.length) {
      await db.from('status_events').insert({
        device_id: t.deviceId, device_name: t.name, device_ip: t.ip, old_status: 'down', new_status: 'up',
      }).then(() => null, () => null)
    }
  }
  const wasOffline = await lastAnnounced(db, t.ip) === 'offline'
  // Close the open offline alert(s) for this IP
  await db.from('alerts')
    .update({ acked: true, resolved_at: now, resolved_by: SYSTEM_USER, resolution_notes: 'Device is back online' })
    .ilike('meta', `%IP: ${t.ip} %`).eq('severity', 'crit').is('resolved_at', null)
  return wasOffline
}

// Returns true when an offline alert should be raised: the device is confirmed
// offline and no offline alert has been raised for this outage yet. This also
// covers devices that were already marked offline but never got an alert
// (e.g. a VM that was shut down while the monitor wasn't running).
async function markOffline(db: SupabaseClient, t: Target): Promise<boolean> {
  if (await lastAnnounced(db, t.ip) === 'offline') return false   // already alerted this outage

  if (!t.discovered) {
    const { data } = await db.from('devices').update({ status: 'down' })
      .eq('id', t.deviceId).neq('status', 'down').select('id')
    if (data?.length) {
      await db.from('status_events').insert({
        device_id: t.deviceId, device_name: t.name, device_ip: t.ip, old_status: t.status, new_status: 'down',
      }).then(() => null, () => null)
    }
  }
  return true
}


// ── Public API ───────────────────────────────────────────────────────────────

// Run a round unless one ran in the last ~12 s (then reuse its result).
// Several tabs, users and the server timer can all call this safely: the
// 3-strike count isn't inflated and alerts aren't duplicated.
export async function triggerRound(): Promise<RoundResult & { cached?: boolean }> {
  if (state.lastRound && Date.now() - state.lastRound.at < MIN_ROUND_GAP_MS) {
    return { ...state.lastRound.result, cached: true }
  }
  if (!state.inflight) {
    const startedAt = Date.now()   // gap is measured start-to-start, so rounds stay 15 s apart
    state.inflight = runRound()
      .then(result => { state.lastRound = { at: startedAt, result }; return result })
      .finally(() => { state.inflight = null })
  }
  return state.inflight
}

export function monitorStatus() {
  const streaks: Record<string, number> = {}
  failStreak.forEach((v, k) => { streaks[k] = v })
  return {
    streaks,
    threshold:   FAILS_BEFORE_OFFLINE,
    intervalMs:  CHECK_INTERVAL_MS,
    timer:       !!state.timer,
    lastRoundAt: state.lastRound?.at ?? null,
  }
}

// Start the 15 s server timer once per server process
export function startMonitorTimer() {
  if (state.timer) return
  state.timer = setInterval(() => { triggerRound().catch(() => {}) }, CHECK_INTERVAL_MS)
  triggerRound().catch(() => {})
}
