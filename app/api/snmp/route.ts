import { createClient } from '@supabase/supabase-js'
import * as snmp from 'net-snmp'
import { agentOnline } from '@/lib/agent-jobs'

export const runtime = 'nodejs'

// Basic device OIDs
const OID_SYS_DESCR = '1.3.6.1.2.1.1.1.0'   // sysDescr — model + firmware info
const OID_SYS_NAME  = '1.3.6.1.2.1.1.5.0'   // sysName  — hostname
const OID_UPTIME    = '1.3.6.1.2.1.1.3.0'
const OID_CPU_IDLE  = '1.3.6.1.4.1.2021.11.11.0'
const OID_MEM_TOTAL = '1.3.6.1.4.1.2021.4.5.0'
const OID_MEM_FREE  = '1.3.6.1.4.1.2021.4.6.0'

// Parse sysDescr into { model, firmware }
function parseSysDescr(raw: string): { model: string | null; firmware: string | null } {
  if (!raw || raw.trim().length === 0) return { model: null, firmware: null }
  const d = raw.trim()

  // Linux kernel line: "Linux hostname 5.15.0-91-generic #101-Ubuntu..."
  const linuxM = d.match(/^Linux\s+\S+\s+([\d.\-\w]+)/i)
  if (linuxM) {
    const distro = /ubuntu/i.test(d) ? 'Ubuntu Server'
                 : /debian/i.test(d) ? 'Debian Server'
                 : /centos/i.test(d) ? 'CentOS Server'
                 : /alpine/i.test(d) ? 'Alpine Linux'
                 : /fedora/i.test(d) ? 'Fedora Server'
                 : 'Linux Server'
    return { model: distro, firmware: linuxM[1] }
  }

  // Cisco IOS: "Cisco IOS Software ... Version 15.1(4)M4"
  const iosM = d.match(/Cisco IOS[^\n]*Version\s+([\d.()A-Za-z]+)/i)
  if (iosM) {
    const hwM = d.match(/(?:cisco )([\w-]+) Software/i)
    return { model: hwM ? `Cisco ${hwM[1]}` : 'Cisco IOS', firmware: iosM[1] }
  }

  // Cisco ASA: "Cisco Adaptive Security Appliance Software Version 9.14(3)"
  const asaM = d.match(/Cisco Adaptive Security Appliance.*?Version\s+([\d.()]+)/i)
  if (asaM) return { model: 'Cisco ASA', firmware: asaM[1] }

  // Cisco NX-OS
  const nxM = d.match(/Cisco NX-OS.*?Version\s+([\d.()A-Za-z]+)/i)
  if (nxM) return { model: 'Cisco NX-OS', firmware: nxM[1] }

  // MikroTik RouterOS: "RouterOS CHR 6.49.6"
  const mtM = d.match(/RouterOS\s+(\S+)\s+([\d.]+)/i)
  if (mtM) return { model: `MikroTik ${mtM[1]}`, firmware: mtM[2] }
  const mtM2 = d.match(/MikroTik\s+RouterOS[,\s]*([\d.]+)/i)
  if (mtM2) return { model: 'MikroTik RouterOS', firmware: mtM2[1] }

  // HP ProCurve: "HP J9627A 2620-24-PoE+ Switch, revision YB.16.03.0005"
  const hpM = d.match(/HP\s+(\S+)\s+([^,]+),\s*revision\s+([\w.]+)/i)
  if (hpM) return { model: `HP ${hpM[2].trim()}`, firmware: hpM[3] }

  // Juniper JunOS: "Juniper Networks ... JUNOS 20.2R3"
  const juniM = d.match(/JUNOS\s+([\d.A-Za-z]+)/i)
  if (juniM) return { model: 'Juniper', firmware: juniM[1] }

  // Windows (SNMP agent): "Hardware: ... Windows Version 10.0 (Build 19045)"
  const winM = d.match(/Windows[^\n]*Version\s+([\d.]+)/i)
  if (winM) return { model: 'Windows', firmware: winM[1] }

  // FortiOS: "Fortinet FortiGate ... v7.2.5"
  const fortiM = d.match(/Fortinet\s+(\S+)[^v]*v([\d.]+)/i)
  if (fortiM) return { model: `Fortinet ${fortiM[1]}`, firmware: `v${fortiM[2]}` }

  // Fallback: first 60 chars as model, no firmware
  return { model: d.slice(0, 60).replace(/\s+/g, ' '), firmware: null }
}

