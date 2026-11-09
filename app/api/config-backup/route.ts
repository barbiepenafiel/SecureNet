import { createClient } from '@supabase/supabase-js'
import * as snmp from 'net-snmp'

export const runtime = 'nodejs'

const OID_SYS_DESCR  = '1.3.6.1.2.1.1.1.0'
const OID_SYS_NAME   = '1.3.6.1.2.1.1.5.0'
const OID_SYS_UPTIME = '1.3.6.1.2.1.1.3.0'
const OID_SYS_CONTACT= '1.3.6.1.2.1.1.4.0'
const OID_SYS_LOC    = '1.3.6.1.2.1.1.6.0'
const OID_IF_NUMBER  = '1.3.6.1.2.1.2.1.0'
const OID_IF_DESCR   = (i: number) => `1.3.6.1.2.1.2.2.1.2.${i}`
const OID_IF_STATUS  = (i: number) => `1.3.6.1.2.1.2.2.1.8.${i}`

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
}

function snmpGet(ip: string, community: string, oids: string[]): Promise<snmp.VarBind[]> {
  return new Promise(resolve => {
    const s = snmp.createSession(ip, community, { timeout: 3000, retries: 1, version: snmp.Version2c })
    s.get(oids, (err: Error | null, vb: snmp.VarBind[]) => { s.close(); resolve(err ? [] : (vb ?? [])) })
  })
}

async function buildSnapshot(ip: string, community: string, deviceName: string, deviceType: string): Promise<string> {
  const sysVb = await snmpGet(ip, community, [
    OID_SYS_DESCR, OID_SYS_NAME, OID_SYS_UPTIME, OID_SYS_CONTACT, OID_SYS_LOC, OID_IF_NUMBER,
  ])

  const sysDescr   = sysVb[0]?.value?.toString()  ?? '—'
  const sysName    = sysVb[1]?.value?.toString()  ?? deviceName
  const uptimeTicks = Number(sysVb[2]?.value ?? 0)
  const totalSecs  = Math.floor(uptimeTicks / 100)
  const days  = Math.floor(totalSecs / 86400)
  const hrs   = Math.floor((totalSecs % 86400) / 3600)
  const mins  = Math.floor((totalSecs % 3600) / 60)
  const uptime = `${days}d ${hrs}h ${mins}m`
  const contact = sysVb[3]?.value?.toString() ?? '—'
  const location = sysVb[4]?.value?.toString() ?? '—'
  const ifCount  = Number(sysVb[5]?.value ?? 0)

  // Poll interfaces
  const ifLines: string[] = []
  if (ifCount > 0) {
    const ifIdxs = Array.from({ length: Math.min(ifCount, 10) }, (_, i) => i + 1)
    const ifOids = ifIdxs.flatMap(i => [OID_IF_DESCR(i), OID_IF_STATUS(i)])
    const ifVb   = await snmpGet(ip, community, ifOids)
    for (let i = 0; i < ifIdxs.length; i++) {
      const name   = ifVb[i * 2]?.value?.toString()     ?? `if${i + 1}`
      const status = Number(ifVb[i * 2 + 1]?.value ?? 2)
      const state  = status === 1 ? 'up' : 'down'
      ifLines.push(`  interface ${name}`)
      ifLines.push(`    admin-status: ${state}`)
    }
  }

  const lines = [
    `! Snapshot: ${deviceName} (${deviceType})`,
    `! Generated: ${new Date().toISOString()}`,
    `! Source: SNMP v2c @ ${ip}`,
    `!`,
    `hostname ${sysName}`,
    `!`,
    `system-description ${sysDescr.replace(/\n/g, ' ')}`,
    `system-uptime ${uptime}`,
    `system-contact ${contact}`,
    `system-location ${location}`,
    `!`,
    `! Interfaces (${ifCount} total):`,
    ...ifLines,
    `!`,
    `! end`,
  ]

  return lines.join('\n')
}

export async function POST(req: Request) {
  const db   = adminClient()
  const body = await req.json().catch(() => ({}))

  // Get devices to backup (all or specific id)
  const { data: devices } = body.id
    ? await db.from('devices').select('*').eq('id', body.id)
    : await db.from('devices').select('*').neq('status', 'maint')

  if (!devices?.length) return Response.json({ backed_up: 0, results: [] })

  const now     = new Date().toISOString()
  const results = []

  for (const dev of devices) {
    const community = dev.snmp_community ?? 'public'

    // Try to build SNMP snapshot; fall back to minimal text if no SNMP
    let content: string
    try {
      content = await buildSnapshot(dev.ip, community, dev.name, dev.type)
    } catch {
      content = [
        `! Snapshot: ${dev.name} (${dev.type})`,
        `! Generated: ${now}`,
        `! Note: SNMP not available for this device`,
        `!`,
        `hostname ${dev.name}`,
        `ip-address ${dev.ip}`,
        `type ${dev.type}`,
        `status ${dev.status}`,
        `! end`,
      ].join('\n')
    }

    const size_kb = Math.max(1, Math.round(content.length / 1024))

    // Compare with previous backup
    const { data: prevBackups } = await db
      .from('config_backups')
      .select('content')
      .eq('device_name', dev.name)
      .order('backed_up_at', { ascending: false })
      .limit(1)

    const prevContent = prevBackups?.[0]?.content ?? null
    const changed     = !prevContent || prevContent.trim() !== content.trim()

    await db.from('config_backups').insert({
      device_name: dev.name,
      backed_up_at: now,
      size_kb,
      changed,
      backup_by:   'system',
      content,
    })

    results.push({ device: dev.name, changed, size_kb })
  }

  return Response.json({ backed_up: results.length, results })
}

export async function GET() {
  return POST(new Request('http://localhost', { method: 'POST', body: '{}' }))
}
