import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

// Track last auto-generate time to avoid duplicate daily reports
let _lastGenerated: number | null = null

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

// POST — generate a report snapshot from current live data
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const isAuto: boolean = body.auto ?? false

  // For auto-reports: skip if already generated within the last 23 hours
  if (isAuto && _lastGenerated && Date.now() - _lastGenerated < 23 * 60 * 60 * 1000) {
    return Response.json({ skipped: true, reason: 'Already generated within 23h' })
  }

  const db = adminDb()

  const [devRes, alertRes, slaRes, scanRes, discRes] = await Promise.allSettled([
    db.from('devices').select('id, name, status, cpu').order('name'),
    db.from('alerts').select('id, severity, acked, created_at, resolved_at').order('created_at', { ascending: false }).limit(500),
    db.from('sla_data').select('uptime_pct'),
    db.from('scan_results').select('latency_ms, responded').gte('scanned_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).limit(1000),
    db.from('scan_results').select('ip').gte('scanned_at', new Date(Date.now() - 60 * 60 * 1000).toISOString()),
  ])

  const devices   = devRes.status  === 'fulfilled' ? (devRes.value.data  ?? []) : []
  const allAlerts = alertRes.status === 'fulfilled' ? (alertRes.value.data ?? []) : []
  const sla       = slaRes.status   === 'fulfilled' ? (slaRes.value.data  ?? []) : []
  const scans     = scanRes.status  === 'fulfilled' ? (scanRes.value.data  ?? []) : []

  // Count discovered (ICMP/ARP) devices not in managed devices table
  const managedIpSet = new Set(devices.map((d: { name: string }) => d.name))
  const discRows = discRes.status === 'fulfilled' ? (discRes.value.data ?? []) : []
  const discoveredIps = new Set(discRows.map((r: { ip: string }) => r.ip))
  managedIpSet.forEach((_: unknown, ip: unknown) => discoveredIps.delete(ip as string))
  const discovered_count = discoveredIps.size

  const total_devices  = devices.length + discovered_count
  const online_count   = devices.filter((d: { status: string }) => d.status === 'up').length
  const offline_count  = devices.filter((d: { status: string }) => d.status === 'down').length
  const warn_count     = devices.filter((d: { status: string }) => d.status === 'warn').length

  // 24h alerts
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const recent    = allAlerts.filter((a: { created_at: string }) => new Date(a.created_at) >= cutoff24h)
  const total_alerts    = recent.length
  const crit_alerts     = recent.filter((a: { severity: string }) => a.severity === 'crit').length
  const resolved_alerts = recent.filter((a: { resolved_at: string | null }) => !!a.resolved_at).length

  const avg_uptime_pct = sla.length
    ? parseFloat((sla.reduce((s: number, r: { uptime_pct: number }) => s + Number(r.uptime_pct), 0) / sla.length).toFixed(2))
    : (total_devices ? parseFloat((online_count / total_devices * 100).toFixed(2)) : null)

  // Real average latency from scan_results
  const latencies = scans.filter((s: { responded: boolean; latency_ms: number | null }) => s.responded && s.latency_ms != null).map((s: { latency_ms: number }) => s.latency_ms)
  const avg_latency_ms = latencies.length
    ? parseFloat((latencies.reduce((a: number, b: number) => a + b, 0) / latencies.length).toFixed(2))
    : null

  const top_issue = offline_count > 0
    ? `${offline_count} device(s) offline`
    : crit_alerts > 0
      ? `${crit_alerts} critical alert(s) in last 24h`
      : 'No critical issues'

  const summary_text = [
    `Report generated: ${new Date().toLocaleString()}`,
    `Devices: ${total_devices} total (${devices.length} managed · ${discovered_count} discovered) · ${online_count} online · ${offline_count} offline · ${warn_count} warning`,
    `Alerts (24h): ${total_alerts} total · ${crit_alerts} critical · ${resolved_alerts} resolved`,
    avg_uptime_pct != null ? `Avg uptime: ${avg_uptime_pct}%` : null,
    avg_latency_ms != null ? `Avg latency: ${avg_latency_ms} ms (from ${latencies.length} ping samples)` : null,
    `Top issue: ${top_issue}`,
  ].filter(Boolean).join('\n')

  const period_label = `${new Date().toISOString().slice(0, 10)} (${isAuto ? 'daily auto' : 'manual'})`

  try {
    const { data: snapshot, error } = await db.from('report_snapshots').insert({
      period_label,
      total_devices,
      online_count,
      offline_count,
      warn_count,
      total_alerts,
      crit_alerts,
      resolved_alerts,
      avg_uptime_pct,
      avg_latency_ms,
      top_issue,
      summary_text,
      generated_by: isAuto ? 'auto' : (body.generated_by ?? 'admin'),
    }).select().single()

    if (error) return Response.json({ error: error.message }, { status: 500 })

    if (isAuto) _lastGenerated = Date.now()

    return Response.json({ snapshot })
  } catch (err: unknown) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
