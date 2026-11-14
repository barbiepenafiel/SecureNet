/**
 * Email notifications and the daily report — run by the agent, so they work
 * with no dashboard open.
 *
 *  • A device that is offline / not responding is emailed only after it has
 *    stayed that way for OFFLINE_EMAIL_DELAY_MIN (default 45) minutes; if it
 *    comes back sooner there is no email. Other critical alerts (CPU, memory)
 *    and warnings (for recipients who want them) are emailed within ~20 s.
 *    Each alert is claimed in the database (alerts.emailed_at) before
 *    sending, so it is never emailed twice.
 *  • When an emailed critical incident is resolved, an incident report
 *    (what failed, when, for how long, how it was detected) is emailed.
 *  • Once a day (from REPORT_HOUR, local time) a report snapshot is saved to
 *    report_snapshots and emailed to recipients with "daily report" on.
 *
 * Settings (poller/.env or the project .env):
 *   SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS, SMTP_FROM (= SMTP_USER)
 *   SMTP_TO       fallback recipients (comma-separated) when none are set in
 *                 Settings → Email Notifications
 *   REPORT_HOUR   hour of the day for the daily report (default 7)
 *   OFFLINE_EMAIL_DELAY_MIN  minutes offline before an email (default 45, 0 = at once)
 * Recipients: notification_recipients (supabase/migration_objectives.sql).
 */

const nodemailer = require('nodemailer')
const core = require('./report-core')

const LOOP_MS = 20_000
const NEW_ALERT_WINDOW_MS = 30 * 60_000    // never email alerts older than this (e.g. after the migration)
// A device must stay offline / not responding this long before it is emailed
const OFFLINE_EMAIL_DELAY_MS = Math.max(0, parseInt(process.env.OFFLINE_EMAIL_DELAY_MIN ?? '45', 10) || 0) * 60_000
const REPORT_HOUR = Math.min(23, Math.max(0, parseInt(process.env.REPORT_HOUR ?? '7', 10) || 0))

let db = null
let transport = null
let warnedNoSmtp = false
let columnsOk = true
let retryAt = 0
let failBackoffUntil = 0

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function smtp() {
  if (transport) return transport
  const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASS: pass } = process.env
  if (!host || !user || !pass) return null
  const port = parseInt(process.env.SMTP_PORT ?? '587', 10)
  transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } })
  return transport
}
const fromAddr = () => `"SecureNet Alerts" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`

// → [{ email, min_severity, daily_report }]
async function recipients() {
  const { data, error } = await db.from('notification_recipients').select('email, min_severity, daily_report').eq('enabled', true)
  if (!error && data?.length) return data
  // No recipients table / none set: SMTP_TO receives critical alerts and the daily report
  return (process.env.SMTP_TO ?? '').split(',').map(s => s.trim()).filter(Boolean)
    .map(email => ({ email, min_severity: 'crit', daily_report: true }))
}

async function send(to, subject, html) {
  await smtp().sendMail({ from: fromAddr(), to: to.join(', '), subject, html })
}

// ── Email templates ──────────────────────────────────────────────────────────
const SEV = { crit: ['#dc2626', 'CRITICAL'], warn: ['#d97706', 'WARNING'], info: ['#2563eb', 'INFO'] }
const shell = (title, subtitle, body) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:system-ui,Segoe UI,sans-serif;color:#0f172a">
<div style="max-width:680px;margin:24px auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
  <div style="background:#064e3b;padding:20px 24px;color:#fff">
    <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.7">SmartCampus SecureNet</div>
    <div style="font-size:20px;font-weight:700;margin-top:4px">${esc(title)}</div>
    <div style="font-size:13px;opacity:.8;margin-top:2px">${esc(subtitle)}</div>
  </div>
  <div style="padding:20px 24px">${body}</div>
  <div style="padding:12px 24px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b">Sent automatically by the SecureNet monitoring agent. Sign in to the dashboard to acknowledge or resolve alerts.</div>
