import { createServerClient } from '@/lib/supabase'
import { requirePermission } from '@/lib/auth-server'
import { agentOnline, runAgentJob } from '@/lib/agent-jobs'

export const runtime = 'nodejs'

// Email notifications are sent by the monitoring agent (poller/notify.js),
// which holds the SMTP settings in its own .env — so they work with no
// dashboard open, and the hosted dashboard never needs mail credentials.
// Recipients: notification_recipients (Settings → Email Notifications).

// GET — is email set up on the agent? (no secrets)
export async function GET() {
  const gate = await requirePermission()
  if (gate instanceof Response) return gate
  const db = createServerClient()
  const [{ data, error }, online] = await Promise.all([
    db.from('agent_status').select('email_status, last_seen').order('last_seen', { ascending: false }).limit(1),
    agentOnline(db),
  ])
  const status: string | null = error ? null : (data?.[0]?.email_status ?? null)
  return Response.json({
    configured: !!status?.startsWith('on:'),
    status: status ? status.replace(/^(on|off):\s*/, '') : null,
    agentOnline: online,
    migrated: !error,
  })
}

// POST — send a test email now (through the agent)
export async function POST() {
  const gate = await requirePermission('settings.manage')
  if (gate instanceof Response) return gate
  const db = createServerClient()
  if (!(await agentOnline(db))) {
    return Response.json({ error: 'The monitoring agent is offline — test emails are sent by the agent.' }, { status: 503 })
  }
  const out = await runAgentJob<{ sent: number; to: string }>(db, 'email_test', {}, {
    timeoutMs: 40_000, requestedBy: gate.full_name || gate.email,
  })
  if (!out.ok) return Response.json({ error: out.error }, { status: out.status })
  return Response.json(out.result)
}
