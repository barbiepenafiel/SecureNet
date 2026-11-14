/**
 * Availability analytics and the daily report snapshot.
 *
 * Shared by the agent (poller/notify.js: daily report + email) and the
 * dashboard (app/api/reports/*). Everything is computed from what the agent
 * measured — latency_samples (one row per device per minute: status and
 * ping time) and the alerts table. Nothing is estimated from a device's
 * current status.
 *
 * Uses the SQL functions from supabase/migration_objectives.sql when they are
 * installed, and otherwise reads the rows in pages (slower, same result).
 */

const HISTORY_DAYS = 7          // latency_samples retention (poller/agent.js)
const PAGE = 1000
const MAX_FALLBACK_ROWS = 150_000

const LIVE = new Set(['up', 'warn'])
const DOWN = new Set(['down', 'unreachable'])

// All rows of a query, in pages (PostgREST returns at most 1000 per request)
async function fetchPaged(makeQuery, max = MAX_FALLBACK_ROWS) {
  const out = []
  for (let from = 0; from < max; from += PAGE * 4) {
    const pages = await Promise.all([0, 1, 2, 3].map(k =>
      makeQuery().order('id').range(from + k * PAGE, from + k * PAGE + PAGE - 1)))
    let done = false
    for (const { data, error } of pages) {
      if (error) throw new Error(error.message)
      out.push(...(data ?? []))
      if (!data || data.length < PAGE) done = true
    }
    if (done) break
  }
  return out
}

const pct = (up, down) => (up + down ? Math.round((up / (up + down)) * 1000) / 10 : null)

/**
 * Per-device availability since `sinceIso`.
 * → Map(device_id → { upMin, downMin, unknownMin, uptimePct, avgLatencyMs, firstSample })
 */
async function deviceAvailability(db, sinceIso) {
  const out = new Map()
  const { data, error } = await db.rpc('device_availability', { since: sinceIso })
  if (!error) {
    for (const r of data ?? []) {
      const up = Number(r.up_min) || 0, down = Number(r.down_min) || 0
      out.set(r.device_id, {
        upMin: up, downMin: down, unknownMin: Number(r.unknown_min) || 0,
        uptimePct: pct(up, down),
        avgLatencyMs: r.avg_latency_ms == null ? null : Number(r.avg_latency_ms),
        firstSample: r.first_sample,
      })
    }
    return out
  }
  // Function not installed yet — aggregate the rows here
  const rows = await fetchPaged(() => db.from('latency_samples')
    .select('id, device_id, status, latency_ms, sampled_at').gte('sampled_at', sinceIso))
  const acc = new Map()
  for (const r of rows) {
    if (!r.device_id) continue
    const a = acc.get(r.device_id) ?? { up: 0, down: 0, unk: 0, latSum: 0, latN: 0, first: null }
    if (LIVE.has(r.status)) a.up++
    else if (DOWN.has(r.status)) a.down++
    else a.unk++
    if (r.latency_ms != null) { a.latSum += r.latency_ms; a.latN++ }
    if (!a.first || r.sampled_at < a.first) a.first = r.sampled_at
    acc.set(r.device_id, a)
  }
  for (const [id, a] of acc) {
    out.set(id, {
      upMin: a.up, downMin: a.down, unknownMin: a.unk, uptimePct: pct(a.up, a.down),
      avgLatencyMs: a.latN ? Math.round((a.latSum / a.latN) * 10) / 10 : null,
      firstSample: a.first,
    })
  }
  return out
}

/**
 * Network latency over time since `sinceIso`, in steps of `bucketMin` minutes.
 * → [{ bucket, avgMs, minMs, maxMs, samples, offlineDevices }]
 */
async function latencyTrend(db, sinceIso, bucketMin) {
  const { data, error } = await db.rpc('latency_trend', { since: sinceIso, bucket_min: bucketMin })
  if (!error) {
    return (data ?? []).map(r => ({
      bucket: new Date(r.bucket).toISOString(),
      avgMs: r.avg_ms == null ? null : Number(r.avg_ms),
      minMs: r.min_ms, maxMs: r.max_ms,
      samples: Number(r.samples) || 0, offlineDevices: Number(r.offline_devices) || 0,
    }))
  }
  const rows = await fetchPaged(() => db.from('latency_samples')
    .select('id, device_id, status, latency_ms, sampled_at').gte('sampled_at', sinceIso))
  const step = bucketMin * 60_000
  const buckets = new Map()
  for (const r of rows) {
    const t = Math.floor(new Date(r.sampled_at).getTime() / step) * step
    const b = buckets.get(t) ?? { sum: 0, n: 0, min: null, max: null, down: new Set() }
    if (r.latency_ms != null) {
      b.sum += r.latency_ms; b.n++
      b.min = b.min == null ? r.latency_ms : Math.min(b.min, r.latency_ms)
      b.max = b.max == null ? r.latency_ms : Math.max(b.max, r.latency_ms)
    }
    if (r.status === 'down') b.down.add(r.device_id)
    buckets.set(t, b)
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, b]) => ({
    bucket: new Date(t).toISOString(),
    avgMs: b.n ? Math.round((b.sum / b.n) * 10) / 10 : null,
    minMs: b.min, maxMs: b.max, samples: b.n, offlineDevices: b.down.size,
  }))
}

