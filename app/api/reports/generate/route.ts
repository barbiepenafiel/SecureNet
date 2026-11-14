import { createClient } from '@supabase/supabase-js'
import core from '@/poller/report-core'

export const runtime = 'nodejs'

// Report snapshots. The daily one is made by the agent (poller/notify.js),
// which also emails it; this route lists snapshots and makes one on demand.
// Both use the same builder (poller/report-core.js): availability and
// latency measured each minute, exact alert counts — nothing estimated.

function adminDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
}

// GET — list saved report snapshots
export async function GET() {
  const db = adminDb()
  try {
    const { data, error } = await db
      .from('report_snapshots')
      .select('*')
      .order('generated_at', { ascending: false })
      .limit(90)
    if (error) return Response.json({ error: error.message, snapshots: [] }, { status: 500 })
    return Response.json({ snapshots: data ?? [] })
  } catch {
    return Response.json({ snapshots: [] })
  }
}

// POST — generate a report snapshot now from the measured data
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const isAuto: boolean = body.auto ?? false
  const db = adminDb()

  // At most one automatic snapshot per 23 hours
  if (isAuto) {
    const { data: recent } = await db.from('report_snapshots').select('generated_at')
      .eq('generated_by', 'auto').gte('generated_at', new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString()).limit(1)
    if (recent?.length) return Response.json({ skipped: true, reason: 'Already generated within 23h' })
  }

  try {
    const { row } = await core.buildSnapshot(db, { auto: isAuto, by: String(body.generated_by ?? 'admin').slice(0, 80) })
    const { data: snapshot, error } = await db.from('report_snapshots').insert(row).select().single()
    if (error) return Response.json({ error: error.message }, { status: 500 })
    return Response.json({ snapshot })
  } catch (err: unknown) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
