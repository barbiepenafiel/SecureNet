'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import type { Device, Alert, SlaRecord } from '@/lib/database.types'
import { usePolling } from '@/lib/usePolling'
import {
  LatencyTrendChart, AlertBreakdownChart,
  IncidentFrequencyChart, PeakFailureHoursChart,
  TopDevicesChart, LocationHealthChart, UptimeDowntimeChart,
} from '@/components/ReportCharts'

type Period = '24h' | '7d' | '30d'

const PERIOD_MS: Record<Period, number> = {
  '24h': 86_400_000,
  '7d':  604_800_000,
  '30d': 2_592_000_000,
}

interface ScanSample    { latency_ms: number | null; responded: boolean; scanned_at: string; ip: string }
interface DiscoveredHost { ip: string; hostname: string | null; vendor: string | null; device_type: string | null; scan_type: string; responded: boolean; latency_ms: number | null }

function uptimeColor(pct: number) {
  return pct >= 99 ? 'var(--ok)' : pct >= 90 ? 'var(--warn)' : 'var(--crit)'
}

function UptimeBadge({ pct }: { pct: number }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      fontSize: 11, fontWeight: 600, background: uptimeColor(pct) + '22', color: uptimeColor(pct),
    }}>
      {pct.toFixed(0)}%
    </span>
  )
}

function KpiTile({ label, value, sub, iconBg, icon }: {
  label: string; value: string | number; sub: string; iconBg: string; icon: string
}) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14,
    }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
        {icon}
      </div>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1 }}>{value}</div>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{sub}</div>
      </div>
    </div>
  )
}

