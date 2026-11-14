'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import type { Device, Alert } from '@/lib/database.types'
import { usePolling } from '@/lib/usePolling'
import {
  LatencyTrendChart, AlertBreakdownChart,
  IncidentFrequencyChart, PeakFailureHoursChart,
  TopDevicesChart, LocationHealthChart, UptimeDowntimeChart,
  SnmpTrafficVolumeChart, fmtBytes,
} from '@/components/ReportCharts'
import type { SnmpReport } from '@/lib/snmp-report'

function fmtRate(mbps: number | null) {
  if (mbps === null) return '—'
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Gbps`
  if (mbps >= 1)    return `${mbps.toFixed(2)} Mbps`
  return `${(mbps * 1000).toFixed(1)} Kbps`
}
function fmtMinutes(min: number) {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60), m = min % 60
  return h < 24 ? `${h}h ${m}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

type Period = '24h' | '7d' | '30d'

const PERIOD_MS: Record<Period, number> = {
  '24h': 86_400_000,
  '7d':  604_800_000,
  '30d': 2_592_000_000,
}


function uptimeColor(pct: number) {
  return pct >= 99 ? 'var(--ok)' : pct >= 90 ? 'var(--warn)' : 'var(--crit)'
}

function UptimeBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <span style={{ color: 'var(--text3)', fontSize: 12 }} title="No measurements in this period">—</span>
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

function downloadCSV(name: string, header: string[], rows: (string | number | null)[][]) {
  const cell = (v: string | number | null) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [header, ...rows].map(r => r.map(cell).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function exportCSV(rows: DevicePerfRow[], period: Period) {
  downloadCSV(`network-report-${period}-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Device Name', 'IP', 'Type', 'Location', 'Status', 'Uptime %', 'Downtime (min)', 'Avg Latency (ms)', 'Alerts'],
    rows.map(r => [r.name, r.ip, r.type, r.location, r.status, r.uptimePct, r.downMin, r.latency, r.alertCount]))
}

interface DevicePerfRow {
  name: string; ip: string; type: string; location: string; status: string
  uptimePct: number | null; downMin: number; latency: number | null; alertCount: number
}

// /api/reports/availability — measured by the agent each minute (poller/report-core.js)
interface Availability {
  period: Period; historyDays: number; measuredSince: string
  devices: Record<string, { upMin: number; downMin: number; unknownMin: number; uptimePct: number | null; avgLatencyMs: number | null }>
  trend: { bucket: string; avgMs: number | null; minMs: number | null; maxMs: number | null; samples: number; offlineDevices: number }[]
  incidents: { id: number; title: string; device: string | null; ip: string | null; location: string | null; method: string | null; rootCause: string | null; startedAt: string; resolvedAt: string | null; durationMs: number; open: boolean }[]
}

const STATUS_LABEL: Record<string, string> = { up: 'Online', warn: 'Warning', down: 'Offline', unreachable: 'Unreachable', unknown: 'Unknown', maint: 'Maintenance' }
const isUnassigned = (l: string | null | undefined) => !l || l === 'Unassigned'
const fmtDur = (ms: number) => fmtMinutes(Math.max(0, Math.round(ms / 60_000)))

export default function ReportsPage() {
  const [period,    setPeriod]    = useState<Period>('24h')
  const [devices,   setDevices]   = useState<Device[]>([])
  const [alerts,    setAlerts]    = useState<Alert[]>([])
  const [avail,     setAvail]     = useState<Availability | null>(null)
  const [availErr,  setAvailErr]  = useState<string | null>(null)
  const [showAll,   setShowAll]   = useState(false)
  const [showAllInc, setShowAllInc] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [genMsg,    setGenMsg]    = useState<string | null>(null)
  // Filters (device category, location, current status)
  const [typeF,     setTypeF]     = useState('')
  const [locF,      setLocF]      = useState('')
  const [statusF,   setStatusF]   = useState('')

  const load = useCallback(async () => {
    const since = new Date(Date.now() - PERIOD_MS[period]).toISOString()
    // Every alert in the period (one request returns at most 1000 rows)
    const all: Alert[] = []
    for (let from = 0; from < 20_000; from += 1000) {
      const { data } = await supabase.from('alerts').select('*').gte('created_at', since)
        .order('created_at', { ascending: false }).range(from, from + 999)
      all.push(...((data ?? []) as Alert[]))
      if (!data || data.length < 1000) break
    }
    const { data: d } = await supabase.from('devices').select('*').order('name')
    setDevices((d ?? []) as Device[])
    setAlerts(all)
  }, [period])

  useEffect(() => { load() }, [load])
  // Keep data current without a manual refresh
  usePolling(load, 30_000)

  const loadAvail = useCallback(async () => {
    try {
      const r = await fetch(`/api/reports/availability?period=${period}`)
      const d = await r.json()
      if (r.ok) { setAvail(d); setAvailErr(null) } else setAvailErr(d.error ?? 'Could not load measurements')
    } catch { /* keep the last data */ }
  }, [period])
  useEffect(() => { loadAvail() }, [loadAvail])
  usePolling(loadAvail, 60_000)
  // Only use measurements for the selected period
  const av = avail && avail.period === period ? avail : null

  // ── SNMP devices: uptime + traffic from stored history (server-side) ──
  const [snmpReport, setSnmpReport] = useState<SnmpReport | null>(null)
  const loadSnmp = useCallback(async () => {
    try {
      const r = await fetch(`/api/reports/snmp?period=${period}`)
      if (r.ok) setSnmpReport(await r.json())
    } catch { /* keep the last report */ }
  }, [period])
  useEffect(() => { loadSnmp() }, [loadSnmp])
  usePolling(loadSnmp, 60_000)

  // ── Filters ──────────────────────────────────────────────────
  const typeOptions = useMemo(() => [...new Set(devices.map(d => d.type))].sort(), [devices])
  const locOptions  = useMemo(() => [...new Set(devices.map(d => isUnassigned(d.location) ? 'Unassigned' : d.location))].sort(), [devices])
  const filtering = !!(typeF || locF || statusF)
  const fDevices = useMemo(() => devices.filter(d =>
    (!typeF || d.type === typeF) &&
    (!locF || (isUnassigned(d.location) ? 'Unassigned' : d.location) === locF) &&
    (!statusF || d.status === statusF)), [devices, typeF, locF, statusF])
  const fIps   = useMemo(() => new Set(fDevices.map(d => d.ip)), [fDevices])
  const fNames = useMemo(() => new Set(fDevices.map(d => d.name)), [fDevices])
  const alertIp = (a: Alert) => a.device_ip ?? a.meta?.match(/(?:IP:?|Device address) ([\d.]+)/)?.[1] ?? null
  const matchesFilter = useCallback((a: Alert) => {
    if (!filtering) return true
    const ip = alertIp(a)
    return (!!ip && fIps.has(ip)) || (!!a.device_name && fNames.has(a.device_name))
  }, [filtering, fIps, fNames])

  const snmp = useMemo(() => {
    // Only a report for the selected period (ignore one still arriving for the previous period)
    const all = snmpReport && snmpReport.period === period ? snmpReport.devices : null
    if (!all) return null
    const devs = filtering ? all.filter(d => fNames.has(d.name)) : all
    const measured = devs.filter(d => d.uptimePct !== null)
    const withTraffic = devs.filter(d => d.avgInMbps !== null)
    return {
      devs,
      upLabels:   measured.map(d => `${d.name} (${d.ip})`),
      upPct:      measured.map(d => d.uptimePct!),
      downPct:    measured.map(d => Math.round((100 - d.uptimePct!) * 10) / 10),
      trLabels:   withTraffic.map(d => `${d.name} (${d.ip})`),
      trIn:       withTraffic.map(d => d.inBytes),
      trOut:      withTraffic.map(d => d.outBytes),
      measuredMin: Math.max(0, ...devs.map(d => d.upMin + d.downMin + d.unknownMin)),
    }
  }, [snmpReport, period, filtering, fNames])

  // ── Period-filtered alerts ───────────────────────────────────
  const pAlerts = useMemo(() => alerts.filter(matchesFilter), [alerts, matchesFilter])

  // ── KPIs (measured) ──────────────────────────────────────────
  const devicesMonitored = fDevices.length
  const discoveredCount = fDevices.filter(d => d.source === 'discovered').length
  const measuredDevs = useMemo(() => fDevices.map(d => av?.devices[d.id]).filter(a => a && a.uptimePct !== null), [fDevices, av])
  const avgUptime = measuredDevs.length
    ? (measuredDevs.reduce((s, a) => s + a!.uptimePct!, 0) / measuredDevs.length).toFixed(1)
    : '—'
  const avgLatency = useMemo(() => {
    const vals = fDevices.map(d => av?.devices[d.id]?.avgLatencyMs).filter((v): v is number => v != null)
    return vals.length ? (vals.reduce((a, v) => a + v, 0) / vals.length).toFixed(1) : '—'
  }, [fDevices, av])
  const measuredNote = period === '30d' && av ? `measured each minute · last ${av.historyDays} days kept` : 'measured each minute'
  const totalAlerts = pAlerts.length
  const critCount = pAlerts.filter(a => a.severity === 'crit').length
  const warnCount = pAlerts.filter(a => a.severity === 'warn').length

  // ── Trend KPIs ───────────────────────────────────────────────
  const hourCounts = useMemo(() => {
    const arr = Array(24).fill(0)
    pAlerts.forEach(a => { if (a.severity !== 'info') arr[new Date(a.created_at).getHours()]++ })
    return arr
  }, [pAlerts])
  const peakHourIdx = hourCounts.indexOf(Math.max(...hourCounts))
  const peakHourLabel = !hourCounts.some(Boolean) ? '—' : (() => {
    const h = peakHourIdx % 12 || 12
    return `${h} ${peakHourIdx < 12 ? 'AM' : 'PM'}`
  })()

  // Device an alert belongs to (name, else its address)
  const alertKey = (a: Alert) => a.device_name || alertIp(a) || a.meta?.split('·')[0]?.trim() || a.title
  const problemCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    pAlerts.forEach(a => { if (a.severity !== 'info') counts[alertKey(a)] = (counts[alertKey(a)] ?? 0) + 1 })
    return Object.entries(counts).sort((a, b) => b[1] - a[1])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pAlerts])
  const mostProblematic = problemCounts[0] ? { name: problemCounts[0][0].slice(0, 18), count: problemCounts[0][1] } : { name: '—', count: 0 }

  // Resolution rate = problems (critical + warning) resolved / raised
  const problems = pAlerts.filter(a => a.severity !== 'info')
  const resolvedAlerts = problems.filter(a => a.resolved_at)
  const resolutionRate = problems.length === 0 ? '—' : `${Math.round(resolvedAlerts.length / problems.length * 100)}%`

  // Avg resolution time = mean of (resolved_at - created_at) of resolved problems
  const avgResolution = useMemo(() => {
    if (!resolvedAlerts.length) return '—'
    const avgMs = resolvedAlerts.reduce((s, a) => s + (new Date(a.resolved_at!).getTime() - new Date(a.created_at).getTime()), 0) / resolvedAlerts.length
    return fmtDur(avgMs)
  }, [resolvedAlerts])

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

  // ── Top Problem Devices (critical + warning alerts) ──────────
  const topPairs = problemCounts.slice(0, 8)
  const topLabels = topPairs.map(([k]) => k.length > 22 ? k.slice(0, 22) + '…' : k)
  const topCounts = topPairs.map(([, v]) => v)

  // ── Location Health (measured minutes Online, per location) ───
  const { locLabels, locUptime, locDowntime } = useMemo(() => {
    const acc: Record<string, { up: number; down: number }> = {}
    for (const d of fDevices) {
      const a = av?.devices[d.id]
      if (!a || a.upMin + a.downMin === 0) continue
      const loc = isUnassigned(d.location) ? 'Unassigned' : d.location
      acc[loc] ??= { up: 0, down: 0 }
      acc[loc].up += a.upMin
      acc[loc].down += a.downMin
    }
    const labels = Object.keys(acc).sort((a, b) => Number(a === 'Unassigned') - Number(b === 'Unassigned') || a.localeCompare(b))
    const up = labels.map(l => Math.round((acc[l].up / (acc[l].up + acc[l].down)) * 1000) / 10)
    return { locLabels: labels, locUptime: up, locDowntime: up.map(u => Math.round((100 - u) * 10) / 10) }
  }, [fDevices, av])

  // ── Device Uptime vs Downtime (measured, least available first) ─
  const { uptimeLabels, uptimeUp, uptimeDown } = useMemo(() => {
    const rows = fDevices
      .map(d => ({ d, a: av?.devices[d.id] }))
      .filter(x => x.a && x.a.uptimePct !== null)
      .sort((x, y) => x.a!.uptimePct! - y.a!.uptimePct!)
      .slice(0, 20)
    return {
      uptimeLabels: rows.map(r => `${r.d.name} (${r.d.ip})`),
      uptimeUp: rows.map(r => r.a!.uptimePct!),
      uptimeDown: rows.map(r => Math.round((100 - r.a!.uptimePct!) * 10) / 10),
    }
  }, [fDevices, av])

  // ── Latency trend (latency_samples, all devices) ─────────────
  const { latLabels, latAvg, latMin, latMax } = useMemo(() => {
    const t = av?.trend ?? []
    const label = (iso: string) => {
      const d = new Date(iso)
      const hh = `${d.getHours().toString().padStart(2, '0')}:00`
      return period === '24h' ? hh : period === '7d' ? `${d.getMonth() + 1}/${d.getDate()} ${hh}` : `${d.getMonth() + 1}/${d.getDate()}`
    }
    return {
      latLabels: t.map(r => label(r.bucket)),
      latAvg: t.map(r => r.avgMs) as number[],
      latMin: t.map(r => r.minMs) as number[],
      latMax: t.map(r => r.maxMs) as number[],
    }
  }, [av, period])

  // ── Device Performance Summary ───────────────────────────────
  const perfRows: DevicePerfRow[] = useMemo(() => {
    const counts = new Map<string, number>()
    pAlerts.forEach(a => { if (a.severity !== 'info') counts.set(alertKey(a), (counts.get(alertKey(a)) ?? 0) + 1) })
    return fDevices.map(d => {
      const a = av?.devices[d.id]
      return {
        name: d.name, ip: d.ip, type: d.type, location: isUnassigned(d.location) ? 'Unassigned' : d.location,
        status: STATUS_LABEL[d.status] ?? d.status,
        uptimePct: a?.uptimePct ?? null, downMin: a?.downMin ?? 0, latency: a?.avgLatencyMs ?? null,
        alertCount: (counts.get(d.name) ?? 0) + (d.name !== d.ip ? counts.get(d.ip) ?? 0 : 0),
      }
    }).sort((x, y) => (x.uptimePct ?? 101) - (y.uptimePct ?? 101) || y.alertCount - x.alertCount)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fDevices, av, pAlerts])

  // ── Critical incidents (urgent issues, with duration) ────────
  const incidents = useMemo(() => (av?.incidents ?? []).filter(i =>
    !filtering || (!!i.ip && fIps.has(i.ip)) || (!!i.device && fNames.has(i.device))), [av, filtering, fIps, fNames])
  const openIncidents = incidents.filter(i => i.open).length
  const visibleInc = showAllInc ? incidents : incidents.slice(0, 10)

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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
        <KpiTile label="Devices Monitored" value={devicesMonitored} sub={`${devicesMonitored - discoveredCount} added · ${discoveredCount} discovered`} iconBg="rgba(47,129,247,.18)" icon="🖥" />
        <KpiTile label="Avg Uptime"        value={avgUptime === '—' ? '—' : `${avgUptime}%`}  sub={`${measuredDevs.length} device(s) · ${measuredNote}`} iconBg="rgba(34,197,94,.18)"  icon="📶" />
        <KpiTile label="Avg Latency"       value={avgLatency === '—' ? '—' : `${avgLatency} ms`} sub="Mean ICMP response time" iconBg="rgba(210,153,34,.18)" icon="⚡" />
        <KpiTile label="Total Alerts"      value={totalAlerts}      sub={`${critCount} critical · ${warnCount} warning`}  iconBg="rgba(248,81,73,.18)"  icon="🔔" />
      </div>

      {/* ── Filters ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', padding: '12px 16px' }}>
          <strong style={{ fontSize: 13 }}>Filter</strong>
          <select suppressHydrationWarning className="form-select" style={{ width: 'auto' }} value={typeF} onChange={e => setTypeF(e.target.value)}>
            <option value="">All device types</option>
            {typeOptions.map(t => <option key={t}>{t}</option>)}
          </select>
          <select suppressHydrationWarning className="form-select" style={{ width: 'auto' }} value={locF} onChange={e => setLocF(e.target.value)}>
            <option value="">All locations</option>
            {locOptions.map(l => <option key={l}>{l}</option>)}
          </select>
          <select suppressHydrationWarning className="form-select" style={{ width: 'auto' }} value={statusF} onChange={e => setStatusF(e.target.value)}>
            <option value="">Any status</option>
            {['up', 'warn', 'unreachable', 'down', 'unknown', 'maint'].map(s => <option key={s} value={s}>{STATUS_LABEL[s]} (now)</option>)}
          </select>
          {filtering && <button suppressHydrationWarning className="btn btn-sm" onClick={() => { setTypeF(''); setLocF(''); setStatusF('') }}>Clear</button>}
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text3)' }}>
            {filtering ? `${fDevices.length} of ${devices.length} devices` : `${devices.length} devices`} · alerts, uptime, incidents and the tables follow the filter
          </span>
        </div>
        {availErr && <div style={{ padding: '0 16px 12px', fontSize: 12, color: 'var(--crit)' }}>Measurements unavailable: {availErr}</div>}
      </div>

      {/* ── Charts row 1: Latency Trend + Alert Breakdown ── */}
      <div className="grid-2" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="card-header">
            Latency Trend
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>
              Ping time of all devices, {period === '24h' ? 'hourly' : period === '7d' ? 'every 6 h' : `daily · last ${av?.historyDays ?? 7} days kept`}
            </span>
          </div>
          <div className="card-body">
            {latLabels.length
              ? <LatencyTrendChart key={`${period}-${latLabels.length}`} labels={latLabels} avg={latAvg} min={latMin} max={latMax} />
              : <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>{av ? 'No latency measured in this period' : 'Loading measurements…'}</div>}
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
          <TrendKpi label="Resolution Rate"  value={resolutionRate}            sub={`${resolvedAlerts.length} of ${problems.length} problems resolved`} accent="#4ade80" />
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
            {topLabels.length
              ? <TopDevicesChart key={`${period}-${topLabels.join()}`} labels={topLabels} counts={topCounts} />
              : <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>No critical or warning alerts in this period</div>}
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            Location Health
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>Measured uptime by location</span>
          </div>
          <div className="card-body">
            {locLabels.length
              ? <LocationHealthChart key={`${period}-${locLabels.join()}`} labels={locLabels} uptime={locUptime} downtime={locDowntime} />
              : <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>{av ? 'No measurements in this period' : 'Loading measurements…'}</div>}
          </div>
        </div>
      </div>

      {/* ── Device Uptime vs Downtime ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          Device Uptime vs Downtime
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>Share of measured minutes Online · least available first (up to 20)</span>
        </div>
        <div className="card-body">
          {uptimeLabels.length
            ? <UptimeDowntimeChart key={`${period}-${uptimeLabels.join()}`} labels={uptimeLabels} uptime={uptimeUp} downtime={uptimeDown} />
            : <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>{av ? 'No measurements in this period' : 'Loading measurements…'}</div>}
        </div>
      </div>

      {/* ── Critical incidents (urgent network issues) ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          Critical Incidents
          <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}>
            {incidents.length} in this period · {openIncidents} still open · from the agent&apos;s alerts
          </span>
          <div className="card-header-actions">
            <button suppressHydrationWarning className="btn btn-sm" disabled={!incidents.length} onClick={() => downloadCSV(
              `incidents-${period}-${new Date().toISOString().slice(0, 10)}.csv`,
              ['Incident', 'Device', 'IP', 'Location', 'Started', 'Resolved', 'Duration (min)', 'Detected by', 'Cause'],
              incidents.map(i => [i.title, i.device, i.ip, i.location, new Date(i.startedAt).toLocaleString(), i.resolvedAt ? new Date(i.resolvedAt).toLocaleString() : 'open',
                Math.round(i.durationMs / 60_000), i.method, i.rootCause]))}>↓ Export CSV</button>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Incident</th><th>Location</th><th>Started</th><th>Duration</th><th>Detected by</th><th>Cause</th></tr></thead>
            <tbody>
              {visibleInc.map(i => (
                <tr key={i.id}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{i.title}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{i.ip ?? '—'}</div>
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>{i.location ?? '—'}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{new Date(i.startedAt).toLocaleString()}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    {i.open ? <span className="chip chip-crit">Open · {fmtDur(i.durationMs)}</span> : fmtDur(i.durationMs)}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>{i.method ?? '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text2)', maxWidth: 320 }}>{i.rootCause ?? '—'}</td>
                </tr>
              ))}
              {!incidents.length && (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: 24, color: 'var(--text3)' }}>{av ? 'No critical incidents in this period.' : 'Loading…'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {incidents.length > 10 && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', textAlign: 'center' }}>
            <button suppressHydrationWarning className="btn btn-sm" onClick={() => setShowAllInc(v => !v)}>
              {showAllInc ? '↑ Show Less' : `↓ Show All Incidents (${incidents.length - 10} more)`}
            </button>
          </div>
        )}
      </div>

      {/* ── SNMP Devices (hidden when there are no SNMP devices) ── */}
      {snmp && snmp.devs.length > 0 && (
        <>
          <div className="grid-2" style={{ marginBottom: 20 }}>
            <div className="card">
              <div className="card-header">
                SNMP Devices — Uptime vs Downtime
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}>
                  measured each minute · {fmtMinutes(snmp.measuredMin)} recorded
                  {period === '30d' && ` (uptime history kept ${snmpReport?.historyDays ?? 7} days)`}
                </span>
              </div>
              <div className="card-body">
                {snmp.upLabels.length
                  ? <UptimeDowntimeChart key={`snmp-up-${period}`} labels={snmp.upLabels} uptime={snmp.upPct} downtime={snmp.downPct} />
                  : <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>No measurements in this period</div>}
              </div>
            </div>
            <div className="card">
              <div className="card-header">
                SNMP Devices — Traffic
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}>data transferred in this period</span>
              </div>
              <div className="card-body">
                {snmp.trLabels.length
                  ? <SnmpTrafficVolumeChart key={`snmp-tr-${period}`} labels={snmp.trLabels} inBytes={snmp.trIn} outBytes={snmp.trOut} />
                  : <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>No measurements in this period</div>}
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              SNMP Device Summary
              <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}>from SNMP polls and per-minute status checks</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Device</th><th>Type</th><th>Uptime</th><th>Downtime</th>
                    <th>Data In / Out</th><th>Avg In / Out</th><th>Peak In / Out</th><th>CPU / Mem (now)</th>
                  </tr>
                </thead>
                <tbody>
                  {snmp.devs.map(d => (
                    <tr key={d.id}>
                      <td>
                        <strong>{d.name}</strong>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{d.ip}</div>
                      </td>
                      <td><span className="tag">{d.type}</span></td>
                      <td>{d.uptimePct !== null ? <UptimeBadge pct={d.uptimePct} /> : <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                      <td style={{ fontSize: 12 }}>
                        {d.uptimePct !== null ? fmtMinutes(d.downMin) : '—'}
                        {d.unknownMin > 0 && <div style={{ fontSize: 11, color: 'var(--text3)' }}>{fmtMinutes(d.unknownMin)} not measured</div>}
                      </td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                        {d.avgInMbps !== null ? <><span style={{ color: '#2f81f7' }}>↓ {fmtBytes(d.inBytes)}</span> / <span style={{ color: '#3fb950' }}>↑ {fmtBytes(d.outBytes)}</span></> : '—'}
                      </td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtRate(d.avgInMbps)} / {fmtRate(d.avgOutMbps)}</td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtRate(d.peakInMbps)} / {fmtRate(d.peakOutMbps)}</td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{d.cpu}% / {d.mem}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── Device Performance Summary ── */}
      <div className="card">
        <div className="card-header">
          Device Performance Summary
          <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}>Measured uptime, worst first · {measuredNote}</span>
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
                <th>Location</th>
                <th>Status</th>
                <th>Uptime %</th>
                <th>Downtime</th>
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
                  <td style={{ fontSize: 12 }}>{r.status}</td>
                  <td><UptimeBadge pct={r.uptimePct} /></td>
                  <td style={{ color: 'var(--text2)', fontSize: 12 }}>{r.uptimePct !== null ? fmtMinutes(r.downMin) : '—'}</td>
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
                <tr><td colSpan={8} style={{ textAlign:'center', padding:24, color:'var(--text3)' }}>No devices found.</td></tr>
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
          Made daily by the monitoring agent (and emailed to recipients with &quot;daily report&quot; on) · or on demand
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
