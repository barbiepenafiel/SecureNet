import { createServerClient } from '@/lib/supabase'
import { getCurrentProfile } from '@/lib/auth-server'
import { buildSnmpReport, REPORT_PERIOD_MS, type ReportPeriod, type SnmpReport } from '@/lib/snmp-report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Results are reused for 60 s — the Reports page polls, history changes once a minute
const CACHE_MS = 60_000
const g = globalThis as unknown as { __snmpReportCache?: Map<ReportPeriod, { at: number; data: SnmpReport }> }
const cache = (g.__snmpReportCache ??= new Map())

// SNMP device uptime and traffic for the Reports page. GET ?period=24h|7d|30d
export async function GET(req: Request) {
  if (!(await getCurrentProfile())) return Response.json({ error: 'Not signed in' }, { status: 401 })

  const p = new URL(req.url).searchParams.get('period') ?? '24h'
  if (!(p in REPORT_PERIOD_MS)) return Response.json({ error: 'period must be 24h, 7d or 30d' }, { status: 400 })
  const period = p as ReportPeriod

  const hit = cache.get(period)
  if (hit && Date.now() - hit.at < CACHE_MS) return Response.json(hit.data)

  try {
    const data = await buildSnmpReport(createServerClient(), period)
    cache.set(period, { at: Date.now(), data })
    return Response.json(data)
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 })
  }
}