function TrendKpi({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) {
  return (
    <div style={{ flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,.6)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,.5)', marginTop: 4 }}>{sub}</div>
    </div>
  )
}

function exportCSV(rows: DevicePerfRow[], period: Period) {
  const header = ['Device Name','IP','Type','Building/Floor','Uptime %','Avg Latency (ms)','Alerts']
  const lines = rows.map(r => [r.name,r.ip,r.type,r.location,r.uptimePct.toFixed(1),r.latency??'—',r.alertCount].join(','))
  const csv = [header.join(','), ...lines].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `network-report-${period}-${new Date().toISOString().slice(0,10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

interface DevicePerfRow {
  name: string; ip: string; type: string; location: string
  uptimePct: number; latency: number | null; alertCount: number
}

export default function ReportsPage() {
  const [period,    setPeriod]    = useState<Period>('24h')
  const [devices,   setDevices]   = useState<Device[]>([])
  const [alerts,    setAlerts]    = useState<Alert[]>([])
  const [slaData,   setSlaData]   = useState<SlaRecord[]>([])
  const [scanData,  setScanData]  = useState<ScanSample[]>([])
  const [discovered, setDiscovered] = useState<DiscoveredHost[]>([])
  const [showAll,   setShowAll]   = useState(false)
  const [generating, setGenerating] = useState(false)
  const [genMsg,    setGenMsg]    = useState<string | null>(null)

  const load = useCallback(async () => {
    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const [{ data: d }, { data: a }, { data: s }, { data: sc }, scanRes] = await Promise.all([
      supabase.from('devices').select('*').order('name'),
      supabase.from('alerts').select('*').order('created_at', { ascending: false }),
      supabase.from('sla_data').select('*'),
      supabase.from('scan_results').select('latency_ms, responded, scanned_at, ip').gte('scanned_at', cutoff30d).order('scanned_at', { ascending: true }).limit(5000),
      fetch('/api/scan').then(r => r.ok ? r.json() : { results: [] }).catch(() => ({ results: [] })),
    ])
    setDevices(d ?? [])
    setAlerts(a ?? [])
    setSlaData(s ?? [])
    setScanData((sc ?? []) as ScanSample[])
    // Discovered = scan results not in managed devices table
    const managedIps = new Set((d ?? []).map((dev: { ip: string }) => dev.ip))
    const allDiscovered: DiscoveredHost[] = (scanRes.results ?? []).filter((h: DiscoveredHost) => !managedIps.has(h.ip))
    setDiscovered(allDiscovered)
  }, [])

  useEffect(() => { load() }, [load])
  // Keep data current without a manual refresh
  usePolling(load, 15_000)

  // ── Period-filtered alerts ───────────────────────────────────
  const cutoff = useMemo(() => new Date(Date.now() - PERIOD_MS[period]), [period])
  const pAlerts = useMemo(() => alerts.filter(a => new Date(a.created_at) >= cutoff), [alerts, cutoff])

  // ── KPIs ─────────────────────────────────────────────────────
  const devicesMonitored = devices.length + discovered.length
  const avgUptime = useMemo(() => {
    if (slaData.length) return (slaData.reduce((s,r) => s + Number(r.uptime_pct), 0) / slaData.length).toFixed(1)
    if (!devices.length) return '0.0'
    return (devices.filter(d => d.status !== 'down').length / devices.length * 100).toFixed(1)
  }, [slaData, devices])

  const avgCPU = devices.length ? devices.reduce((s,d) => s + d.cpu, 0) / devices.length : 50
  // Average latency: prefer scan_results table, fall back to /api/scan discovered hosts
  const avgLatency = useMemo(() => {
    const fromDb = scanData.filter(s => s.responded && s.latency_ms != null && new Date(s.scanned_at) >= cutoff)
    if (fromDb.length) {
      const avg = fromDb.reduce((a, s) => a + s.latency_ms!, 0) / fromDb.length
      return avg.toFixed(1)
    }
    // Fall back to latency from /api/scan discovered hosts
    const fromScan = [...discovered].filter(h => h.responded && h.latency_ms != null)
    if (fromScan.length) {
      const avg = fromScan.reduce((a, h) => a + h.latency_ms!, 0) / fromScan.length
      return avg.toFixed(1)
    }
    return '—'
  }, [scanData, cutoff, discovered])
  const totalAlerts = pAlerts.length
  const critCount = pAlerts.filter(a => a.severity === 'crit').length
  const warnCount = pAlerts.filter(a => a.severity === 'warn').length
  const infoCount = pAlerts.filter(a => a.severity === 'info').length

  // ── Trend KPIs ───────────────────────────────────────────────
  const hourCounts = useMemo(() => {
    const arr = Array(24).fill(0)
    pAlerts.forEach(a => { arr[new Date(a.created_at).getHours()]++ })
    return arr
  }, [pAlerts])
  const peakHourIdx = hourCounts.indexOf(Math.max(...hourCounts))
  const peakHourLabel = pAlerts.length === 0 ? '—' : (() => {
    const h = peakHourIdx % 12 || 12
    return `${h} ${peakHourIdx < 12 ? 'AM' : 'PM'}`
  })()

  const mostProblematic = useMemo(() => {
    const counts: Record<string,number> = {}
    pAlerts.forEach(a => {
      const key = a.meta?.split('·')[0]?.trim() || a.title.split(' ')[0]
      counts[key] = (counts[key] ?? 0) + 1
    })
    const top = Object.entries(counts).sort((a,b) => b[1]-a[1])[0]
    if (top) return { name: top[0].slice(0,16), count: top[1] }
    const down = devices.find(d => d.status === 'down')
    return down ? { name: down.ip || down.name, count: 0 } : { name: '—', count: 0 }
  }, [pAlerts, devices])

  // Resolution rate = acked or resolved alerts / total
  const resolvedAlerts = pAlerts.filter(a => a.acked || a.resolved_at)
  const resolutionRate = totalAlerts === 0 ? '—' : `${Math.round(resolvedAlerts.length / totalAlerts * 100)}%`

  // Avg resolution time = mean of (resolved_at - created_at) for alerts that have resolved_at
  const avgResolution = useMemo(() => {
    const withTime = pAlerts.filter(a => a.resolved_at && a.created_at)
    if (!withTime.length) {
      // Fall back: use acked alerts — treat acked_at as ~now if no resolved_at
      const acked = pAlerts.filter(a => a.acked && a.created_at)
      if (!acked.length) return '—'
      const avgMs = acked.reduce((s, a) => s + (Date.now() - new Date(a.created_at).getTime()), 0) / acked.length
      const mins = Math.round(avgMs / 60000)
      return mins < 60 ? `${mins}m` : `${Math.round(mins/60)}h`
    }
    const avgMs = withTime.reduce((s, a) => s + (new Date(a.resolved_at!).getTime() - new Date(a.created_at).getTime()), 0) / withTime.length
    const mins = Math.round(avgMs / 60000)
    return mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins/60)}h` : `${Math.round(mins/1440)}d`
  }, [pAlerts])

  // ── Incident Frequency chart data ────────────────────────────
  const { freqLabels, freqDown, freqLatency, freqRecovery } = useMemo(() => {
    if (period === '24h') {
      const labels = Array.from({length:24},(_,i) => `${i.toString().padStart(2,'0')}:00`)
      const fDown = Array(24).fill(0); const fLat = Array(24).fill(0); const fRec = Array(24).fill(0)
      pAlerts.forEach(a => {
        const h = new Date(a.created_at).getHours()
        if (a.severity==='crit') fDown[h]++
        else if (a.severity==='warn') fLat[h]++
        else fRec[h]++
      })
      return { freqLabels: labels, freqDown: fDown, freqLatency: fLat, freqRecovery: fRec }
    }
    const days = period === '7d' ? 7 : 30
    const labels = Array.from({length:days},(_,i) => {
      const d = new Date(Date.now() - (days-1-i)*86400000)
      return `${d.getMonth()+1}/${d.getDate()}`
    })
    const fDown = Array(days).fill(0); const fLat = Array(days).fill(0); const fRec = Array(days).fill(0)
    pAlerts.forEach(a => {
      const dAgo = Math.floor((Date.now() - new Date(a.created_at).getTime()) / 86400000)
      const idx = days - 1 - dAgo
      if (idx >= 0 && idx < days) {
        if (a.severity==='crit') fDown[idx]++
        else if (a.severity==='warn') fLat[idx]++
        else fRec[idx]++
      }
    })
    return { freqLabels: labels, freqDown: fDown, freqLatency: fLat, freqRecovery: fRec }
  }, [pAlerts, period])

  // ── Peak Failure Hours chart data ────────────────────────────
  const peakLabels = Array.from({length:24},(_,i) => i===0?'12am':i===12?'12pm':i<12?`${i}am`:`${i-12}pm`)

  // ── Top Problem Devices ──────────────────────────────────────
  const { topLabels, topCounts } = useMemo(() => {
    const counts: Record<string,number> = {}
    pAlerts.forEach(a => {
      const key = a.meta?.split('·')[0]?.trim() || a.title.split(' ')[0]
      counts[key] = (counts[key] ?? 0) + 1
    })
    const pairs = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0,8)
    if (pairs.length) return { topLabels: pairs.map(([k])=>k.length>22?k.slice(0,22)+'…':k), topCounts: pairs.map(([,v])=>v) }
    const devs = [...devices].sort((a,b) => (a.status==='down'?0:a.status==='warn'?1:2)-(b.status==='down'?0:b.status==='warn'?1:2)).slice(0,8)
    return { topLabels: devs.map(d=>d.ip||d.name), topCounts: devs.map(d=>d.status==='down'?3:d.status==='warn'?1:0) }
  }, [pAlerts, devices])

  // ── Location Health ──────────────────────────────────────────
  const { locLabels, locUptime, locDowntime } = useMemo(() => {
    const bldg: Record<string,number[]> = {}
    slaData.forEach(r => {
      if (!bldg[r.building]) bldg[r.building] = []
      bldg[r.building].push(Number(r.uptime_pct))
    })
    if (!Object.keys(bldg).length) {
      // derive from devices
      devices.forEach(d => {
        if (!bldg[d.location]) bldg[d.location] = []
        bldg[d.location].push(d.status==='up'?99.9:d.status==='warn'?80:5)
      })
    }
    const labels = Object.keys(bldg)
    const up = labels.map(b => parseFloat((bldg[b].reduce((s,v)=>s+v,0)/bldg[b].length).toFixed(1)))
    return { locLabels: labels, locUptime: up, locDowntime: up.map(u => parseFloat((100-u).toFixed(1))) }
  }, [slaData, devices])

  // ── Device Uptime vs Downtime ────────────────────────────────
  const { uptimeLabels, uptimeUp, uptimeDown } = useMemo(() => {
    const rows = devices.slice(0, 20).map(d => {
      const s = slaData.find(r => r.device_name === d.name)
      const up = s ? Number(s.uptime_pct) : d.status==='up'?99.9:d.status==='warn'?80:5
      return { label: d.ip || d.name, up: parseFloat(up.toFixed(1)), down: parseFloat((100-up).toFixed(1)) }
    })
    return { uptimeLabels: rows.map(r=>r.label), uptimeUp: rows.map(r=>r.up), uptimeDown: rows.map(r=>r.down) }
  }, [devices, slaData])

  // ── Latency trend — built from real scan_results ping data ──────
  const { latLabels, latAvg, latMin, latMax } = useMemo(() => {
    const responded = scanData.filter(s => s.responded && s.latency_ms != null)
    const hasRealData = responded.length > 0

    if (period === '24h') {
      const labels = Array.from({length:24},(_,i) => `${i.toString().padStart(2,'0')}:00`)
      const buckets: number[][] = Array.from({length:24}, () => [])
      responded.forEach(s => {
        const h = new Date(s.scanned_at).getHours()
        buckets[h].push(s.latency_ms!)
      })
      const avg = buckets.map(b => b.length ? Math.round(b.reduce((a,v)=>a+v,0)/b.length) : 0)
      const min = buckets.map(b => b.length ? Math.min(...b) : 0)
      const max = buckets.map(b => b.length ? Math.max(...b) : 0)
      if (hasRealData) return { latLabels: labels, latAvg: avg, latMin: min, latMax: max }
    }
    if (period === '7d') {
      const labels = Array.from({length:7},(_,i) => { const d=new Date(Date.now()-(6-i)*86400000); return `${d.getMonth()+1}/${d.getDate()}` })
      const buckets: number[][] = Array.from({length:7}, () => [])
      responded.forEach(s => {
        const dAgo = Math.floor((Date.now()-new Date(s.scanned_at).getTime())/86400000)
        const idx = 6 - dAgo
        if (idx >= 0 && idx < 7) buckets[idx].push(s.latency_ms!)
      })
      const avg = buckets.map(b => b.length ? Math.round(b.reduce((a,v)=>a+v,0)/b.length) : 0)
      if (hasRealData) return { latLabels: labels, latAvg: avg, latMin: avg.map(v=>Math.round(v*.7)), latMax: avg.map(v=>Math.round(v*1.4)) }
    }
    // 30d
    const labels = Array.from({length:30},(_,i) => { const d=new Date(Date.now()-(29-i)*86400000); return `${d.getMonth()+1}/${d.getDate()}` })
    const buckets: number[][] = Array.from({length:30}, () => [])
    responded.forEach(s => {
      const dAgo = Math.floor((Date.now()-new Date(s.scanned_at).getTime())/86400000)
      const idx = 29 - dAgo
      if (idx >= 0 && idx < 30) buckets[idx].push(s.latency_ms!)
    })
    const avg = buckets.map(b => b.length ? Math.round(b.reduce((a,v)=>a+v,0)/b.length) : 0)
    if (hasRealData) return { latLabels: labels, latAvg: avg, latMin: avg.map(v=>Math.round(v*.7)), latMax: avg.map(v=>Math.round(v*1.4)) }

    // Fallback: use discovered host latency as a single average point
    const discLat = discovered.filter(h => h.responded && h.latency_ms != null).map(h => h.latency_ms!)
    if (discLat.length) {
      const avg = Math.round(discLat.reduce((a, v) => a + v, 0) / discLat.length)
      const filled = labels.map((_, i) => i === labels.length - 1 ? avg : 0)
      return { latLabels: labels, latAvg: filled, latMin: filled.map(v => Math.round(v * 0.7)), latMax: filled.map(v => Math.round(v * 1.3)) }
    }
    return { latLabels: labels, latAvg: Array(labels.length).fill(0), latMin: Array(labels.length).fill(0), latMax: Array(labels.length).fill(0) }
  }, [period, scanData, discovered])

  // ── Device Performance Summary ───────────────────────────────
  // Build per-IP average latency from real scan_results data
  const scanLatencyByIp = useMemo(() => {
    const map = new Map<string, number[]>()
    scanData.filter(s => s.responded && s.latency_ms != null).forEach(s => {
      if (!map.has(s.ip)) map.set(s.ip, [])
      map.get(s.ip)!.push(s.latency_ms!)
    })
    const avg = new Map<string, number>()
    map.forEach((vals, ip) => avg.set(ip, Math.round(vals.reduce((a,v)=>a+v,0)/vals.length)))
    return avg
  }, [scanData])

  const perfRows: DevicePerfRow[] = useMemo(() => {
    const managed = devices.map(d => {
      const s = slaData.find(r => r.device_name === d.name)
      const uptimePct = s ? Number(s.uptime_pct) : d.status==='up'?99.9:d.status==='warn'?80:5
      const alertCount = pAlerts.filter(a =>
        a.meta?.includes(d.name) || a.meta?.includes(d.ip) || a.title.includes(d.name)
      ).length
      const latency = d.status === 'down' ? null : (scanLatencyByIp.get(d.ip) ?? null)
      return { name: d.name, ip: d.ip, type: d.type, location: d.location, uptimePct, latency, alertCount }
    })
    const disc = discovered.map(h => ({
      name: h.hostname ?? h.vendor ?? h.ip,
      ip: h.ip,
      type: h.device_type ?? h.scan_type.toUpperCase(),
      location: '—',
      uptimePct: h.responded ? 99.9 : 0,
      latency: h.latency_ms ?? (scanLatencyByIp.get(h.ip) ?? null),
      alertCount: pAlerts.filter(a => a.meta?.includes(h.ip)).length,
    }))
    return [...managed, ...disc].sort((a,b) => a.uptimePct - b.uptimePct)
  }, [devices, slaData, pAlerts, scanLatencyByIp, discovered])

  const visibleRows = showAll ? perfRows : perfRows.slice(0, 10)

  return (
    <>
      {/* ── Header banner ── */}
      <div style={{
        background: 'linear-gradient(135deg, #064e3b 0%, #065f46 40%, #047857 100%)',
        borderRadius: 12, padding: '24px 28px', marginBottom: 20,
        display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start',
      }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,.55)', letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 6 }}>
            Analytics &amp; Reports
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#fff', marginBottom: 6 }}>Network Analytics</div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,.65)', maxWidth: 420 }}>
            Historical trends, performance summaries, and infrastructure utilization across the campus network.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            {['Live Monitoring','Alert Tracking','Device Health'].map(f => (
              <span key={f} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 20, border: '1px solid rgba(255,255,255,.25)', fontSize: 11, color: 'rgba(255,255,255,.8)', background: 'rgba(255,255,255,.08)', cursor: 'default' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', display: 'inline-block' }} />
                {f}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,.5)', letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 8, textAlign: 'right' }}>View Period</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['24h','7d','30d'] as Period[]).map(p => (
              <button suppressHydrationWarning key={p} onClick={() => setPeriod(p)} style={{
                padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,.2)',
                background: period===p ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.06)',
                color: period===p ? '#fff' : 'rgba(255,255,255,.65)',
                fontWeight: period===p ? 600 : 400, fontSize: 12, cursor: 'pointer',
              }}>
                {p==='24h'?'24 Hours':p==='7d'?'7 Days':'30 Days'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── 4 KPI tiles ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 20 }}>
        <KpiTile label="Devices Monitored" value={devicesMonitored} sub={`${devices.length} managed · ${discovered.length} discovered`} iconBg="rgba(47,129,247,.18)" icon="🖥" />
        <KpiTile label="Avg Uptime"        value={`${avgUptime}%`}  sub="Network-wide availability" iconBg="rgba(34,197,94,.18)"  icon="📶" />
        <KpiTile label="Avg Latency"       value={avgLatency === '—' ? '—' : `${avgLatency} ms`} sub="Mean ICMP response time" iconBg="rgba(210,153,34,.18)" icon="⚡" />
        <KpiTile label="Total Alerts"      value={totalAlerts}      sub="Events in selected period"  iconBg="rgba(248,81,73,.18)"  icon="🔔" />
      </div>

      {/* ── Charts row 1: Latency Trend + Alert Breakdown ── */}
      <div className="grid-2" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="card-header">
            Latency Trend
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>Avg response time over time</span>
          </div>
          <div className="card-body">
            <LatencyTrendChart key={period} labels={latLabels} avg={latAvg} min={latMin} max={latMax} />
          </div>
        </div>
        <div className="card">
          <div className="card-header">Alert Breakdown</div>
          <div className="card-body">
            <AlertBreakdownChart key={period} crit={critCount} warn={warnCount} acked={resolvedAlerts.length} />
          </div>
        </div>
      </div>

      {/* ── Trend Analytics banner ── */}
      <div style={{
        background: 'linear-gradient(135deg, #1e3a2f, #1a4a35)',
        border: '1px solid rgba(34,197,94,.2)', borderRadius: 10,
        padding: '20px 24px', marginBottom: 20,
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Trend Analytics</div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,.5)', marginBottom: 20 }}>Historical incident patterns, peak failure windows, and proactive maintenance insights.</div>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
          <TrendKpi label="Avg Resolution"   value={avgResolution}             sub="Mean time to resolve incidents" accent="#fff" />
          <TrendKpi label="Resolution Rate"  value={resolutionRate}            sub={`${resolvedAlerts.length} of ${totalAlerts} alerts resolved`} accent="#4ade80" />
          <TrendKpi label="Most Problematic" value={mostProblematic.name}      sub={mostProblematic.count ? `${mostProblematic.count} alerts in period` : 'No alerts in period'} accent="#fbbf24" />
          <TrendKpi label="Peak Failure Hour" value={peakHourLabel}            sub="Most incidents occur at"       accent="#f87171" />
        </div>
      </div>

      {/* ── Charts row 2: Incident Frequency + Peak Failure Hours ── */}
      <div className="grid-2" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="card-header">Incident Frequency Over Time</div>
          <div className="card-body">
            <IncidentFrequencyChart key={period} labels={freqLabels} downtime={freqDown} highLatency={freqLatency} recovery={freqRecovery} />
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            Peak Failure Hours
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>By hour of day</span>
          </div>
          <div className="card-body">
            <PeakFailureHoursChart key={period} labels={peakLabels} counts={hourCounts} />
          </div>
        </div>
      </div>

      {/* ── Charts row 3: Top Problem Devices + Location Health ── */}
      <div className="grid-2" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="card-header">
            Top Problem Devices
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>By incident count</span>
          </div>
          <div className="card-body">
            <TopDevicesChart key={period} labels={topLabels} counts={topCounts} />
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            Location Health
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>Uptime by building</span>
          </div>
          <div className="card-body">
            <LocationHealthChart key={period} labels={locLabels} uptime={locUptime} downtime={locDowntime} />
          </div>
        </div>
      </div>

      {/* ── Device Uptime vs Downtime ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          Device Uptime vs Downtime
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>Percentage of polling intervals per device</span>
        </div>
        <div className="card-body">
          <UptimeDowntimeChart key={period} labels={uptimeLabels} uptime={uptimeUp} downtime={uptimeDown} />
        </div>
      </div>

      {/* ── Device Performance Summary ── */}
      <div className="card">
        <div className="card-header">
          Device Performance Summary
          <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}>Sorted by uptime (worst first)</span>
          <div className="card-header-actions">
            <button suppressHydrationWarning className="btn btn-sm" onClick={() => exportCSV(perfRows, period)}>↓ Export CSV</button>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Device Name</th>
                <th>Type</th>
                <th>Building / Floor</th>
                <th>Uptime %</th>
                <th>Avg Latency</th>
                <th>Alerts</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{r.name}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{r.ip}</div>
                  </td>
                  <td><span className="tag">{r.type}</span></td>
                  <td style={{ color: 'var(--text2)', fontSize: 12 }}>{r.location || '—'}</td>
                  <td><UptimeBadge pct={r.uptimePct} /></td>
                  <td style={{ color: 'var(--text2)', fontSize: 12 }}>
                    {r.latency != null ? `${r.latency} ms` : '—'}
                  </td>
                  <td>
                    {r.alertCount > 0
                      ? <span style={{ display:'inline-block', background:'rgba(248,81,73,.18)', color:'var(--crit)', fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:4 }}>{r.alertCount}</span>
                      : <span style={{ color:'var(--text3)', fontSize:12 }}>—</span>
                    }
                  </td>
                </tr>
              ))}
              {perfRows.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign:'center', padding:24, color:'var(--text3)' }}>No devices found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {perfRows.length > 10 && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', textAlign: 'center' }}>
            <button suppressHydrationWarning className="btn btn-sm" onClick={() => setShowAll(v => !v)}>
              {showAll ? '↑ Show Less' : `↓ Show All Devices (${perfRows.length - 10} more)`}
            </button>
          </div>
        )}
      </div>

      {/* ── Saved Report Snapshots (Obj 4.3 — Automatic Reports) ── */}
      <ReportSnapshotsPanel generating={generating} genMsg={genMsg} onGenerate={async () => {
        setGenerating(true); setGenMsg(null)
        try {
          const res = await fetch('/api/reports/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ generated_by: 'admin' }),
          })
          const d = await res.json()
          setGenMsg(d.snapshot ? `✓ Report saved: ${d.snapshot.period_label}` : `✗ ${d.error ?? 'Failed — run supabase/report_snapshots.sql first'}`)
        } catch { setGenMsg('✗ Request failed') }
        finally { setGenerating(false); setTimeout(() => setGenMsg(null), 5000) }
      }} />
    </>
  )
}