// Interface OIDs (indexes 1–6)
const MAX_IF = 6
function ifOids(idx: number) {
  return [
    `1.3.6.1.2.1.2.2.1.2.${idx}`,  // ifDescr
    `1.3.6.1.2.1.2.2.1.10.${idx}`, // ifInOctets
    `1.3.6.1.2.1.2.2.1.16.${idx}`, // ifOutOctets
  ]
}

// Previous counter values for rate calculation (ip:ifName → {inOctets, outOctets, ts})
const prevCounters = new Map<string, { inOctets: number; outOctets: number; ts: number }>()

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
}

function snmpGet(ip: string, community: string, port: number, oids: string[]): Promise<snmp.VarBind[]> {
  return new Promise((resolve) => {
    const session = snmp.createSession(ip, community, { port, timeout: 3000, retries: 1, version: snmp.Version2c })
    session.get(oids, (err: Error | null, vb: snmp.VarBind[]) => {
      session.close()
      resolve(err ? [] : (vb ?? []))
    })
  })
}

async function pollDevice(ip: string, community: string, port: number): Promise<{
  uptime: string; cpu: number; mem: number; model: string | null; firmware: string | null
}> {
  const vb = await snmpGet(ip, community, port, [
    OID_SYS_DESCR, OID_SYS_NAME,
    OID_UPTIME, OID_CPU_IDLE, OID_MEM_TOTAL, OID_MEM_FREE,
  ])
  if (!vb.length) return { uptime: '—', cpu: 0, mem: 0, model: null, firmware: null }

  try {
    const sysDescr = vb[0]?.value?.toString() ?? ''
    const { model, firmware } = parseSysDescr(sysDescr)

    const uptimeTicks = Number(vb[2]?.value ?? 0)
    const totalSecs   = Math.floor(uptimeTicks / 100)
    const days  = Math.floor(totalSecs / 86400)
    const hrs   = Math.floor((totalSecs % 86400) / 3600)
    const mins  = Math.floor((totalSecs % 3600) / 60)
    const uptime = days > 0 ? `${days}d ${hrs}h ${mins}m` : `${hrs}h ${mins}m`

    const cpuIdle = Number(vb[3]?.value ?? 100)
    const cpu     = Math.max(0, Math.min(100, 100 - cpuIdle))

    const memTotal = Number(vb[4]?.value ?? 1)
    const memFree  = Number(vb[5]?.value ?? 1)
    const mem = memTotal > 0 ? Math.round(((memTotal - memFree) / memTotal) * 100) : 0

    return { uptime, cpu, mem, model, firmware }
  } catch {
    return { uptime: '—', cpu: 0, mem: 0, model: null, firmware: null }
  }
}

