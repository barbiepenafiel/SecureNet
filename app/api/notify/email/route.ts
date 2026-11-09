import { NextRequest } from 'next/server'
import nodemailer from 'nodemailer'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

// In-memory dedup: alert id → last emailed timestamp
const emailedAlerts = new Map<string, number>()
const EMAIL_COOLDOWN_MS = 30 * 60 * 1000 // 30 min cooldown per alert

function adminDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
}

function smtpTransport() {
  const host = process.env.SMTP_HOST
  const port = parseInt(process.env.SMTP_PORT ?? '587')
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS

  if (!host || !user || !pass) return null

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  })
}

function alertHtml(alerts: Array<{ id: number; title: string; meta: string; severity: string; created_at: string }>) {
  const sevColor: Record<string, string> = { crit: '#f85149', warn: '#d29922', info: '#2f81f7' }
  const rows = alerts.map(a => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #30363d;">
        <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${sevColor[a.severity] ?? '#6e7681'}22;color:${sevColor[a.severity] ?? '#6e7681'}">
          ${a.severity.toUpperCase()}
        </span>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #30363d;font-weight:600;color:#e6edf3">${a.title}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #30363d;font-size:12px;color:#8b949e">${a.meta}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #30363d;font-size:11px;color:#8b949e">${new Date(a.created_at).toLocaleString()}</td>
    </tr>
  `).join('')

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>SecureNet Alert</title></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:system-ui,sans-serif;color:#e6edf3;">
  <div style="max-width:640px;margin:32px auto;border:1px solid #30363d;border-radius:12px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#161b22,#1f2937);padding:24px 28px;border-bottom:1px solid #30363d;">
      <div style="font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">SmartCampus SecureNet</div>
      <div style="font-size:22px;font-weight:700;color:#f85149">🔴 Network Alert Notification</div>
      <div style="font-size:13px;color:#8b949e;margin-top:4px">Urgent network incidents require your attention</div>
    </div>
    <div style="padding:20px 28px;">
      <table style="width:100%;border-collapse:collapse;border:1px solid #30363d;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#161b22;">
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.06em">Severity</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.06em">Alert</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.06em">Details</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.06em">Time</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="padding:16px 28px;border-top:1px solid #30363d;background:#161b22;font-size:12px;color:#8b949e;">
      This notification was sent by SmartCampus SecureNet. Log in to acknowledge or resolve these alerts.
    </div>
  </div>
</body>
</html>`
}

// POST — send email for one or more unacked critical alerts
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))

  const transport = smtpTransport()
  if (!transport) {
    return Response.json({ error: 'SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env.local' }, { status: 503 })
  }

  const recipients: string = body.to ?? process.env.SMTP_TO ?? process.env.SMTP_USER ?? ''
  if (!recipients) {
    return Response.json({ error: 'No recipient — set SMTP_TO in .env.local' }, { status: 400 })
  }

  // If specific alert IDs provided, use those; otherwise query recent unacked crits
  let alerts: Array<{ id: number; title: string; meta: string; severity: string; created_at: string }> = []

  if (body.alerts?.length) {
    alerts = body.alerts
  } else {
    const db = adminDb()
    const { data } = await db
      .from('alerts')
      .select('id, title, meta, severity, created_at')
      .eq('acked', false)
      .eq('suppressed', false)
      .in('severity', ['crit', 'warn'])
      .order('created_at', { ascending: false })
      .limit(10)
    alerts = data ?? []
  }

  // Dedup: skip alerts emailed within cooldown window
  const toSend = alerts.filter(a => {
    const key = String(a.id)
    const last = emailedAlerts.get(key) ?? 0
    return Date.now() - last > EMAIL_COOLDOWN_MS
  })

  if (toSend.length === 0) {
    return Response.json({ sent: 0, reason: 'All alerts within cooldown window — no duplicate emails sent' })
  }

  try {
    await transport.sendMail({
      from: `"SecureNet Alerts" <${process.env.SMTP_USER}>`,
      to: recipients,
      subject: `[SecureNet] ${toSend.filter(a => a.severity === 'crit').length} Critical · ${toSend.length} Total Active Alerts`,
      html: alertHtml(toSend),
    })

    // Mark all as emailed
    toSend.forEach(a => emailedAlerts.set(String(a.id), Date.now()))

    return Response.json({ sent: toSend.length, to: recipients })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `SMTP send failed: ${msg}` }, { status: 500 })
  }
}

// GET — return SMTP configuration status (no secrets)
export async function GET() {
  const configured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
  return Response.json({
    configured,
    host:   process.env.SMTP_HOST ?? null,
    port:   process.env.SMTP_PORT ?? '587',
    user:   process.env.SMTP_USER ?? null,
    to:     process.env.SMTP_TO ?? null,
    cooldown_min: EMAIL_COOLDOWN_MS / 60000,
  })
}