const fmtDuration = ms => {
  const m = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  return d ? `${d}d ${h}h ${mm}m` : h ? `${h}h ${mm}m` : `${mm}m`
}

/**
 * Critical incidents raised since `sinceIso`, with how long each lasted.
 * → [{ id, title, device, ip, location, method, rootCause, startedAt, resolvedAt, durationMs, open }]
 */
async function incidents(db, sinceIso, limit = 200) {
  const { data } = await db.from('alerts')
    .select('id, title, meta, root_cause, created_at, resolved_at, device_name, device_ip, location, detection_method')
    .eq('severity', 'crit').gte('created_at', sinceIso)
    .order('created_at', { ascending: false }).limit(limit)
  const now = Date.now()
  return (data ?? []).map(a => {
    const start = new Date(a.created_at).getTime()
    const end = a.resolved_at ? new Date(a.resolved_at).getTime() : now
    return {
      id: a.id, title: a.title,
      device: a.device_name ?? null, ip: a.device_ip ?? a.meta?.match(/IP: ([\d.]+)/)?.[1] ?? null,
      location: a.location ?? null, method: a.detection_method ?? null, rootCause: a.root_cause,
      startedAt: a.created_at, resolvedAt: a.resolved_at, durationMs: end - start, open: !a.resolved_at,
    }
  })
}

/**
 * The report snapshot for the last 24 hours (row for report_snapshots).
 * → { row, incidents, availability }
 */
async function buildSnapshot(db, { auto = false, by = 'admin' } = {}) {
  const now = Date.now()
  const since = new Date(now - 86_400_000).toISOString()

  // Exact counts (a plain select is capped at 1000 rows)
  const countAlerts = q => q.then(r => r.count ?? 0)
  const head = () => db.from('alerts').select('id', { count: 'exact', head: true }).gte('created_at', since)
  const [{ data: devs }, total_alerts, crit_alerts, resolved_alerts, avail, inc] = await Promise.all([
    db.from('devices').select('id, name, ip, type, location, status'),
    countAlerts(head()),
    countAlerts(head().eq('severity', 'crit')),
    countAlerts(head().not('resolved_at', 'is', null)),
    deviceAvailability(db, since),
    incidents(db, since, 50),
  ])
  const devices = (devs ?? []).filter(d => d.status !== 'maint')
  const count = s => devices.filter(d => d.status === s).length

  // Availability: share of measured minutes each device was Online, averaged over devices
  const measured = devices.map(d => avail.get(d.id)).filter(a => a && a.uptimePct != null)
  const avg_uptime_pct = measured.length
    ? Math.round((measured.reduce((s, a) => s + a.uptimePct, 0) / measured.length) * 100) / 100
    : null
  const lat = devices.map(d => avail.get(d.id)?.avgLatencyMs).filter(v => v != null)
  const avg_latency_ms = lat.length ? Math.round((lat.reduce((s, v) => s + v, 0) / lat.length) * 100) / 100 : null

  const offline_count = count('down')

  // Least available devices of the day
  const worst = devices
    .map(d => ({ d, a: avail.get(d.id) }))
    .filter(x => x.a && x.a.uptimePct != null && x.a.downMin > 0)
    .sort((x, y) => x.a.uptimePct - y.a.uptimePct)
    .slice(0, 5)

  const top_issue = offline_count > 0 ? `${offline_count} device(s) offline now`
    : crit_alerts > 0 ? `${crit_alerts} critical alert(s) in last 24h`
    : 'No critical issues'

  const summary_text = [
    `Report generated: ${new Date(now).toLocaleString()}`,
    `Devices: ${devices.length} monitored · ${count('up')} online · ${count('warn')} warning · ${offline_count} offline · ${count('unknown') + count('unreachable')} not reachable from the agent`,
    `Alerts (24h): ${total_alerts} total · ${crit_alerts} critical · ${resolved_alerts} resolved`,
    avg_uptime_pct != null ? `Availability (24h, measured each minute): ${avg_uptime_pct}% average over ${measured.length} device(s)` : 'Availability: no measurements in the last 24h',
    avg_latency_ms != null ? `Average latency (24h): ${avg_latency_ms} ms` : null,
    worst.length ? `Least available: ${worst.map(x => `${x.d.name} ${x.a.uptimePct}% (down ${fmtDuration(x.a.downMin * 60_000)})`).join(', ')}` : null,
    inc.length ? `Critical incidents: ${inc.filter(i => !i.open).length} resolved, ${inc.filter(i => i.open).length} still open` : null,
    `Top issue: ${top_issue}`,
  ].filter(Boolean).join('\n')

  const row = {
    period_label: `${new Date(now).toISOString().slice(0, 10)} (${auto ? 'daily auto' : 'manual'})`,
    total_devices: devices.length,
    online_count: count('up'),
    offline_count,
    warn_count: count('warn'),
    total_alerts,
    crit_alerts,
    resolved_alerts,
    avg_uptime_pct,
    avg_latency_ms,
    top_issue,
    summary_text,
    generated_by: auto ? 'auto' : by,
  }
  return { row, incidents: inc, worst: worst.map(x => ({ name: x.d.name, ip: x.d.ip, uptimePct: x.a.uptimePct, downMin: x.a.downMin })) }
}

module.exports = { HISTORY_DAYS, deviceAvailability, latencyTrend, incidents, buildSnapshot, fmtDuration }
