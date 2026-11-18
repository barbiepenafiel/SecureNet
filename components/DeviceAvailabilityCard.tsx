'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Device } from '@/lib/database.types'
import { usePolling } from '@/lib/usePolling'
import { AvailabilityTrendChart, fmtDurationMin } from '@/components/ReportCharts'

// ── Current status (shared with the Reports table) ───────────────────────────
// From the agent's latest check (ICMP ping → ARP → SNMP), stored on the device.
// While the agent isn't reporting, it is the last status it measured.
export interface StatusView { label: string; chip: string; hint: string }
export function deviceStatusView(d: Pick<Device, 'status'>, agentFresh: boolean): StatusView {
  const base: Record<string, Omit<StatusView, 'hint'> & { hint: string }> = {
    up:          { label: 'Online',      chip: 'chip-ok',    hint: 'Answering the monitoring checks' },
    warn:        { label: 'Warning',     chip: 'chip-warn',  hint: 'Online, but its ping time is above the warning limit' },
    unreachable: { label: 'Warning',     chip: 'chip-warn',  hint: 'Missed the last check(s) — not yet confirmed offline' },
    down:        { label: 'Offline',     chip: 'chip-crit',  hint: 'No answer to ping, ARP (or SNMP) for 3 checks in a row' },
    unknown:     { label: 'Not checked', chip: 'chip-off',   hint: 'The agent is not on this device’s network' },
    maint:       { label: 'Maintenance', chip: 'chip-maint', hint: 'In a maintenance window — not checked' },
  }
  const v = base[d.status] ?? { label: d.status, chip: 'chip-off', hint: '' }
  return agentFresh ? v : { ...v, hint: `Last known status — the monitoring agent is not reporting right now. ${v.hint}` }
}

export function StatusChip({ v, stale }: { v: StatusView; stale: boolean }) {
  return (
    <span title={v.hint} style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
      <span className={`chip ${v.chip}`} style={stale ? { opacity: .7 } : undefined}>{v.label}</span>
      {stale && <span style={{ fontSize: 10, color: 'var(--text3)' }}>last known</span>}
    </span>
  )
}