async function pollInterfaces(
  ip: string, community: string, port: number, deviceName: string
): Promise<Array<{ ifName: string; inMbps: number; outMbps: number }>> {
  const allOids = Array.from({ length: MAX_IF }, (_, i) => ifOids(i + 1)).flat()
  const vb = await snmpGet(ip, community, port, allOids)
  if (!vb.length) return []

  const now     = Date.now()
  const results: Array<{ ifName: string; inMbps: number; outMbps: number }> = []

  for (let i = 0; i < MAX_IF; i++) {
    const descr     = vb[i * 3]?.value?.toString()     ?? ''
    const inOctets  = Number(vb[i * 3 + 1]?.value ?? 0)
    const outOctets = Number(vb[i * 3 + 2]?.value ?? 0)

    // Skip loopback and empty interfaces
    if (!descr || descr === 'lo' || descr.startsWith('virbr') || (inOctets === 0 && outOctets === 0)) continue

    const key  = `${ip}:${descr}`
    const prev = prevCounters.get(key)

    if (prev && prev.ts < now) {
      const elapsed = (now - prev.ts) / 1000  // seconds
      // Handle counter wrap (32-bit max ~4.3GB)
      const rawIn  = inOctets  >= prev.inOctets  ? inOctets  - prev.inOctets  : (0xFFFFFFFF - prev.inOctets  + inOctets)
      const rawOut = outOctets >= prev.outOctets ? outOctets - prev.outOctets : (0xFFFFFFFF - prev.outOctets + outOctets)
      const inMbps  = parseFloat(((rawIn  * 8) / elapsed / 1_000_000).toFixed(4))
      const outMbps = parseFloat(((rawOut * 8) / elapsed / 1_000_000).toFixed(4))
      results.push({ ifName: descr, inMbps, outMbps })
    }

    prevCounters.set(key, { inOctets, outOctets, ts: now })
  }

  return results
}

export async function POST(req: Request) {
  const db   = adminClient()
  const body = await req.json().catch(() => ({}))

  // SNMP polling belongs to the campus agent (poller/agent.js) whenever it is
  // reporting — polling here as well would write every sample twice. A hosted
  // (Vercel) server can never reach the campus LAN, so it never polls.
  if (process.env.VERCEL || await agentOnline(db)) return Response.json({ polled: 0, agent: true })

  const { data: allDevices } = body.id
    ? await db.from('devices').select('id, name, ip, snmp_community, snmp_port').eq('id', body.id)
    : await db.from('devices').select('id, name, ip, snmp_community, snmp_port').neq('status', 'maint')

  // MikroTik routers are polled by the agent (poller/mikrotik.js) with
  // RouterOS-specific OIDs — skip them here so their data isn't overwritten
  const { data: mikrotik } = await db.from('mikrotik_routers').select('device_id')
  const mikrotikIds = new Set((mikrotik ?? []).map(r => r.device_id as string))
  const devices = (allDevices ?? []).filter(d => !mikrotikIds.has(d.id))

  if (!devices.length) return Response.json({ polled: 0 })

  const results = await Promise.all(
    devices.map(async (dev) => {
      const community = dev.snmp_community ?? 'public'
      const port      = dev.snmp_port      ?? 161

      // Poll basic metrics (uptime, cpu, mem, model, firmware via sysDescr)
      const { uptime, cpu, mem, model, firmware } = await pollDevice(dev.ip, community, port)

      const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (uptime   !== '—') update.uptime   = uptime
      if (cpu      >  0)    update.cpu      = cpu
      if (mem      >  0)    update.mem      = mem
      if (model)            update.model    = model
      if (firmware)         update.firmware = firmware
      if (Object.keys(update).length > 1) {
        await db.from('devices').update(update).eq('id', dev.id)
      }

      // Poll interface traffic and write to traffic_samples
      const ifaces = await pollInterfaces(dev.ip, community, port, dev.name)
      if (ifaces.length) {
        const now = new Date().toISOString()
        await Promise.all(ifaces.map(iface =>
          db.from('traffic_samples').insert({
            device_name: dev.name,
            interface:   iface.ifName,
            in_mbps:     iface.inMbps,
            out_mbps:    iface.outMbps,
            sampled_at:  now,
          })
        ))
      }

      return { id: dev.id, ip: dev.ip, uptime, cpu, mem, interfaces: ifaces }
    }),
  )

  return Response.json({ polled: results.length, results })
}

export async function GET() {
  return POST(new Request('http://localhost', { method: 'POST', body: '{}' }))
}
