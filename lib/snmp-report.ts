// SNMP section of the Reports page (server only).
// Builds per-device uptime and traffic totals from the history the agent
// stores — nothing is estimated from the device's current status.
//   uptime  ← latency_samples (1 row / device / minute, 7 days kept)
//   traffic ← traffic_samples (SNMP polls, per interface)
import type { SupabaseClient } from '@supabase/supabase-js'

export type ReportPeriod = '24h' | '7d' | '30d'
export const REPORT_PERIOD_MS: Record<ReportPeriod, number> = {
  '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000,
}
export const UPTIME_HISTORY_DAYS = 7

export interface SnmpDeviceReport {
  id: string; name: string; ip: string; type: string; status: string
  cpu: number; mem: number
  upMin: number; downMin: number; unknownMin: number
  uptimePct: number | null                   // null = not measured in this period
  inBytes: number; outBytes: number
  avgInMbps: number | null; avgOutMbps: number | null
  peakInMbps: number | null; peakOutMbps: number | null
  firstSample: string | null
}
export interface SnmpReport { period: ReportPeriod; generatedAt: string; historyDays: number; devices: SnmpDeviceReport[] }

interface DeviceRow { id: string; name: string; ip: string; type: string; status: string; cpu: number; mem: number; uptime: string | null }

// Same rule as the dashboard SNMP tag: the device actually returned SNMP data
export const answeredSnmp = (d: { cpu: number; mem: number; uptime: string | null }) =>
  d.cpu > 0 || d.mem > 0 || (!!d.uptime && d.uptime !== '—')

const isLoopback = (iface: string) => /^lo\d*$|loopback/i.test(iface)

// When a device reboots its 32-bit traffic counters restart at 0, and the
// generic SNMP poll reads that as a counter wrap: one bogus sample with
// in ≈ out at hundreds of Mbps (≈ 2³² bytes ÷ poll interval). Skip those.
const isResetArtifact = (inM: number, outM: number) =>
  inM > 100 && outM > 100 && Math.abs(inM - outM) / Math.max(inM, outM) < 0.02
const MAX_GAP_S  = 120   // a longer gap between polls is an outage, not traffic
const LAST_POLL_S = 60   // the newest poll covers about one minute

// All matching rows, in pages (one request returns at most 1000)
async function fetchAll<T>(
  db: SupabaseClient, table: string, columns: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filter: (q: any) => any,
): Promise<T[]> {
  const head = await filter(db.from(table).select('id', { count: 'exact', head: true }))
  const total: number = head.count ?? 0
  const pages = Math.ceil(total / 1000)
  const out: T[] = []
  for (let i = 0; i < pages; i += 8) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(8, pages - i) }, (_, k) =>
        filter(db.from(table).select(columns)).order('id').range((i + k) * 1000, (i + k) * 1000 + 999)),
    )
    for (const r of batch) if (r.data) out.push(...(r.data as T[]))
  }
  return out
}

export async function buildSnmpReport(db: SupabaseClient, period: ReportPeriod): Promise<SnmpReport> {
  const generatedAt = new Date().toISOString()
  const since = new Date(Date.now() - REPORT_PERIOD_MS[period]).toISOString()

  const { data: devs } = await db.from('devices').select('id, name, ip, type, status, cpu, mem, uptime').order('name')
  const snmp = ((devs ?? []) as DeviceRow[]).filter(answeredSnmp)
  if (!snmp.length) return { period, generatedAt, historyDays: UPTIME_HISTORY_DAYS, devices: [] }

  const [lat, traffic] = await Promise.all([
    fetchAll<{ device_id: string; status: string; sampled_at: string }>(
      db, 'latency_samples', 'device_id, status, sampled_at',
      q => q.in('device_id', snmp.map(d => d.id)).gte('sampled_at', since)),
    fetchAll<{ device_name: string; interface: string; in_mbps: number | string; out_mbps: number | string; sampled_at: string }>(
      db, 'traffic_samples', 'device_name, interface, in_mbps, out_mbps, sampled_at',
      q => q.in('device_name', snmp.map(d => d.name)).gte('sampled_at', since)),
  ])

  const devices = snmp.map<SnmpDeviceReport>(d => {
    // Uptime: minutes by measured status
    let upMin = 0, downMin = 0, unknownMin = 0
    let first: string | null = null
    for (const s of lat) {
      if (s.device_id !== d.id) continue
      if (s.status === 'up' || s.status === 'warn') upMin++
      else if (s.status === 'down' || s.status === 'unreachable') downMin++
      else unknownMin++
      if (!first || s.sampled_at < first) first = s.sampled_at
    }
    const measured = upMin + downMin

    // Traffic: interfaces summed per poll, then rate × time until the next poll
    const perPoll = new Map<string, { in: number; out: number }>()
    for (const s of traffic) {
      if (s.device_name !== d.name || isLoopback(s.interface)) continue
      const inM = Number(s.in_mbps) || 0, outM = Number(s.out_mbps) || 0
      if (isResetArtifact(inM, outM)) continue
      const p = perPoll.get(s.sampled_at) ?? { in: 0, out: 0 }
      p.in += inM
      p.out += outM
      perPoll.set(s.sampled_at, p)
    }
    const polls = [...perPoll.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    let inBytes = 0, outBytes = 0
    polls.forEach(([at, v], i) => {
      const next = polls[i + 1]
      const secs = next ? Math.min(MAX_GAP_S, (new Date(next[0]).getTime() - new Date(at).getTime()) / 1000) : LAST_POLL_S
      inBytes  += (v.in  * 1e6 / 8) * secs
      outBytes += (v.out * 1e6 / 8) * secs
    })
    const avg  = (k: 'in' | 'out') => polls.length ? polls.reduce((s, p) => s + p[1][k], 0) / polls.length : null
    const peak = (k: 'in' | 'out') => polls.length ? Math.max(...polls.map(p => p[1][k])) : null
    if (polls.length && (!first || polls[0][0] < first)) first = polls[0][0]

    return {
      id: d.id, name: d.name, ip: d.ip, type: d.type, status: d.status, cpu: d.cpu, mem: d.mem,
      upMin, downMin, unknownMin,
      uptimePct: measured ? Math.round((upMin / measured) * 1000) / 10 : null,
      inBytes: Math.round(inBytes), outBytes: Math.round(outBytes),
      avgInMbps: avg('in'), avgOutMbps: avg('out'), peakInMbps: peak('in'), peakOutMbps: peak('out'),
      firstSample: first,
    }
  })

  return { period, generatedAt, historyDays: UPTIME_HISTORY_DAYS, devices }
}
