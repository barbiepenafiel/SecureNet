import { createServerClient } from '@/lib/supabase'
import { requirePermission } from '@/lib/auth-server'
import { agentOnline, runAgentJob } from '@/lib/agent-jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 45   // waits for the agent's connection test

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

// SNMP connection settings for one device.
//   { action: 'test', deviceId?, host, port, community, version }
//       The agent tests the connection from the network it is on right now:
//       route → ping → SNMP → (UDP port), and reads name, uptime, interfaces.
//   { action: 'save', deviceId, host, port, community, version }
//       Stores the address / version / community / port the agent will use.
export async function POST(req: Request) {
  const gate = await requirePermission('devices.manage')
  if (gate instanceof Response) return gate

  const body      = await req.json().catch(() => ({}))
  const action    = String(body.action ?? '')
  const deviceId  = body.deviceId ? String(body.deviceId) : null
  const host      = String(body.host ?? '').trim()
  const port      = Number(body.port) || 161
  const community = String(body.community ?? '')
  const version   = String(body.version ?? '2c') === '1' ? '1' : '2c'

  if (!IPV4.test(host))                          return Response.json({ error: 'Enter a valid IPv4 address' }, { status: 400 })
  if (port < 1 || port > 65535)                  return Response.json({ error: 'SNMP port must be 1–65535' }, { status: 400 })
  if (!community || community.length > 64)       return Response.json({ error: 'Enter the SNMP community (up to 64 characters)' }, { status: 400 })

  const db = createServerClient()

  if (action === 'test') {
    // The test must run where the monitoring runs: on the agent
    if (!(await agentOnline(db))) {
      return Response.json({ error: 'The monitoring agent is offline, so the connection cannot be tested. Turn on the computer that runs the SecureNet agent and try again.' }, { status: 503 })
    }
    let everAnswered = false
    if (deviceId) {
      const { data } = await db.from('devices').select('cpu, mem, uptime').eq('id', deviceId).single()
      everAnswered = !!data && (data.cpu > 0 || data.mem > 0 || (!!data.uptime && data.uptime !== '—'))
    }
    const job = await runAgentJob(db, 'probe', { test: true, host, port, community, version, everAnswered },
      { timeoutMs: 40_000, requestedBy: gate.email })
    if (!job.ok) return Response.json({ error: job.error }, { status: job.status })
    return Response.json({ result: job.result })
  }

  if (action === 'save') {
    if (!deviceId) return Response.json({ error: 'Missing device' }, { status: 400 })
    const { data: dev } = await db.from('devices').select('id, name, ip').eq('id', deviceId).single()
    if (!dev) return Response.json({ error: 'Device not found' }, { status: 404 })

    const { error } = await db.from('devices').update({
      snmp_host: host === dev.ip ? null : host,   // same as its own address → no override
      snmp_version: version, snmp_community: community, snmp_port: port,
      updated_at: new Date().toISOString(),
    }).eq('id', deviceId)
    if (error) {
      const missing = /column|schema cache/i.test(error.message)
      return Response.json({ error: missing ? 'Run supabase/migration_snmp_connection.sql in the Supabase SQL Editor first.' : error.message }, { status: missing ? 501 : 500 })
    }

    await db.from('audit_log').insert({
      user_name: gate.full_name || gate.email,
      user_ip: req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'server',
      action: 'SNMP settings changed',
      object_name: `${dev.name} (${dev.ip})`,
      after_val: `SNMP v${version} · ${host}:${port}`,   // the community is never written to the log
    }).then(() => null, () => null)

    return Response.json({ saved: true })
  }

  return Response.json({ error: 'Unknown action' }, { status: 400 })
}
