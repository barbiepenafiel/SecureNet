import { createServerClient } from '@/lib/supabase'
import { requirePermission } from '@/lib/auth-server'
import { DEVICE_TYPES, IPV4, probeDevice, recentProbe, type ProbeResult } from '@/lib/device-probe'
import { finishedJobResult } from '@/lib/agent-jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Add a device (or take over an existing record) using the server's own
// live probe result. Body: { ip, community?, port?, name, type, location, existingId? }
export async function POST(req: Request) {
  const gate = await requirePermission('devices.manage')
  if (gate instanceof Response) return gate

  const body = await req.json().catch(() => ({}))
  const ip         = String(body.ip ?? '').trim()
  const community  = String(body.community ?? '').trim() || null
  const port       = Number(body.port) || 161
  const name       = String(body.name ?? '').trim()
  const type       = String(body.type ?? '')
  const location   = String(body.location ?? '').trim() || 'Unassigned'
  const existingId = body.existingId ? String(body.existingId) : null

  if (!IPV4.test(ip))  return Response.json({ error: 'Invalid IP address' }, { status: 400 })
  if (!name)           return Response.json({ error: 'Name is required' }, { status: 400 })
  if (name.length > 80) return Response.json({ error: 'Name is too long' }, { status: 400 })
  if (!(DEVICE_TYPES as readonly string[]).includes(type)) return Response.json({ error: 'Invalid device type' }, { status: 400 })

  const db  = createServerClient()
  const now = new Date().toISOString()

  // Use the measurement the user just looked at: the agent's stored result
  // (hosted dashboard) or this server's own recent probe (local run).
  let probe: ProbeResult | null = null
  if (body.jobId) {
    const fromAgent = await finishedJobResult<ProbeResult>(db, String(body.jobId), 'probe')
    if (fromAgent?.ip === ip) probe = fromAgent
  }
  probe ??= recentProbe(ip, community, port)
  if (!probe && !process.env.VERCEL) probe = await probeDevice(ip, community, port)

  // Never create a second record for the same device
  if (!existingId) {
    const { data: dupIp } = await db.from('devices').select('id, name').eq('ip', ip).limit(1)
    const dup = dupIp?.[0] ?? (probe?.arp.mac
      ? (await db.from('devices').select('id, name').eq('mac', probe.arp.mac).limit(1)).data?.[0]
      : undefined)
    if (dup) return Response.json({ error: `This device is already in SecureNet as "${dup.name}". Update that record instead.`, existingId: dup.id }, { status: 409 })
  }

  // What the device itself reported
  const measured: Record<string, unknown> = {}
  if (probe) {
    if (probe.arp.mac)            measured.mac         = probe.arp.mac
    if (probe.vendor)             measured.vendor      = probe.vendor
    if (probe.hostname)           measured.hostname    = probe.hostname
    if (probe.model)              measured.model       = probe.model
    if (probe.firmware)           measured.firmware    = probe.firmware
    if (probe.snmp.uptime)        measured.uptime      = probe.snmp.uptime
    if (probe.suggested.method)   measured.last_method = probe.suggested.method
    if (probe.reachable)          measured.last_seen   = now
  }
  // Keep the community only when it really answered (or the user typed one)
  const snmpCommunity = probe?.snmp.ok ? probe.snmp.community : community

  const basic = { name, type, ip, location, snmp_community: snmpCommunity, snmp_port: port, updated_at: now }

  let saved: { id: string; name: string } | null = null
  let error: { message: string; code?: string } | null = null

  if (existingId) {
    const patch = { ...basic, ...measured, source: 'manual' }
    ;({ data: saved, error } = await db.from('devices').update(patch).eq('id', existingId).select('id, name').single())
    if (error && /column|schema cache/i.test(error.message)) {
      ;({ data: saved, error } = await db.from('devices').update(basic).eq('id', existingId).select('id, name').single())
    }
  } else {
    // Online if it answered just now; otherwise the agent decides on its next check
    const status = probe?.reachable ? 'up' : 'unknown'
    const row = { ...basic, ...measured, status, cpu: 0, mem: 0, uptime: measured.uptime ?? '—', source: 'manual', first_seen: now }
    ;({ data: saved, error } = await db.from('devices').insert(row).select('id, name').single())
    if (error && /column|schema cache|check constraint/i.test(error.message)) {
      const fallback = { ...basic, status: probe?.reachable ? 'up' : 'down', cpu: 0, mem: 0, uptime: '—' }
      ;({ data: saved, error } = await db.from('devices').insert(fallback).select('id, name').single())
    }
  }

  if (error?.code === '23505') return Response.json({ error: `A device named "${name}" already exists. Choose another name.` }, { status: 409 })
  if (error || !saved)         return Response.json({ error: error?.message ?? 'Could not save the device' }, { status: 500 })

  const actor = (gate as { full_name?: string; email?: string }).full_name || (gate as { email?: string }).email || 'unknown'
  const via = probe?.reachable
    ? [probe.icmp.ok && 'ICMP', probe.arp.ok && 'ARP', probe.snmp.ok && 'SNMP'].filter(Boolean).join(', ')
    : 'not reachable when added'
  await db.from('audit_log').insert({
    user_name: actor,
    user_ip: req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'server',
    action: existingId ? 'Device updated (verified)' : 'Device added (verified)',
    object_name: `${saved.name} (${ip})`,
    after_val: `${type} · ${location} · ${via}`,
  }).then(() => null, () => null)

  return Response.json({ device: saved, updated: !!existingId })
}