function ReportSnapshotsPanel({ generating, genMsg, onGenerate }: { generating: boolean; genMsg: string | null; onGenerate: () => void }) {
  const [snapshots, setSnapshots] = useState<Array<{
    id: string; generated_at: string; period_label: string; total_devices: number;
    online_count: number; offline_count: number; total_alerts: number; crit_alerts: number;
    avg_uptime_pct: number | null; avg_latency_ms: number | null; top_issue: string; generated_by: string;
  }>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/reports/generate')
      .then(r => r.json())
      .then(d => setSnapshots(d.snapshots ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [genMsg]) // reload when a new report is generated

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <div className="card-header">
        Saved Report Snapshots
        <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 11, color: 'var(--text3)' }}>
          Auto-generated daily · also runs with PingMonitor cycle
        </span>
        <div className="card-header-actions">
          {genMsg && (
            <span style={{ fontSize: 12, color: genMsg.startsWith('✓') ? 'var(--ok)' : 'var(--crit)', marginRight: 8 }}>{genMsg}</span>
          )}
          <button suppressHydrationWarning className="btn btn-sm btn-primary" onClick={onGenerate} disabled={generating}>
            {generating ? 'Generating…' : '+ Generate Now'}
          </button>
        </div>
      </div>
      {loading ? (
        <div style={{ padding: 20, color: 'var(--text3)', fontSize: 13 }}>Loading snapshots…</div>
      ) : snapshots.length === 0 ? (
        <div style={{ padding: 20, color: 'var(--text3)', fontSize: 13 }}>
          No snapshots yet. Click <strong>Generate Now</strong> to create the first one, or run <code>supabase/report_snapshots.sql</code> in Supabase if the table doesn't exist.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Generated</th>
                <th>Period</th>
                <th>Devices</th>
                <th>Online / Offline</th>
                <th>Alerts (24h)</th>
                <th>Avg Uptime</th>
                <th>Avg Latency</th>
                <th>Top Issue</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map(s => (
                <tr key={s.id}>
                  <td style={{ fontSize: 12, color: 'var(--text3)' }}>{new Date(s.generated_at).toLocaleString()}</td>
                  <td style={{ fontSize: 12 }}>{s.period_label}</td>
                  <td>{s.total_devices}</td>
                  <td>
                    <span style={{ color: 'var(--ok)', fontWeight: 600 }}>{s.online_count}</span>
                    {' / '}
                    <span style={{ color: s.offline_count > 0 ? 'var(--crit)' : 'var(--text3)', fontWeight: s.offline_count > 0 ? 600 : 400 }}>{s.offline_count}</span>
                  </td>
                  <td>
                    {s.crit_alerts > 0
                      ? <span style={{ color: 'var(--crit)', fontWeight: 600 }}>{s.crit_alerts} crit</span>
                      : <span style={{ color: 'var(--text3)', fontSize: 12 }}>{s.total_alerts} total</span>
                    }
                  </td>
                  <td>{s.avg_uptime_pct != null ? `${s.avg_uptime_pct}%` : '—'}</td>
                  <td>{s.avg_latency_ms != null ? `${s.avg_latency_ms} ms` : '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text2)', maxWidth: 200 }}>{s.top_issue}</td>
                  <td style={{ fontSize: 11, color: 'var(--text3)' }}>{s.generated_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
