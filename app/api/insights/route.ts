import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

function adminDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
}

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>(res => setTimeout(() => res(null), ms))])
}

function generateInsights(
  devices: { name: string; type: string; ip: string; status: string; cpu: number; mem: number }[],
  alerts:  { severity: string; title: string }[],
  sla:     { device_name: string; uptime_pct: number; incidents: number }[],
): string {
  const up      = devices.filter(d => d.status === 'up').length
  const down    = devices.filter(d => d.status === 'down').length
  const warn    = devices.filter(d => d.status === 'warn').length
  const total   = devices.length
  const pct     = total ? Math.round(up / total * 100) : 100
  const crits   = alerts.filter(a => a.severity === 'crit')
  const highCPU = devices.filter(d => d.cpu >= 80).sort((a, b) => b.cpu - a.cpu)
  const highMem = devices.filter(d => d.mem >= 85).sort((a, b) => b.mem - a.mem)
  const worstSla = sla.filter(s => s.uptime_pct < 99.5).sort((a, b) => a.uptime_pct - b.uptime_pct)

  const lines: string[] = []

  // Overview
  lines.push('**Network Health Overview**')
  if (down === 0 && crits.length === 0) {
    lines.push(`• All ${total} devices are operational with ${pct}% uptime — network is healthy.`)
  } else {
    lines.push(`• ${up} of ${total} devices online (${pct}%). ${down > 0 ? `${down} device(s) currently offline.` : ''} ${warn > 0 ? `${warn} in warning state.` : ''}`.trim())
  }
  if (crits.length > 0) {
    lines.push(`• ${crits.length} critical alert(s) require immediate attention.`)
  }
  lines.push('')

  // Critical Issues
  lines.push('**Critical Issues**')
  const offlineDevs = devices.filter(d => d.status === 'down')
  if (offlineDevs.length === 0 && crits.length === 0) {
    lines.push('• No critical issues detected at this time.')
  } else {
    offlineDevs.slice(0, 3).forEach(d => {
      lines.push(`• ${d.name} (${d.type}, ${d.ip}) is offline — check power and connectivity.`)
    })
    crits.slice(0, 2).forEach(a => {
      lines.push(`• ALERT: ${a.title}`)
    })
  }
  lines.push('')

  // At-Risk Devices
  lines.push('**At-Risk Devices**')
  const atRisk = [...highCPU, ...highMem.filter(m => !highCPU.find(c => c.ip === m.ip))]
  if (atRisk.length === 0 && worstSla.length === 0) {
    lines.push('• No devices showing signs of degradation.')
  } else {
    highCPU.slice(0, 2).forEach(d => {
      lines.push(`• ${d.name}: CPU at ${d.cpu}% — approaching saturation threshold.`)
    })
    highMem.slice(0, 2).forEach(d => {
      if (!highCPU.find(c => c.ip === d.ip)) {
        lines.push(`• ${d.name}: Memory at ${d.mem}% — may impact performance.`)
      }
    })
    worstSla.slice(0, 2).forEach(s => {
      lines.push(`• ${s.device_name}: SLA at ${s.uptime_pct}% (${s.incidents} incidents) — below 99.5% target.`)
    })
  }
  lines.push('')

  // Recommendations
  lines.push('**Recommendations**')
  const recs: string[] = []
  if (offlineDevs.length > 0)
    recs.push(`Investigate ${offlineDevs[0].name} and ${offlineDevs.length > 1 ? `${offlineDevs.length - 1} other offline device(s)` : 'restore connectivity'} immediately.`)
  if (highCPU.length > 0)
    recs.push(`Review load on ${highCPU[0].name} (CPU ${highCPU[0].cpu}%) — consider redistributing traffic or upgrading hardware.`)
  if (worstSla.length > 0)
    recs.push(`Investigate recurring downtime on ${worstSla[0].device_name} to restore SLA compliance.`)
  if (crits.length > 0 && recs.length < 3)
    recs.push(`Acknowledge and resolve ${crits.length} open critical alert(s) in the Alerts page.`)
  if (recs.length === 0)
    recs.push('Schedule routine firmware updates during next maintenance window.')
  if (recs.length < 2)
    recs.push('Review device SLA targets and set maintenance windows for non-critical devices.')
  if (recs.length < 3)
    recs.push('Enable SNMP polling on all managed devices to improve real-time monitoring coverage.')

  recs.slice(0, 3).forEach((r, i) => lines.push(`• ${i + 1}. ${r}`))

  return lines.join('\n')
}

function streamText(text: string): Response {
  const enc = new TextEncoder()
  const readable = new ReadableStream({
    start(controller) {
      const words = text.split(' ')
      let i = 0
      const tick = () => {
        const batch = words.slice(i, i + 6).join(' ') + (i + 6 < words.length ? ' ' : '')
        controller.enqueue(enc.encode(batch))
        i += 6
        if (i < words.length) setTimeout(tick, 15)
        else controller.close()
      }
      tick()
    },
  })
  return new Response(readable, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

export async function POST() {
  const db = adminDb()

  const [devRes, alertRes, slaRes] = await Promise.all([
    withTimeout(db.from('devices').select('name,type,ip,status,cpu,mem').order('cpu', { ascending: false }).limit(20), 4000),
    withTimeout(db.from('alerts').select('title,severity').eq('acked', false).eq('suppressed', false).order('created_at', { ascending: false }).limit(20), 4000),
    withTimeout(db.from('sla_data').select('device_name,uptime_pct,incidents').order('uptime_pct').limit(10), 4000),
  ])

  const devices = (devRes?.data ?? []) as { name: string; type: string; ip: string; status: string; cpu: number; mem: number }[]
  const alerts  = (alertRes?.data ?? []) as { severity: string; title: string }[]
  const sla     = (slaRes?.data ?? []) as { device_name: string; uptime_pct: number; incidents: number }[]

  const text = generateInsights(devices, alerts, sla)
  return streamText(text)
}
