'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
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
import Pagination, { usePager, clampPage } from '@/components/Pagination'
import DeviceAvailabilityCard, { deviceStatusView, StatusChip, ago } from '@/components/DeviceAvailabilityCard'

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

type Period = '24h' | '7d' | '30d' | 'custom'

const PERIOD_MS: Record<Exclude<Period, 'custom'>, number> = {
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

// Summary number, same card style as the dashboard
function KpiTile({ label, value, sub, accent }: { label: string; value: string | number; sub: string; accent: string }) {
  return (
    <div className="kpi" style={{ borderTop: `3px solid ${accent}` }}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={{ fontSize: 28 }}>{typeof value === 'number' ? value.toLocaleString() : value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  )
}

// Smaller figure inside the Trends card
function TrendKpi({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) {
  return (
    <div style={{ minWidth: 0, borderLeft: `3px solid ${accent}`, paddingLeft: 12 }}>
      <div className="kpi-label">{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
      <div className="kpi-sub" style={{ marginTop: 4 }}>{sub}</div>
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

function exportCSV(rows: DevicePerfRow[], label: string, periodText: string) {
  downloadCSV(`network-report-${label}-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Device Name', 'IP', 'Category', 'Location', 'Current Status', 'Total Uptime (min)', 'Total Downtime (min)', 'Uptime %', 'Downtime %',
      'Not Measured (min)', 'Last Seen', 'Avg Latency (ms)', 'Alerts', 'Reporting Period'],
    rows.map(r => [r.name, r.ip, r.type, r.location, r.status, r.upMin, r.downMin, r.uptimePct, r.downtimePct,
      r.notMeasuredMin, r.lastSeen ? new Date(r.lastSeen).toLocaleString() : '', r.latency, r.alertCount, periodText]))
}

// "2026-11-18" for <input type="date"> (local time)
const dayInput = (ms: number) => { const d = new Date(ms); return new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10) }
const MAX_RANGE_DAYS = 92
// The agent heartbeats every round (~15 s); older than this = not reporting
const AGENT_FRESH_MS = 90_000

interface DevicePerfRow {
  id: string; name: string; ip: string; type: string; location: string; status: string
  uptimePct: number | null; downtimePct: number | null; upMin: number; downMin: number; notMeasuredMin: number
  lastSeen: string | null; latency: number | null; alertCount: number
}

// /api/reports/availability — measured by the agent each minute (poller/report-core.js)
interface Availability {
  key: string                     // which range this answer is for (set by the page)
  period: Period; from: string; to: string; historyDays: number; measuredSince: string
  periodMin: number; measurableMin: number
  devices: Record<string, { upMin: number; downMin: number; unknownMin: number; uptimePct: number | null; avgLatencyMs: number | null; lastSample?: string | null; lastUp?: string | null }>
  trend: { bucket: string; avgMs: number | null; minMs: number | null; maxMs: number | null; samples: number; offlineDevices: number }[]
  incidents: { id: number; title: string; device: string | null; ip: string | null; location: string | null; method: string | null; rootCause: string | null; startedAt: string; resolvedAt: string | null; durationMs: number; open: boolean }[]
}

type Incident = Availability['incidents'][number]

// Critical incidents straight from the alerts table, one page at a time
// (same fields as core.incidents in poller/report-core.js)
const INC_COLS = 'id, title, meta, root_cause, created_at, resolved_at, device_name, device_ip, location, detection_method'
interface IncidentRow { id: number; title: string; meta: string | null; root_cause: string | null; created_at: string; resolved_at: string | null; device_name?: string | null; device_ip?: string | null; location?: string | null; detection_method?: string | null }
function toIncident(a: IncidentRow): Incident {
  const start = new Date(a.created_at).getTime()
  const end = a.resolved_at ? new Date(a.resolved_at).getTime() : Date.now()
  return {
    id: a.id, title: a.title,
    device: a.device_name ?? null, ip: a.device_ip ?? a.meta?.match(/IP: ([\d.]+)/)?.[1] ?? null,
    location: a.location ?? null, method: a.detection_method ?? null, rootCause: a.root_cause,
    startedAt: a.created_at, resolvedAt: a.resolved_at, durationMs: end - start, open: !a.resolved_at,
  }
}
// PostgREST list value: "a","b" (quotes escaped)
const pgList = (vals: Iterable<string>) => [...vals].map(v => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')

const STATUS_LABEL: Record<string, string> = { up: 'Online', warn: 'Warning', down: 'Offline', unreachable: 'Unreachable', unknown: 'Unknown', maint: 'Maintenance' }
const isUnassigned = (l: string | null | undefined) => !l || l === 'Unassigned'
const fmtDur = (ms: number) => fmtMinutes(Math.max(0, Math.round(ms / 60_000)))

export default function ReportsPage() {
  const [period,    setPeriod]    = useState<Period>('24h')
  const [devices,   setDevices]   = useState<Device[]>([])
  const [alerts,    setAlerts]    = useState<Alert[]>([])
  const [avail,     setAvail]     = useState<Availability | null>(null)
  const [availErr,  setAvailErr]  = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [genMsg,    setGenMsg]    = useState<string | null>(null)
  // Filters (device category, location, current status)
  const [typeF,     setTypeF]     = useState('')
  const [locF,      setLocF]      = useState('')
  const [statusF,   setStatusF]   = useState('')

  // ── Reporting period: a preset (rolls with the clock) or a custom date range ──
  const [customFrom, setCustomFrom] = useState(() => dayInput(Date.now() - 6 * 86_400_000))
  const [customTo,   setCustomTo]   = useState(() => dayInput(Date.now()))
  const customErr = period !== 'custom' ? null
    : !customFrom || !customTo ? 'Choose both dates'
    : customFrom > customTo ? 'The start date is after the end date'
    : (Date.parse(customTo) - Date.parse(customFrom)) / 86_400_000 + 1 > MAX_RANGE_DAYS ? `Choose at most ${MAX_RANGE_DAYS} days`
    : null
  const rangeKey = period === 'custom' ? `custom|${customFrom}|${customTo}` : period
  // Bounds at the moment of asking (ms)
  const bounds = useCallback(() => {
    const now = Date.now()
    if (period !== 'custom') return { from: now - PERIOD_MS[period], to: now, custom: false }
    const from = new Date(`${customFrom}T00:00:00`).getTime()
    const to = Math.min(new Date(`${customTo}T00:00:00`).getTime() + 86_400_000, now)
    return { from, to, custom: true }
  }, [period, customFrom, customTo])
  // Stable for a given selection (the server stops a range that includes today at "now")
  const rangeQuery = period === 'custom'
    ? `from=${encodeURIComponent(new Date(`${customFrom}T00:00:00`).toISOString())}&to=${encodeURIComponent(new Date(new Date(`${customTo}T00:00:00`).getTime() + 86_400_000).toISOString())}`
    : `period=${period}`
  const fileLabel = period === 'custom' ? `${customFrom}_to_${customTo}` : period
  const periodText = period === 'custom' ? `${customFrom} to ${customTo}` : { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' }[period]

  const load = useCallback(async () => {
    if (customErr) return
    const { from: fromMs, to: toMs, custom } = bounds()
    // Every alert in the period (one request returns at most 1000 rows)
    const all: Alert[] = []
    for (let from = 0; from < 20_000; from += 1000) {
      let q = supabase.from('alerts').select('*').gte('created_at', new Date(fromMs).toISOString())
      if (custom) q = q.lt('created_at', new Date(toMs).toISOString())
      const { data } = await q.order('created_at', { ascending: false }).range(from, from + 999)
      all.push(...((data ?? []) as Alert[]))
      if (!data || data.length < 1000) break
    }
    setAlerts(all)
  }, [bounds, customErr])

  useEffect(() => { load() }, [load])
  // Keep data current without a manual refresh
  usePolling(load, 30_000)

  // ── Current status: the devices table and the agent's heartbeat, kept live ──
  const [agentSeen, setAgentSeen] = useState<string | null | undefined>(undefined)   // undefined = not loaded yet
  const loadLive = useCallback(async () => {
    const [{ data: d }, { data: ag }] = await Promise.all([
      supabase.from('devices').select('*').order('name'),
      supabase.from('agent_status').select('last_seen').order('last_seen', { ascending: false }).limit(1),
    ])
    setDevices((d ?? []) as Device[])
    setAgentSeen((ag?.[0] as { last_seen?: string } | undefined)?.last_seen ?? null)
  }, [])
  useEffect(() => {
    loadLive()
    let t: ReturnType<typeof setTimeout> | null = null
    const soon = () => { if (t) clearTimeout(t); t = setTimeout(loadLive, 1000) }
    const ch = supabase.channel('reports-devices')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, soon)
      .subscribe()
    return () => { supabase.removeChannel(ch); if (t) clearTimeout(t) }
  }, [loadLive])
  usePolling(loadLive, 15_000)
  const agentFresh = !!agentSeen && Date.now() - Date.parse(agentSeen) < AGENT_FRESH_MS

  const loadAvail = useCallback(async () => {
    if (customErr) return
    const key = rangeKey
    try {
      const r = await fetch(`/api/reports/availability?${rangeQuery}`)
      const d = await r.json()
      if (r.ok) { setAvail({ ...d, key }); setAvailErr(null) } else setAvailErr(d.error ?? 'Could not load measurements')
    } catch { /* keep the last data */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey, customErr])
  useEffect(() => { loadAvail() }, [loadAvail])
  usePolling(loadAvail, 60_000)
  // Only use measurements for the selected period
  const av = avail && avail.key === rangeKey ? avail : null

  // ── SNMP devices: uptime + traffic from stored history (server-side) ──
  // (the SNMP report has the preset periods only)
  const [snmpReport, setSnmpReport] = useState<SnmpReport | null>(null)
  const loadSnmp = useCallback(async () => {
    if (period === 'custom') return
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
    const withTraffic = devs.filter(d => d.avgInMbps !== null)
    return {
      devs,
      trLabels:   withTraffic.map(d => `${d.name} (${d.ip})`),
      trIn:       withTraffic.map(d => d.inBytes),
      trOut:      withTraffic.map(d => d.outBytes),
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
  const measuredNote = av && av.measurableMin < av.periodMin ? `measured each minute · last ${av.historyDays} days kept` : 'measured each minute'
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
    const { from: fromMs, to: toMs } = bounds()
    if (toMs - fromMs <= 86_400_000 + 60_000) {
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
    // One bar per calendar day of the range
    const first = new Date(fromMs); first.setHours(0, 0, 0, 0)
    const days = Math.max(1, Math.ceil((toMs - first.getTime()) / 86400000))
    const labels = Array.from({length:days},(_,i) => {
      const d = new Date(first.getTime() + i*86400000 + 3600000)
      return `${d.getMonth()+1}/${d.getDate()}`
    })
    const fDown = Array(days).fill(0); const fLat = Array(days).fill(0); const fRec = Array(days).fill(0)
    pAlerts.forEach(a => {
      const day = new Date(a.created_at); day.setHours(0, 0, 0, 0)
      const idx = Math.round((day.getTime() - first.getTime()) / 86400000)
      if (idx >= 0 && idx < days) {
        if (a.severity==='crit') fDown[idx]++
        else if (a.severity==='warn') fLat[idx]++
        else fRec[idx]++
      }
    })
    return { freqLabels: labels, freqDown: fDown, freqLatency: fLat, freqRecovery: fRec }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pAlerts, rangeKey])

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

  // ── Device Uptime vs Downtime (measured; least or most available first, paged) ─
  const [uptimeOrder, setUptimeOrder] = useState<'least' | 'most'>('least')
  const uptimeRows = useMemo(() => fDevices
    .map(d => ({ d, a: av?.devices[d.id] }))
    .filter(x => x.a && x.a.uptimePct !== null)
    .sort((x, y) => uptimeOrder === 'least'
      ? x.a!.uptimePct! - y.a!.uptimePct! || y.a!.downMin - x.a!.downMin
      : y.a!.uptimePct! - x.a!.uptimePct! || y.a!.upMin - x.a!.upMin), [fDevices, av, uptimeOrder])
  const uptimePager = usePager(`${rangeKey}|${typeF}|${locF}|${statusF}|${uptimeOrder}`, 20)
  const uptimePage = clampPage(uptimePager.page, uptimePager.pageSize, uptimeRows.length)
  const { uptimeLabels, uptimeUp, uptimeDown, uptimeNotes } = useMemo(() => {
    const rows = uptimeRows.slice((uptimePage - 1) * uptimePager.pageSize, uptimePage * uptimePager.pageSize)
    // Measured minutes Online / Offline (the chart shows them as time)
    return {
      uptimeLabels: rows.map(r => `${r.d.name} (${r.d.ip})`),
      uptimeUp: rows.map(r => r.a!.upMin),
      uptimeDown: rows.map(r => r.a!.downMin),
      uptimeNotes: rows.map(r => `${agentFresh ? 'Now' : 'Last known'}: ${deviceStatusView(r.d, agentFresh).label}`),
    }
  }, [uptimeRows, uptimePage, uptimePager.pageSize, agentFresh])

  // ── Latency trend (latency_samples, all devices) ─────────────
  const { latLabels, latAvg, latMin, latMax } = useMemo(() => {
    const t = av?.trend ?? []
    const span = av ? Date.parse(av.to) - Date.parse(av.from) : 0
    const label = (iso: string) => {
      const d = new Date(iso)
      const hh = `${d.getHours().toString().padStart(2, '0')}:00`
      return span <= 86_400_000 + 60_000 ? hh : span <= 8 * 86_400_000 ? `${d.getMonth() + 1}/${d.getDate()} ${hh}` : `${d.getMonth() + 1}/${d.getDate()}`
    }
    return {
      latLabels: t.map(r => label(r.bucket)),
      latAvg: t.map(r => r.avgMs) as number[],
      latMin: t.map(r => r.minMs) as number[],
      latMax: t.map(r => r.maxMs) as number[],
    }
  }, [av])

  // ── Device Performance Summary ───────────────────────────────
  const perfRows: DevicePerfRow[] = useMemo(() => {
    const counts = new Map<string, number>()
    pAlerts.forEach(a => { if (a.severity !== 'info') counts.set(alertKey(a), (counts.get(alertKey(a)) ?? 0) + 1) })
    return fDevices.map(d => {
      const a = av?.devices[d.id]
      const up = a?.upMin ?? 0, down = a?.downMin ?? 0
      return {
        id: d.id, name: d.name, ip: d.ip, type: d.type, location: isUnassigned(d.location) ? 'Unassigned' : d.location,
        status: deviceStatusView(d, agentFresh).label + (agentFresh ? '' : ' (last known)'),
        uptimePct: a?.uptimePct ?? null,
        downtimePct: a?.uptimePct != null ? Math.round((100 - a.uptimePct) * 10) / 10 : null,
        upMin: up, downMin: down,
        // the whole period minus the minutes the agent could judge (on or off)
        notMeasuredMin: av ? Math.max(0, av.periodMin - up - down) : 0,
        lastSeen: d.last_seen ?? null,
        latency: a?.avgLatencyMs ?? null,
        alertCount: (counts.get(d.name) ?? 0) + (d.name !== d.ip ? counts.get(d.ip) ?? 0 : 0),
      }
    }).sort((x, y) => (x.uptimePct ?? 101) - (y.uptimePct ?? 101) || y.alertCount - x.alertCount)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fDevices, av, pAlerts, agentFresh])
  const devById = useMemo(() => new Map(devices.map(d => [d.id, d])), [devices])

  // ── Critical incidents (urgent issues, with duration) ────────
  // Paged in the database; the period and the device filter stay applied
  const filterKey = filtering ? `${pgList(fIps)}|${pgList(fNames)}` : ''
  const incPager = usePager(`${rangeKey}|${filterKey}`, 10)
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [incTotal, setIncTotal] = useState(0)
  const [openIncidents, setOpenIncidents] = useState(0)
  const [incLoading, setIncLoading] = useState(true)
  const [incErr, setIncErr] = useState<string | null>(null)
  const [exportingInc, setExportingInc] = useState(false)
  const incReq = useRef(0)
  // Later pages are a snapshot up to this time, so new incidents don't repeat rows across pages
  const incAnchor = useRef<string | null>(null)
  if (incPager.page === 1) incAnchor.current = null
  else if (!incAnchor.current) incAnchor.current = new Date().toISOString()

  const incQuery = useCallback((select: string, opts?: { count?: 'exact'; head?: boolean }) => {
    const { from, to, custom } = bounds()
    let q = supabase.from('alerts').select(select, opts).eq('severity', 'crit')
      .gte('created_at', new Date(from).toISOString())
    if (custom) q = q.lt('created_at', new Date(to).toISOString())
    if (filtering) {
      const ips = pgList(fIps), names = pgList(fNames)
      const parts = [ips && `device_ip.in.(${ips})`, names && `device_name.in.(${names})`].filter(Boolean)
      q = parts.length ? q.or(parts.join(',')) : q.eq('id', -1)    // filter matches no device
    }
    return q
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, filterKey, filtering])

  const loadIncidents = useCallback(async () => {
    const id = ++incReq.current
    setIncLoading(true)
    const { offset, pageSize, page } = incPager
    let q = incQuery(INC_COLS, { count: 'exact' })
    if (incAnchor.current) q = q.lte('created_at', incAnchor.current)
    const [rows, open] = await Promise.all([
      q.order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + pageSize - 1),
      incQuery('id', { count: 'exact', head: true }).is('resolved_at', null),
    ])
    if (id !== incReq.current) return
    setIncErr(rows.error?.message ?? null)
    setIncidents(((rows.data ?? []) as unknown as IncidentRow[]).map(toIncident))
    setIncTotal(rows.count ?? 0)
    setOpenIncidents(open.count ?? 0)
    setIncLoading(false)
    const last = clampPage(page, pageSize, rows.count ?? 0)
    if (last !== page) incPager.setPage(last)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incQuery, incPager.page, incPager.pageSize])
  useEffect(() => { loadIncidents() }, [loadIncidents])
  usePolling(loadIncidents, 30_000)

  // CSV: every incident that matches the period and filter, not just this page
  async function exportIncidents() {
    setExportingInc(true)
    try {
      const all: Incident[] = []
      for (let from = 0; from < 50_000; from += 1000) {
        const { data } = await incQuery(INC_COLS).order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, from + 999)
        all.push(...((data ?? []) as unknown as IncidentRow[]).map(toIncident))
        if (!data || data.length < 1000) break
      }
      downloadCSV(
        `incidents-${fileLabel}-${new Date().toISOString().slice(0, 10)}.csv`,
        ['Incident', 'Device', 'IP', 'Location', 'Started', 'Resolved', 'Duration (min)', 'Detected by', 'Cause'],
        all.map(i => [i.title, i.device, i.ip, i.location, new Date(i.startedAt).toLocaleString(), i.resolvedAt ? new Date(i.resolvedAt).toLocaleString() : 'open',
          Math.round(i.durationMs / 60_000), i.method, i.rootCause]))
    } finally { setExportingInc(false) }
  }

  // ── Device Performance Summary: one row per device, paged on screen ──
  // (computed from the measurements already loaded for the charts; export has every row)
  const perfPager = usePager(`${rangeKey}|${typeF}|${locF}|${statusF}`, 10)
  const perfPage = clampPage(perfPager.page, perfPager.pageSize, perfRows.length)
  const visibleRows = perfRows.slice((perfPage - 1) * perfPager.pageSize, perfPage * perfPager.pageSize)

  return (
    <>
      {/* ── Header: title + period ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>Network Analytics</div>
          <div style={{ fontSize: 13, color: 'var(--text3)', marginTop: 2 }}>Uptime, latency and alerts measured by the monitoring agent</div>
        </div>
        <div style={{ display: 'flex', gap: 2, padding: 3, background: 'var(--surface3)', borderRadius: 8 }}>
          {(['24h', '7d', '30d', 'custom'] as Period[]).map(p => (
            <button suppressHydrationWarning key={p} onClick={() => setPeriod(p)} style={{
              padding: '6px 14px', borderRadius: 6, border: 'none', fontSize: 12.5, cursor: 'pointer',
              fontWeight: 600, background: period === p ? 'var(--surface)' : 'transparent',
              color: period === p ? 'var(--accent2)' : 'var(--text2)',
              boxShadow: period === p ? '0 1px 3px rgba(15,23,42,.12)' : 'none',
            }}>
              {p === '24h' ? '24 hours' : p === '7d' ? '7 days' : p === '30d' ? '30 days' : 'Custom'}
            </button>
          ))}
        </div>
        {period === 'custom' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, width: '100%', justifyContent: 'flex-end' }}>
            <label style={{ fontSize: 12, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6 }}>
              From
              <input suppressHydrationWarning type="date" className="form-input" style={{ width: 'auto' }} value={customFrom}
                max={customTo || dayInput(Date.now())} onChange={e => setCustomFrom(e.target.value)} />
            </label>
            <label style={{ fontSize: 12, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6 }}>
              To
              <input suppressHydrationWarning type="date" className="form-input" style={{ width: 'auto' }} value={customTo}
                min={customFrom} max={dayInput(Date.now())} onChange={e => setCustomTo(e.target.value)} />
            </label>
            {customErr
              ? <span style={{ fontSize: 12, color: 'var(--crit)' }}>{customErr}</span>
              : <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>whole days, local time · uptime is measured for the last {av?.historyDays ?? 7} days only</span>}
          </div>
        )}
      </div>

      {/* ── Monitoring agent not reporting: statuses are the last ones it measured ── */}
      {agentSeen !== undefined && !agentFresh && (
        <div style={{
          marginBottom: 16, padding: '9px 14px', borderRadius: 'var(--r)', fontSize: 12.5, lineHeight: 1.5,
          background: 'rgba(217,119,6,.08)', border: '1px solid rgba(217,119,6,.25)', color: 'var(--text2)',
        }}>
          <strong style={{ color: 'var(--warn)' }}>Monitoring agent offline</strong>
          {agentSeen ? <> — last report {new Date(agentSeen).toLocaleString()} ({ago(agentSeen)}).</> : <> — it has not reported yet.</>}
          {' '}Current statuses show the last thing it measured. Time since then is counted as <em>not measured</em>, never as downtime.
        </div>
      )}

      {/* ── Summary ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 20 }}>
        <KpiTile label="Devices"     accent="var(--info)" value={devicesMonitored} sub={`${devicesMonitored - discoveredCount} added · ${discoveredCount} discovered`} />
        <KpiTile label="Avg uptime"  accent="var(--ok)"   value={avgUptime === '—' ? '—' : `${avgUptime}%`} sub={`${measuredDevs.length} devices measured`} />
        <KpiTile label="Avg latency" accent="var(--warn)" value={avgLatency === '—' ? '—' : `${avgLatency} ms`} sub="Ping response time" />
        <KpiTile label="Alerts"      accent="var(--crit)" value={totalAlerts} sub={`${critCount.toLocaleString()} critical · ${warnCount.toLocaleString()} warning`} />
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
              Ping time of all devices, {(() => {
                const span = av ? Date.parse(av.to) - Date.parse(av.from) : (period === '24h' ? 86_400_000 : period === '7d' ? 604_800_000 : 2_592_000_000)
                return span <= 2 * 86_400_000 + 60_000 ? 'hourly' : span <= 8 * 86_400_000 ? 'every 6 h' : `daily · last ${av?.historyDays ?? 7} days kept`
              })()}
            </span>
          </div>
          <div className="card-body">
            {latLabels.length
              ? <LatencyTrendChart key={`${rangeKey}-${latLabels.length}`} labels={latLabels} avg={latAvg} min={latMin} max={latMax} />
              : <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>{av ? 'No latency measured in this period' : 'Loading measurements…'}</div>}
          </div>
        </div>
        <div className="card">
          <div className="card-header">Alert Breakdown</div>
          <div className="card-body">
            <AlertBreakdownChart key={rangeKey} crit={critCount} warn={warnCount} acked={resolvedAlerts.length} />
          </div>
        </div>
      </div>

      {/* ── Trends ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          Trends
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}>Critical and warning alerts in this period</span>
        </div>
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 20 }}>
          <TrendKpi label="Avg resolution"    accent="var(--info)" value={avgResolution}        sub="Time to resolve a problem" />
          <TrendKpi label="Resolution rate"   accent="var(--ok)"   value={resolutionRate}       sub={`${resolvedAlerts.length.toLocaleString()} of ${problems.length.toLocaleString()} resolved`} />
          <TrendKpi label="Most problematic"  accent="var(--warn)" value={mostProblematic.name} sub={mostProblematic.count ? `${mostProblematic.count.toLocaleString()} alerts` : 'No alerts'} />
          <TrendKpi label="Peak failure hour" accent="var(--crit)" value={peakHourLabel}        sub="Most problems start" />
        </div>
      </div>

      {/* ── Charts row 2: Incident Frequency + Peak Failure Hours ── */}
      <div className="grid-2" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="card-header">Incident Frequency Over Time</div>
          <div className="card-body">
            <IncidentFrequencyChart key={rangeKey} labels={freqLabels} downtime={freqDown} highLatency={freqLatency} recovery={freqRecovery} />
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            Peak Failure Hours
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>By hour of day</span>
          </div>
          <div className="card-body">
            <PeakFailureHoursChart key={rangeKey} labels={peakLabels} counts={hourCounts} />
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
              ? <TopDevicesChart key={`${rangeKey}-${topLabels.join()}`} labels={topLabels} counts={topCounts} />
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
              ? <LocationHealthChart key={`${rangeKey}-${locLabels.join()}`} labels={locLabels} uptime={locUptime} downtime={locDowntime} />
              : <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>{av ? 'No measurements in this period' : 'Loading measurements…'}</div>}
          </div>
        </div>
      </div>

      {/* ── Device Uptime vs Downtime ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          Device Uptime vs Downtime
          <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}>Measured time Online vs Offline · hover for exact time and %</span>
          <div className="card-header-actions" style={{ marginLeft: 'auto', display: 'flex', gap: 2, padding: 3, background: 'var(--surface3)', borderRadius: 8 }}>
            {([['least', 'Least available'], ['most', 'Most available']] as const).map(([k, label]) => (
              <button suppressHydrationWarning key={k} onClick={() => setUptimeOrder(k)} style={{
                padding: '4px 12px', borderRadius: 6, border: 'none', fontSize: 12, cursor: 'pointer', fontWeight: 600,
                background: uptimeOrder === k ? 'var(--surface)' : 'transparent',
                color: uptimeOrder === k ? 'var(--accent2)' : 'var(--text2)',
                boxShadow: uptimeOrder === k ? '0 1px 3px rgba(15,23,42,.12)' : 'none',
              }}>{label}</button>
            ))}
          </div>
        </div>
        <div className="card-body">
          {uptimeLabels.length
            ? <UptimeDowntimeChart key={`${rangeKey}-${uptimeOrder}-${uptimeLabels.join()}`} labels={uptimeLabels} uptime={uptimeUp} downtime={uptimeDown} unit="min" notes={uptimeNotes} />
            : <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>{av ? 'No measurements in this period' : 'Loading measurements…'}</div>}
        </div>
        {uptimeRows.length > 0 && (
          <Pagination page={uptimePage} pageSize={uptimePager.pageSize} total={uptimeRows.length} label="devices"
            sizes={[10, 20, 30]} onPage={uptimePager.setPage} onPageSize={uptimePager.setPageSize} />
        )}
      </div>

      {/* ── One device: totals, availability trend, status timeline + current status ── */}
      {!customErr && (
        <DeviceAvailabilityCard devices={fDevices} defaultId={uptimeRows[0]?.d.id ?? null}
          rangeQuery={rangeQuery} rangeKey={rangeKey} agentFresh={agentFresh} />
      )}

      {/* ── SNMP Devices (hidden when there are no SNMP devices) ── */}
      {snmp && snmp.devs.length > 0 && (
        <>
          <div className="card" style={{ marginBottom: 20 }}>
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

      {/* ── Critical incidents (urgent network issues) ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          Critical Incidents
          <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}>
            {incTotal.toLocaleString()} in this period · {openIncidents.toLocaleString()} still open · from the agent&apos;s alerts
          </span>
          <div className="card-header-actions">
            <button suppressHydrationWarning className="btn btn-sm" disabled={!incTotal || exportingInc} onClick={exportIncidents}>
              {exportingInc ? 'Exporting…' : '↓ Export CSV'}
            </button>
          </div>
        </div>
        {incErr && <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--crit)' }}>Could not load incidents: {incErr}</div>}
        <div style={{ overflowX: 'auto' }} className={incLoading && incidents.length ? 'pager-busy' : undefined}>
          <table className="tbl">
            <thead><tr><th>Incident</th><th>Location</th><th>Started</th><th>Duration</th><th>Detected by</th><th>Cause</th></tr></thead>
            <tbody>
              {incidents.map(i => (
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
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: 24, color: 'var(--text3)' }}>{incLoading ? 'Loading…' : 'No critical incidents in this period.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {incTotal > 0 && (
          <Pagination page={incPager.page} pageSize={incPager.pageSize} total={incTotal} loading={incLoading} label="incidents"
            onPage={incPager.setPage} onPageSize={incPager.setPageSize} />
        )}
      </div>

      {/* ── Device Performance Summary ── */}
      <div className="card">
        <div className="card-header">
          Device Performance Summary
          <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}>Measured uptime, worst first · {measuredNote}</span>
          <div className="card-header-actions">
            <button suppressHydrationWarning className="btn btn-sm" onClick={() => exportCSV(perfRows, fileLabel, periodText)}>↓ Export CSV</button>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Device Name</th>
                <th>Category</th>
                <th>Location</th>
                <th title="From the latest monitoring check">Current Status</th>
                <th>Total Uptime</th>
                <th>Total Downtime</th>
                <th>Uptime %</th>
                <th>Downtime %</th>
                <th title="Time in the period the agent could not check this device">Not Measured</th>
                <th title="Last successful connection">Last Seen</th>
                <th>Avg Latency</th>
                <th>Alerts</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(r => (
                <tr key={`${r.name}|${r.ip}`}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{r.name}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{r.ip}</div>
                  </td>
                  <td><span className="tag">{r.type}</span></td>
                  <td style={{ color: 'var(--text2)', fontSize: 12 }}>{r.location || '—'}</td>
                  <td>{devById.get(r.id) ? <StatusChip v={deviceStatusView(devById.get(r.id)!, agentFresh)} stale={!agentFresh} /> : r.status}</td>
                  <td style={{ color: 'var(--text2)', fontSize: 12, whiteSpace: 'nowrap' }}>{r.uptimePct !== null ? fmtMinutes(r.upMin) : '—'}</td>
                  <td style={{ color: 'var(--text2)', fontSize: 12, whiteSpace: 'nowrap' }}>{r.uptimePct !== null ? fmtMinutes(r.downMin) : '—'}</td>
                  <td><UptimeBadge pct={r.uptimePct} /></td>
                  <td style={{ color: 'var(--text2)', fontSize: 12 }}>{r.downtimePct !== null ? `${r.downtimePct.toFixed(0)}%` : '—'}</td>
                  <td style={{ color: 'var(--text3)', fontSize: 12, whiteSpace: 'nowrap' }}>{av ? fmtMinutes(r.notMeasuredMin) : '—'}</td>
                  <td style={{ color: 'var(--text2)', fontSize: 12, whiteSpace: 'nowrap' }} title={r.lastSeen ? new Date(r.lastSeen).toLocaleString() : undefined}>{ago(r.lastSeen)}</td>
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
                <tr><td colSpan={12} style={{ textAlign:'center', padding:24, color:'var(--text3)' }}>No devices found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {perfRows.length > 0 && (
          <Pagination page={perfPage} pageSize={perfPager.pageSize} total={perfRows.length} label="devices"
            onPage={perfPager.setPage} onPageSize={perfPager.setPageSize} />
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
  const [total, setTotal] = useState(0)
  const pager = usePager('', 10)
  const { page, pageSize, offset, setPage } = pager

  useEffect(() => {
    setLoading(true)
    fetch(`/api/reports/generate?limit=${pageSize}&offset=${offset}`)
      .then(r => r.json())
      .then(d => {
        setSnapshots(d.snapshots ?? [])
        const n = d.total ?? (d.snapshots ?? []).length
        setTotal(n)
        const last = clampPage(page, pageSize, n)
        if (last !== page) setPage(last)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genMsg, page, pageSize, offset]) // reload when a new report is generated or the page changes

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
      {loading && !snapshots.length ? (
        <div style={{ padding: 20, color: 'var(--text3)', fontSize: 13 }}>Loading snapshots…</div>
      ) : snapshots.length === 0 ? (
        <div style={{ padding: 20, color: 'var(--text3)', fontSize: 13 }}>
          No snapshots yet. Click <strong>Generate Now</strong> to create the first one, or run <code>supabase/report_snapshots.sql</code> in Supabase if the table doesn't exist.
        </div>
      ) : (
        <>
        <div style={{ overflowX: 'auto' }} className={loading ? 'pager-busy' : undefined}>
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
        <Pagination page={page} pageSize={pageSize} total={total} loading={loading} label="snapshots"
          onPage={setPage} onPageSize={pager.setPageSize} />
        </>
      )}
    </div>
  )
}
