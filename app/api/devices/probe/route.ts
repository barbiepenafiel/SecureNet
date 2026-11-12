import { createServerClient } from '@/lib/supabase'
import { requirePermission } from '@/lib/auth-server'
import { IPV4, probeDevice, rememberProbe, type ProbeResult } from '@/lib/device-probe'
import { agentOnline, runAgentJob } from '@/lib/agent-jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30   // waits for the campus agent's answer

// Check a device live (ICMP, ARP, SNMP, DNS) before it is added.
// The check runs on the campus agent (it is on the LAN and is what will
// monitor the device). Only when no agent is reporting AND this server is
// itself on the LAN (local run) does the server probe directly.
// Body: { ip, community?, port? }
export async function POST(req: Request) {
  const gate = await requirePermission('devices.manage')
  if (gate instanceof Response) return gate

  const body = await req.json().catch(() => ({}))
  const ip = String(body.ip ?? '').trim()
  const community = String(body.community ?? '').trim() || null
  const port = Number(body.port) || 161
  if (!IPV4.test(ip)) return Response.json({ error: 'Enter a valid IPv4 address, e.g. 192.168.1.20' }, { status: 400 })
  if (port < 1 || port > 65535) return Response.json({ error: 'SNMP port must be 1–65535' }, { status: 400 })
  if (community && community.length > 64) return Response.json({ error: 'Community is too long' }, { status: 400 })

  const db = createServerClient()
  let result: ProbeResult | null = null
  let jobId: string | null = null

  if (await agentOnline(db)) {
    const job = await runAgentJob<ProbeResult>(db, 'probe', { ip, community, port }, { timeoutMs: 25_000, requestedBy: gate.email })
    if (job.ok) { result = job.result; jobId = job.id }
    // Job queue not installed yet: a local server can still probe by itself
    else if (!(job.status === 501 && !process.env.VERCEL)) return Response.json({ error: job.error }, { status: job.status })
  } else if (process.env.VERCEL) {
    return Response.json({
      error: 'The monitoring agent is offline, so devices cannot be checked right now. Turn on the computer that runs the SecureNet agent and try again.',
    }, { status: 503 })
  }

  if (!result) {
    result = await probeDevice(ip, community, port)
    rememberProbe(result, community)
  }

  // Is this device already in SecureNet? (same IP, or same MAC at a new IP)
  const { data: byIp } = await db.from('devices').select('id, name, ip, type, status, source, location').eq('ip', ip)
  let existing = byIp ?? []
  if (result.arp.mac) {
    const { data: byMac } = await db.from('devices').select('id, name, ip, type, status, source, location').eq('mac', result.arp.mac)
    for (const d of byMac ?? []) if (!existing.some(e => e.id === d.id)) existing = [...existing, d]
  }

  return Response.json({ result, existing, jobId })
}
