import { createClient } from '@supabase/supabase-js'

function adminDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
}

export async function GET() {
  const db = adminDb()
  const { data, error } = await db.from('alert_config').select('*').limit(1).single()
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json(data)
}

export async function POST(req: Request) {
  const body = await req.json()
  const db = adminDb()

  const { data: existing } = await db.from('alert_config').select('id').limit(1).single()
  if (!existing) return Response.json({ error: 'alert_config table not found — run supabase/alert_enhancements.sql first' }, { status: 500 })

  const { error } = await db.from('alert_config').update({
    cpu_warn_pct:    body.cpu_warn_pct,
    cpu_crit_pct:    body.cpu_crit_pct,
    mem_warn_pct:    body.mem_warn_pct,
    mem_crit_pct:    body.mem_crit_pct,
    latency_warn_ms: body.latency_warn_ms,
    latency_crit_ms: body.latency_crit_ms,
    flap_threshold:  body.flap_threshold,
    grace_period_min: body.grace_period_min,
    updated_by:      body.updated_by ?? 'admin',
    updated_at:      new Date().toISOString(),
  }).eq('id', existing.id)

  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ ok: true })
}
