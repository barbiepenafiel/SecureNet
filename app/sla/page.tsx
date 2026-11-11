'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import type { Device, DeviceStatus, StatusEvent } from '@/lib/database.types'
import { usePolling } from '@/lib/usePolling'

// SLA targets by device type
const SLA_TARGET: Record<string, number> = {
  'Router':       99.9,
  'Firewall':     99.9,
  'Server':       99.9,
  'Switch':       99.5,
  'Access Point': 99.0,
  'Client':       95.0,
}

const PERIOD_MS = 30 * 24 * 3600 * 1000  // 30 days

interface ComputedSLA {
  id: string
  name: string
  type: string
  location: string
  currentStatus: DeviceStatus
  uptimePct: number
  downtimeMs: number
  incidents: number
  slaTarget: number
  dayMap: boolean[]  // true = had downtime that day
}

function formatDowntime(ms: number): string {
  if (ms <= 0) return '0m'
  const totalMin = Math.floor(ms / 60000)
  const hrs = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`
}

function UptimeBar({ dayMap }: { dayMap: boolean[] }) {
  return (
    <div className="uptime-bar">
      {dayMap.map((hadDown, i) => (
        <div key={i} className="uptime-seg"
          style={{ background: hadDown ? '#f85149' : '#3fb950', opacity: .75 }} />
      ))}
    </div>
  )
}

function computeSLA(devices: Device[], events: StatusEvent[]): ComputedSLA[] {
  const now    = Date.now()
  const since  = now - PERIOD_MS

  return devices.map(dev => {
    const devEvents = events
      .filter(e => e.device_id === dev.id)
      .sort((a, b) => new Date(a.changed_at).getTime() - new Date(b.changed_at).getTime())

    // --- Calculate total downtime ---
    let downtimeMs = 0
    let downStart: number | null = null

    for (const evt of devEvents) {
      const ts = new Date(evt.changed_at).getTime()
      if (evt.new_status === 'down' && downStart === null) {
        downStart = Math.max(ts, since)
      } else if (evt.new_status !== 'down' && downStart !== null) {
        downtimeMs += ts - downStart
        downStart = null
      }
    }
    // Still down now
    if (downStart !== null) downtimeMs += now - downStart
    // If device is currently down but no events recorded yet, treat as down from last check (~30s ago)
    if (dev.status === 'down' && downStart === null) downtimeMs += 30_000

    downtimeMs = Math.max(0, Math.min(downtimeMs, PERIOD_MS))

    // --- Count incidents (down transitions in period) ---
    const incidents = devEvents.filter(e => e.new_status === 'down').length

    // --- Uptime % ---
    const uptimePct = parseFloat((((PERIOD_MS - downtimeMs) / PERIOD_MS) * 100).toFixed(2))

    // --- Per-day map (last 30 days, index 0 = oldest) ---
    const dayMap = Array.from({ length: 30 }, (_, dayIdx) => {
      const dayStart = since + dayIdx * 86400_000
      const dayEnd   = dayStart + 86400_000
      // Was device down at any point during this day?
      let dStart: number | null = null
      for (const evt of devEvents) {
        const ts = new Date(evt.changed_at).getTime()
        if (evt.new_status === 'down' && dStart === null && ts < dayEnd) {
          dStart = Math.max(ts, dayStart)
        } else if (evt.new_status !== 'down' && dStart !== null) {
          if (dStart < dayEnd) return true
          dStart = null
        }
      }
      if (dStart !== null && dStart < dayEnd) return true
      if (dev.status === 'down' && dayIdx === 29) return true
      return false
    })

    return {
      id:            dev.id,
      name:          dev.name,
      type:          dev.type,
      location:      dev.location,
      currentStatus: dev.status,
      uptimePct,
      downtimeMs,
      incidents,
      slaTarget:     SLA_TARGET[dev.type] ?? 99.5,
      dayMap,
    }
  }).sort((a, b) => a.uptimePct - b.uptimePct || a.name.localeCompare(b.name))
}

export default function SlaPage() {
  const [rows,    setRows]    = useState<ComputedSLA[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUp,  setLastUp]  = useState('')

  const load = useCallback(async () => {
    const since30d = new Date(Date.now() - PERIOD_MS).toISOString()

    const [{ data: devData }, { data: evtData }] = await Promise.all([
      supabase.from('devices').select('id, name, type, location, status').neq('status', 'maint'),
      supabase.from('status_events')
        .select('device_id, new_status, old_status, changed_at')
        .gte('changed_at', since30d)
        .order('changed_at', { ascending: true }),
    ])

    const devices = (devData ?? []) as Device[]
    const events  = (evtData ?? []) as StatusEvent[]

    setRows(computeSLA(devices, events))
    setLastUp(new Date().toLocaleTimeString())
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    // Live refresh when device status changes
    const ch = supabase.channel('sla-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, load)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'status_events' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])
  // Keep data current without a manual refresh
  usePolling(load)

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)' }}>Computing SLA from status events…</div>

  const metCount   = rows.filter(r => r.uptimePct >= r.slaTarget).length
  const breaches   = rows.length - metCount
  const avgUptime  = rows.length ? (rows.reduce((s, r) => s + r.uptimePct, 0) / rows.length).toFixed(2) : '—'

  return (
    <>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Service Level Agreement (SLA) — Uptime Monitoring</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)', margin: '4px 0 0' }}>
          Tracks per-device availability over the last 30 days based on real ping monitor events.
          SLA target is the minimum agreed uptime percentage. A breach means downtime exceeded the allowed threshold.
          {lastUp && <span style={{ marginLeft: 8, color: 'var(--ok)' }}>● Live · updated {lastUp}</span>}
        </p>
      </div>

      {/* KPIs */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {[
          { label: 'Total Devices Tracked', value: rows.length,        color: 'var(--text)' },
          { label: 'Devices Meeting SLA',   value: metCount,           color: 'var(--ok)'   },
          { label: 'SLA Breaches',          value: breaches,           color: breaches > 0 ? 'var(--warn)' : 'var(--ok)' },
          { label: 'Average Uptime',        value: `${avgUptime}%`,    color: 'var(--info)' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ flex: '1 1 140px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-header">
          Device SLA Report — Last 30 Days
          <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 11, color: 'var(--text3)' }}>SLA = Service Level Agreement · computed from real ping monitor events</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Device Name</th>
                <th>Building</th>
                <th>Type</th>
                <th>Status</th>
                <th>Uptime %</th>
                <th>Total Downtime</th>
                <th>Incidents</th>
                <th>SLA Target</th>
                <th>SLA Status</th>
                <th>30-Day Availability</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>No devices found</td></tr>
              )}
              {rows.map(r => {
                const met = r.uptimePct >= r.slaTarget
                return (
                  <tr key={r.id}>
                    <td><strong>{r.name}</strong></td>
                    <td>{r.location}</td>
                    <td style={{ fontSize: 12, color: 'var(--text3)' }}>{r.type}</td>
                    <td>
                      <span className={`chip chip-${r.currentStatus === 'up' ? 'ok' : r.currentStatus === 'warn' ? 'warn' : 'crit'}`}>
                        {r.currentStatus === 'up' ? 'Online' : r.currentStatus === 'warn' ? 'Warning' : 'Offline'}
                      </span>
                    </td>
                    <td style={{ color: met ? 'var(--ok)' : 'var(--warn)', fontWeight: 600 }}>
                      {r.uptimePct.toFixed(2)}%
                    </td>
                    <td style={{ color: 'var(--text3)' }}>{formatDowntime(r.downtimeMs)}</td>
                    <td>{r.incidents}</td>
                    <td>{r.slaTarget.toFixed(1)}%</td>
                    <td>
                      {met
                        ? <span className="chip chip-ok">Met ✓</span>
                        : <span className="chip chip-warn">Below Target</span>}
                    </td>
                    <td><UptimeBar dayMap={r.dayMap} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {rows.length > 0 && rows.every(r => r.incidents === 0) && (
          <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text3)', borderTop: '1px solid var(--border)' }}>
            ℹ No downtime events recorded yet. As the ping monitor detects outages, real downtime and incident data will appear here automatically.
          </div>
        )}
      </div>
    </>
  )
}