export function ago(iso: string | null | undefined) {
  if (!iso) return '—'
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`
}

interface TimelineStep { bucket: string; upMin: number; downMin: number; unknownMin: number }
interface TimelineResponse { from: string; to: string; bucketMin: number; measuredSince: string; historyDays: number; timeline: TimelineStep[] }

const fmtWhen = (ms: number, withDate: boolean) => new Date(ms).toLocaleString([], withDate
  ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  : { hour: 'numeric', minute: '2-digit' })

// One device: total uptime / downtime / not measured, availability trend and
// a status timeline for the selected period, next to its current status.
export default function DeviceAvailabilityCard({ devices, defaultId, rangeQuery, rangeKey, agentFresh }: {
  devices: Device[]              // the devices the page filters allow
  defaultId: string | null       // shown first (e.g. the least available)
  rangeQuery: string             // "period=24h" or "from=…&to=…"
  rangeKey: string
  agentFresh: boolean
}) {
  const sorted = useMemo(() => [...devices].sort((a, b) => a.name.localeCompare(b.name)), [devices])
  const [picked, setPicked] = useState<string | null>(null)
  const id = picked && sorted.some(d => d.id === picked) ? picked : (defaultId ?? sorted[0]?.id ?? null)
  const dev = sorted.find(d => d.id === id) ?? null

  const [data, setData] = useState<(TimelineResponse & { key: string }) | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const key = `${rangeKey}|${id}`
  const load = useCallback(async () => {
    if (!id) return
    try {
      const r = await fetch(`/api/reports/availability?view=timeline&device=${id}&${rangeQuery}`)
      const d = await r.json()
      if (r.ok) { setData({ ...d, key }); setErr(null) } else setErr(d.error ?? 'Could not load the timeline')
    } catch { /* keep the last data */ }
  }, [id, rangeQuery, key])
  useEffect(() => { load() }, [load])
  usePolling(load, 60_000)
  const tl = data && data.key === key ? data : null

  const stats = useMemo(() => {
    if (!tl) return null
    const totalMin = Math.round((Date.parse(tl.to) - Date.parse(tl.from)) / 60_000)
    const up = tl.timeline.reduce((s, b) => s + b.upMin, 0)
    const down = tl.timeline.reduce((s, b) => s + b.downMin, 0)
    const judged = up + down
    return {
      totalMin, up, down,
      notMeasured: Math.max(0, totalMin - judged),
      upPct: judged ? Math.round((up / judged) * 1000) / 10 : null,
      downPct: judged ? Math.round((down / judged) * 1000) / 10 : null,
    }
  }, [tl])

  const trend = useMemo(() => {
    if (!tl) return null
    const multiDay = Date.parse(tl.to) - Date.parse(tl.from) > 26 * 3_600_000
    return {
      labels: tl.timeline.map(b => fmtWhen(Date.parse(b.bucket), multiDay)),
      pct: tl.timeline.map(b => (b.upMin + b.downMin ? Math.round((b.upMin / (b.upMin + b.downMin)) * 1000) / 10 : null)),
      details: tl.timeline.map(b => (b.upMin + b.downMin
        ? `Online ${fmtDurationMin(b.upMin)} · Offline ${fmtDurationMin(b.downMin)}`
        : 'No measurement in this step')),
      multiDay,
    }
  }, [tl])

  if (!sorted.length) return null
  const sv = dev ? deviceStatusView(dev, agentFresh) : null
  const bar = (min: number) => (stats && stats.totalMin ? `${(min / stats.totalMin) * 100}%` : '0%')

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-header" style={{ flexWrap: 'wrap' }}>
        Device Availability
        <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}>History in the selected period · current status from the latest check</span>
        <div className="card-header-actions" style={{ marginLeft: 'auto' }}>
          <select suppressHydrationWarning className="form-select" style={{ width: 'auto', maxWidth: 280 }} value={id ?? ''}
            onChange={e => setPicked(e.target.value)} aria-label="Device">
            {sorted.map(d => <option key={d.id} value={d.id}>{d.name}{d.name.includes(d.ip) ? '' : ` (${d.ip})`}</option>)}
          </select>
        </div>
      </div>

      {dev && (
        <div className="card-body">
          {/* Device + current status */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 18px', marginBottom: 14 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{dev.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                <span className="mono">{dev.ip}</span> · {dev.type} · {dev.location || 'Unassigned'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Now</span>
              {sv && <StatusChip v={sv} stale={!agentFresh} />}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text2)' }} title={dev.last_seen ? new Date(dev.last_seen).toLocaleString() : undefined}>
              Last successful connection: <strong>{dev.last_seen ? `${new Date(dev.last_seen).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${ago(dev.last_seen)})` : 'never'}</strong>
            </div>
            {tl && (
              <div style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 'auto' }}>
                {new Date(tl.from).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} – {new Date(tl.to).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </div>
            )}
          </div>

          {err && <div style={{ fontSize: 12, color: 'var(--crit)', marginBottom: 10 }}>{err}</div>}
          {!stats && !err && <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>Loading measurements…</div>}

          {stats && trend && tl && (
            <>
              {/* Totals */}
              <div className="avail-tiles">
                <div className="avail-tile" style={{ borderTopColor: 'var(--ok)' }}>
                  <div className="kpi-label">Total uptime</div>
                  <div className="avail-tile-value">{fmtDurationMin(stats.up)}</div>
                  <div className="kpi-sub">{stats.upPct == null ? 'not measured' : `${stats.upPct}% of measured time`}</div>
                </div>
                <div className="avail-tile" style={{ borderTopColor: 'var(--warn)' }}>
                  <div className="kpi-label">Total downtime</div>
                  <div className="avail-tile-value">{fmtDurationMin(stats.down)}</div>
                  <div className="kpi-sub">{stats.downPct == null ? 'not measured' : `${stats.downPct}% of measured time`}</div>
                </div>
                <div className="avail-tile" style={{ borderTopColor: 'var(--border2)' }}>
                  <div className="kpi-label">Not measured</div>
                  <div className="avail-tile-value">{fmtDurationMin(stats.notMeasured)}</div>
                  <div className="kpi-sub">agent off, or not on this device’s network</div>
                </div>
                <div className="avail-tile" style={{ borderTopColor: 'var(--info)' }}>
                  <div className="kpi-label">Period</div>
                  <div className="avail-tile-value">{fmtDurationMin(stats.totalMin)}</div>
                  <div className="kpi-sub">{fmtDurationMin(stats.up + stats.down)} measured</div>
                </div>
              </div>

              {/* Uptime vs downtime vs not measured, as a share of the period */}
              <div className="avail-bar" role="img"
                aria-label={`Uptime ${fmtDurationMin(stats.up)}, downtime ${fmtDurationMin(stats.down)}, not measured ${fmtDurationMin(stats.notMeasured)}`}>
                <span style={{ width: bar(stats.up), background: 'var(--ok)' }} title={`Uptime ${fmtDurationMin(stats.up)}`} />
                <span style={{ width: bar(stats.down), background: 'var(--warn)' }} title={`Downtime ${fmtDurationMin(stats.down)}`} />
                <span style={{ width: bar(stats.notMeasured) }} className="avail-none" title={`Not measured ${fmtDurationMin(stats.notMeasured)}`} />
              </div>
              <div className="avail-legend">
                <span><i style={{ background: 'var(--ok)' }} />Uptime {fmtDurationMin(stats.up)}</span>
                <span><i style={{ background: 'var(--warn)' }} />Downtime {fmtDurationMin(stats.down)}</span>
                <span><i className="avail-none" />Not measured {fmtDurationMin(stats.notMeasured)}</span>
              </div>

              {/* Availability trend */}
              <div className="avail-sub">Availability trend <span>share of measured time Online, every {fmtDurationMin(tl.bucketMin)}</span></div>
              <AvailabilityTrendChart key={key} labels={trend.labels} uptimePct={trend.pct} details={trend.details} />

              {/* Status timeline, ending with the current status */}
              <div className="avail-sub">Status timeline <span>each block is {fmtDurationMin(tl.bucketMin)}</span></div>
              <div className="avail-timeline">
                <div className="avail-strip">
                  {tl.timeline.map(b => {
                    const judged = b.upMin + b.downMin
                    const cls = !judged ? 'none' : !b.downMin ? 'up' : !b.upMin ? 'down' : 'mixed'
                    const t = Date.parse(b.bucket)
                    const when = `${fmtWhen(t, trend.multiDay)} – ${fmtWhen(t + tl.bucketMin * 60_000, false)}`
                    const what = !judged ? 'Not measured' : `Online ${fmtDurationMin(b.upMin)} · Offline ${fmtDurationMin(b.downMin)}`
                    return <span key={b.bucket} className={`avail-step ${cls}`} title={`${when}: ${what}`} />
                  })}
                </div>
                {sv && (
                  <div className="avail-now" title={sv.hint}>
                    <span className={`chip ${sv.chip}`}>{sv.label}</span>
                    <span>{agentFresh ? 'now' : 'last known'}</span>
                  </div>
                )}
              </div>
              <div className="avail-axis">
                <span>{fmtWhen(Date.parse(tl.from), trend.multiDay)}</span>
                <span>{fmtWhen(Date.parse(tl.to), trend.multiDay)}</span>
              </div>
              <div className="avail-legend">
                <span><i style={{ background: 'var(--ok)' }} />Online</span>
                <span><i className="avail-mixed" />Partly offline</span>
                <span><i style={{ background: 'var(--warn)' }} />Offline</span>
                <span><i className="avail-none" />Not measured</span>
              </div>
              {Date.parse(tl.measuredSince) > Date.parse(tl.from) && (
                <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text3)' }}>
                  Minute-by-minute measurements are kept {tl.historyDays} days, so time before {new Date(tl.measuredSince).toLocaleDateString()} shows as not measured.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