</div></body></html>`

const kv = rows => `<table style="border-collapse:collapse;width:100%;font-size:13px">${rows.filter(r => r[1] != null && r[1] !== '').map(([k, v]) =>
  `<tr><td style="padding:5px 0;color:#64748b;width:150px;vertical-align:top">${esc(k)}</td><td style="padding:5px 0">${esc(v)}</td></tr>`).join('')}</table>`

function alertsHtml(alerts) {
  const blocks = alerts.map(a => {
    const [color, label] = SEV[a.severity] ?? SEV.info
    return `<div style="border:1px solid #e2e8f0;border-left:4px solid ${color};border-radius:8px;padding:12px 14px;margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;color:${color}">${label}</div>
      <div style="font-size:15px;font-weight:700;margin:2px 0 8px">${esc(a.title)}</div>
      ${kv([['Device', a.device_name], ['IP address', a.device_ip], ['Location', a.location], ['Detected by', a.detection_method],
        ['Time', new Date(a.created_at).toLocaleString()],
        ['Offline for', a.status === 'offline' && !a.resolved_at ? `${core.fmtDuration(Date.now() - new Date(a.created_at).getTime())} and still not responding` : null],
        ['Cause', a.root_cause], ['Details', a.device_name ? null : a.meta]])}
    </div>`
  }).join('')
  const crit = alerts.filter(a => a.severity === 'crit').length
  return shell('Network alert', `${crit} critical · ${alerts.length - crit} warning`, blocks)
}

function resolvedHtml(a) {
  const ms = new Date(a.resolved_at).getTime() - new Date(a.created_at).getTime()
  return shell('Incident resolved', a.title, `
    <div style="font-size:14px;margin-bottom:12px">The incident below has ended. Total duration: <strong>${esc(core.fmtDuration(ms))}</strong>.</div>
    ${kv([['Incident', a.title], ['Device', a.device_name], ['IP address', a.device_ip], ['Location', a.location],
      ['Started', new Date(a.created_at).toLocaleString()], ['Resolved', new Date(a.resolved_at).toLocaleString()],
      ['Duration', core.fmtDuration(ms)], ['Detected by', a.detection_method], ['Cause', a.root_cause],
      ['Resolved by', a.resolved_by], ['Resolution', a.resolution_notes]])}`)
}

function reportHtml(snap, extra) {
  const lines = String(snap.summary_text ?? '').split('\n').map(l => `<li style="margin:3px 0">${esc(l)}</li>`).join('')
  const inc = (extra?.incidents ?? []).slice(0, 15)
  const incRows = inc.map(i => `<tr>
      <td style="padding:6px 8px;border-top:1px solid #e2e8f0">${esc(i.device ?? i.title)}</td>
      <td style="padding:6px 8px;border-top:1px solid #e2e8f0;font-family:monospace">${esc(i.ip ?? '—')}</td>
      <td style="padding:6px 8px;border-top:1px solid #e2e8f0">${esc(new Date(i.startedAt).toLocaleString())}</td>
      <td style="padding:6px 8px;border-top:1px solid #e2e8f0">${i.open ? '<strong style="color:#dc2626">still open</strong>' : esc(core.fmtDuration(i.durationMs))}</td></tr>`).join('')
  return shell('Daily network report', snap.period_label, `
    ${kv([['Devices monitored', snap.total_devices], ['Online / warning / offline', `${snap.online_count} / ${snap.warn_count} / ${snap.offline_count}`],
      ['Availability (24h)', snap.avg_uptime_pct != null ? `${snap.avg_uptime_pct}%` : 'not measured'],
      ['Average latency (24h)', snap.avg_latency_ms != null ? `${snap.avg_latency_ms} ms` : 'not measured'],
      ['Alerts (24h)', `${snap.total_alerts} total · ${snap.crit_alerts} critical · ${snap.resolved_alerts} resolved`],
      ['Top issue', snap.top_issue]])}
    <div style="font-weight:700;margin:16px 0 6px">Summary</div><ul style="margin:0;padding-left:18px;font-size:13px">${lines}</ul>
    ${inc.length ? `<div style="font-weight:700;margin:16px 0 6px">Critical incidents (last 24h)</div>
      <table style="border-collapse:collapse;width:100%;font-size:12px"><tr style="color:#64748b;text-align:left">
      <th style="padding:6px 8px">Device</th><th style="padding:6px 8px">IP</th><th style="padding:6px 8px">Started</th><th style="padding:6px 8px">Duration</th></tr>${incRows}</table>` : ''}`)
}

// ── Jobs ─────────────────────────────────────────────────────────────────────
const ALERT_COLS = 'id, severity, title, meta, root_cause, created_at, resolved_at, resolved_by, resolution_notes, device_name, device_ip, location, detection_method, status'

function columnsMissing(error) {
  if (!error || !/emailed_at|column|schema cache/i.test(error.message)) return false
  if (columnsOk) console.log('  [email] run supabase/migration_objectives.sql to enable email notifications (retrying every 5 min)')
  columnsOk = false
  retryAt = Date.now() + 5 * 60_000
  return true
}

async function emailNewAlerts(list) {
  const now = Date.now()
  const iso = ms => new Date(ms).toISOString()
  const stamp = { emailed_at: iso(now) }
  // Claim the alerts first so a second process can never send them again.
  //  • Offline / not responding: only once the device has stayed offline for
  //    OFFLINE_EMAIL_DELAY (the alert is still open). One that comes back
  //    sooner is never emailed (and so gets no "resolved" email either).
  //  • Everything else (CPU / memory critical, warnings): right away.
  const [offline, other] = await Promise.all([
    db.from('alerts').update(stamp)
      .is('emailed_at', null).eq('status', 'offline').eq('suppressed', false).is('resolved_at', null)
      .lte('created_at', iso(now - OFFLINE_EMAIL_DELAY_MS))
      .gte('created_at', iso(now - OFFLINE_EMAIL_DELAY_MS - NEW_ALERT_WINDOW_MS))
      .select(ALERT_COLS),
    db.from('alerts').update(stamp)
      .is('emailed_at', null).in('severity', ['crit', 'warn']).eq('suppressed', false)
      .or('status.is.null,status.neq.offline')
      .gte('created_at', iso(now - NEW_ALERT_WINDOW_MS))
      .select(ALERT_COLS),
  ])
  if (columnsMissing(offline.error) || columnsMissing(other.error)) return
  const claimed = [...(offline.data ?? []), ...(other.data ?? [])]
  if (!claimed.length) return
  claimed.sort((a, b) => a.created_at.localeCompare(b.created_at))

  const crit = claimed.filter(a => a.severity === 'crit')
  const groups = [
    { to: list.map(r => r.email), alerts: crit },                                                 // everyone gets critical
    { to: list.filter(r => r.min_severity === 'warn').map(r => r.email), alerts: claimed.filter(a => a.severity === 'warn') },
  ]
  // Recipients of warnings get one email with both kinds
  const both = new Set(groups[1].to)
  try {
    let emails = 0, people = 0
    if (both.size && claimed.length) {
      await send([...both], `[SecureNet] ${crit.length} critical · ${claimed.length - crit.length} warning`, alertsHtml(claimed))
      emails++; people += both.size
    }
    const critOnly = groups[0].to.filter(e => !both.has(e))
    if (critOnly.length && crit.length) {
      await send(critOnly, `[SecureNet] ${crit.length === 1 ? crit[0].title : `${crit.length} critical alerts`}`, alertsHtml(crit))
      emails++; people += critOnly.length
    }
    // Alerts nobody asked for (e.g. warnings when every recipient is "critical only") are just marked
    if (emails) console.log(`  [email] sent ${emails} email(s) to ${people} recipient(s) about ${claimed.length} alert(s)`)
  } catch (e) {
    // Release the claim so the next round tries again
    await db.from('alerts').update({ emailed_at: null }).in('id', claimed.map(a => a.id))
    throw e
  }
}

async function emailResolutions(list) {
  const since = new Date(Date.now() - 6 * 3600_000).toISOString()
  const { data: claimed, error } = await db.from('alerts')
    .update({ resolution_emailed_at: new Date().toISOString() })
    .eq('severity', 'crit').not('emailed_at', 'is', null).not('resolved_at', 'is', null)
    .is('resolution_emailed_at', null).gte('resolved_at', since)
    .select(ALERT_COLS)
  if (columnsMissing(error) || !claimed?.length) return
  try {
    for (const a of claimed) await send(list.map(r => r.email), `[SecureNet] Resolved: ${a.title}`, resolvedHtml(a))
    console.log(`  [email] sent ${claimed.length} incident report(s)`)
  } catch (e) {
    await db.from('alerts').update({ resolution_emailed_at: null }).in('id', claimed.map(a => a.id))
    throw e
  }
}

// The daily snapshot is made here even without email, so it never depends on an open tab
let reportCheckedAt = 0
async function dailyReport(list) {
  if (Date.now() - reportCheckedAt < 5 * 60_000) return
  reportCheckedAt = Date.now()
  if (new Date().getHours() < REPORT_HOUR) return

  const since = new Date(Date.now() - 23 * 3600_000).toISOString()
  const { data: recent, error } = await db.from('report_snapshots').select('*')
    .eq('generated_by', 'auto').gte('generated_at', since).order('generated_at', { ascending: false }).limit(1)
  if (error) return                                         // report_snapshots.sql not run
  let snap = recent?.[0]
  let extra = null
  if (!snap) {
    const built = await core.buildSnapshot(db, { auto: true })
    const { data, error: e } = await db.from('report_snapshots').insert(built.row).select().single()
    if (e) { console.log(`  [report] could not save the daily report: ${e.message}`); return }
    snap = data
    extra = built
    console.log(`  [report] daily report saved: ${snap.period_label}`)
  }
  // Deliver it (emailed_at is NULL until sent)
  if (!smtp() || ('emailed_at' in snap && snap.emailed_at)) return
  if (!('emailed_at' in snap)) return                       // migration not run: can't track delivery
  const to = list.filter(r => r.daily_report).map(r => r.email)
  if (!to.length) return
  const { data: claim } = await db.from('report_snapshots').update({ emailed_at: new Date().toISOString(), emailed_to: to.join(', ') })
    .eq('id', snap.id).is('emailed_at', null).select('id')
  if (!claim?.length) return
  try {
    extra ??= { incidents: await core.incidents(db, new Date(new Date(snap.generated_at).getTime() - 86_400_000).toISOString(), 15) }
    await send(to, `[SecureNet] Daily network report — ${snap.period_label}`, reportHtml(snap, extra))
    console.log(`  [report] daily report emailed to ${to.length} recipient(s)`)
  } catch (e) {
    await db.from('report_snapshots').update({ emailed_at: null, emailed_to: null }).eq('id', snap.id)
    throw e
  }
}

// What Settings shows about email (agent_status.email_status), written on change
let statusWritten = null
async function writeStatus(list) {
  const t = smtp()
  const s = !t ? 'off: SMTP_HOST, SMTP_USER and SMTP_PASS are not set on the agent'
    : `on: ${process.env.SMTP_USER} via ${process.env.SMTP_HOST}:${process.env.SMTP_PORT ?? 587} · ${list.length} recipient(s)`
  if (s === statusWritten) return
  const { error } = await db.from('agent_status').update({ email_status: s }).eq('id', require('os').hostname())
  if (!error) statusWritten = s
}

// Settings → "Send Test Email" (an agent job): a real email with the alerts open right now
async function sendTest() {
  if (!smtp()) throw new Error('Email is off on the agent — set SMTP_HOST, SMTP_USER and SMTP_PASS in its .env and restart it')
  const list = await recipients()
  if (!list.length) throw new Error('No recipients — add one under Settings → Email Notifications (or set SMTP_TO)')
  const { data: open } = await db.from('alerts').select(ALERT_COLS)
    .in('severity', ['crit', 'warn']).is('resolved_at', null).eq('suppressed', false)
    .order('created_at', { ascending: false }).limit(10)
  const body = open?.length ? alertsHtml(open)
    : shell('Test email', 'Email notifications are working', '<div style="font-size:14px">No open critical or warning alerts right now.</div>')
  await send(list.map(r => r.email), '[SecureNet] Test email — notifications are working', body)
  return { sent: open?.length ?? 0, to: list.map(r => r.email).join(', ') }
}

async function tick() {
  const list = await recipients()
  await writeStatus(list).catch(() => {})
  await dailyReport(list).catch(e => console.log(`  [report] ${e.message}`))

  if (!smtp()) {
    if (!warnedNoSmtp) console.log('  [email] off — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env to email alerts and reports')
    warnedNoSmtp = true
    return
  }
  if (!list.length || Date.now() < failBackoffUntil) return
  if (!columnsOk && Date.now() < retryAt) return
  columnsOk = true
  try {
    await emailNewAlerts(list)
    await emailResolutions(list)
  } catch (e) {
    console.log(`  [email] sending failed: ${e.message} — retrying in 5 min`)
    failBackoffUntil = Date.now() + 5 * 60_000
  }
}

function start(supabase, isActive = () => true) {
  db = supabase
  const loop = async () => {
    try { if (isActive()) await tick() } catch (e) { console.log(`  [email] ${e.message}`) }
    setTimeout(loop, LOOP_MS)
  }
  setTimeout(loop, 5_000)
}

module.exports = { start, sendTest, alertsHtml, resolvedHtml, reportHtml, smtp }
