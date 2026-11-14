import { createServerClient } from '@/lib/supabase'
import { getCurrentProfile } from '@/lib/auth-server'
import core from '@/poller/report-core'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Availability, latency trend and critical incidents for the Reports page,
// all measured by the agent (latency_samples: 1 row/device/minute, 7 days
// kept; alerts). GET ?period=24h|7d|30d
const PERIODS = {
  '24h': { ms: 86_400_000,     bucketMin: 60 },
  '7d':  { ms: 604_800_000,    bucketMin: 360 },
  '30d': { ms: 2_592_000_000,  bucketMin: 1440 },
} as const
type Period = keyof typeof PERIODS

const CACHE_MS = 60_000
const g = globalThis as unknown as { __availCache?: Map<string, { at: number; data: unknown }> }
const cache = (g.__availCache ??= new Map())

export async function GET(req: Request) {
  if (!(await getCurrentProfile())) return Response.json({ error: 'Not signed in' }, { status: 401 })
  const p = new URL(req.url).searchParams.get('period') ?? '24h'
  if (!(p in PERIODS)) return Response.json({ error: 'period must be 24h, 7d or 30d' }, { status: 400 })
  const period = p as Period

  const hit = cache.get(period)
  if (hit && Date.now() - hit.at < CACHE_MS) return Response.json(hit.data)

  try {
    const db = createServerClient()
    const now = Date.now()
    const since = new Date(now - PERIODS[period].ms).toISOString()
    // Minute-by-minute history only goes back HISTORY_DAYS
    const measuredSince = new Date(now - Math.min(PERIODS[period].ms, core.HISTORY_DAYS * 86_400_000)).toISOString()
    const [avail, trend, incidents] = await Promise.all([
      core.deviceAvailability(db, measuredSince),
      core.latencyTrend(db, measuredSince, PERIODS[period].bucketMin),
      core.incidents(db, since, 500),
    ])
    const data = {
      period, generatedAt: new Date(now).toISOString(), historyDays: core.HISTORY_DAYS,
      measuredSince,
      devices: Object.fromEntries(avail),
      trend, incidents,
    }
    cache.set(period, { at: now, data })
    return Response.json(data)
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 })
  }
}
