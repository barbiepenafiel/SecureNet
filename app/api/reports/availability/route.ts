import { createServerClient } from '@/lib/supabase'
import { getCurrentProfile } from '@/lib/auth-server'
import core from '@/poller/report-core'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Availability, latency trend and critical incidents for the Reports page,
// all measured by the agent (latency_samples: 1 row/device/minute, 7 days
// kept; alerts).
//   GET ?period=24h|7d|30d                 preset (up to now)
//   GET ?from=<ISO>&to=<ISO>               any date range (up to 92 days)
//   GET …&view=timeline[&device=<id>]      availability over time (one device, or the whole network)
const PERIODS = {
  '24h': { ms: 86_400_000,     bucketMin: 60 },
  '7d':  { ms: 604_800_000,    bucketMin: 360 },
  '30d': { ms: 2_592_000_000,  bucketMin: 1440 },
} as const
type Period = keyof typeof PERIODS
const MAX_RANGE_MS = 92 * 86_400_000

// Steps for the latency trend and the availability timeline (≤ ~170 steps)
function trendBucketMin(spanMs: number) {
  return spanMs <= 2 * 86_400_000 ? 60 : spanMs <= 8 * 86_400_000 ? 360 : 1440
}
function timelineBucketMin(spanMs: number) {
  const h = spanMs / 3_600_000
  return h <= 26 ? 15 : h <= 74 ? 30 : h <= 8 * 24 ? 60 : h <= 32 * 24 ? 360 : 1440
}

const CACHE_MS = 60_000
const g = globalThis as unknown as { __availCache?: Map<string, { at: number; data: unknown }> }
const cache = (g.__availCache ??= new Map())

export async function GET(req: Request) {
  if (!(await getCurrentProfile())) return Response.json({ error: 'Not signed in' }, { status: 401 })
  const q = new URL(req.url).searchParams
  const now = Date.now()

  // Range: a preset, or from/to (rounded to the minute; `to` never past now)
  let period: Period | 'custom'
  let fromMs: number, toMs: number
  if (q.get('from')) {
    fromMs = Date.parse(q.get('from')!)
    toMs = q.get('to') ? Math.min(Date.parse(q.get('to')!), now) : now
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      return Response.json({ error: 'from must be a date before to' }, { status: 400 })
    }
    if (toMs - fromMs > MAX_RANGE_MS) return Response.json({ error: 'The range can be at most 92 days' }, { status: 400 })
    period = 'custom'
  } else {
    const p = q.get('period') ?? '24h'
    if (!(p in PERIODS)) return Response.json({ error: 'period must be 24h, 7d or 30d' }, { status: 400 })
    period = p as Period
    toMs = now
    fromMs = now - PERIODS[period].ms
  }
  fromMs = Math.floor(fromMs / 60_000) * 60_000
  toMs = Math.ceil(toMs / 60_000) * 60_000
  const from = new Date(fromMs).toISOString()
  const to = new Date(toMs).toISOString()
  const view = q.get('view')
  const device = q.get('device') || null
  if (device && !/^[0-9a-f-]{36}$/i.test(device)) return Response.json({ error: 'device must be a device id' }, { status: 400 })

  const key = `${view ?? 'summary'}|${period}|${period === 'custom' ? `${from}|${to}` : ''}|${device ?? ''}`
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_MS) return Response.json(hit.data)

  try {
    const db = createServerClient()
    // Minute-by-minute history only goes back HISTORY_DAYS
    const keptSince = now - core.HISTORY_DAYS * 86_400_000
    const measuredSince = new Date(Math.max(fromMs, keptSince)).toISOString()

    if (view === 'timeline') {
      const bucketMin = timelineBucketMin(toMs - fromMs)
      const timeline = await core.availabilityTimeline(db, from, to, bucketMin, device)
      const data = { period, from, to, bucketMin, device, historyDays: core.HISTORY_DAYS, measuredSince, timeline }
      cache.set(key, { at: now, data })
      return Response.json(data)
    }

    const bucketMin = period === 'custom' ? trendBucketMin(toMs - fromMs) : PERIODS[period].bucketMin
    const [avail, trend, incidents] = await Promise.all([
      core.deviceAvailabilityRange(db, measuredSince, to),
      core.latencyTrend(db, measuredSince, bucketMin),
      core.incidents(db, from, 500),
    ])
    const data = {
      period, from, to, generatedAt: new Date(now).toISOString(), historyDays: core.HISTORY_DAYS,
      measuredSince,
      periodMin: Math.round((toMs - fromMs) / 60_000),
      measurableMin: Math.max(0, Math.round((toMs - Math.max(fromMs, keptSince)) / 60_000)),
      devices: Object.fromEntries(avail),
      // The trend function runs to now; keep only steps inside the range
      trend: trend.filter((t: { bucket: string }) => Date.parse(t.bucket) < toMs),
      // Critical incidents up to `to` (the Reports page now pages them itself)
      incidents: incidents.filter((i: { startedAt: string }) => Date.parse(i.startedAt) < toMs),
    }
    cache.set(key, { at: now, data })
    return Response.json(data)
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 })
  }
}
