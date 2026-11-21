'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Device } from '@/lib/database.types'
import { Icon, iconForType, statusOf } from './elements'

// Device details for the Floor Plan panel's right side (tap a device marker or
// a device in the rooms list). Everything comes from the device record and the
// agent's measurements — nothing is stored on the floor plan.

type Avail = { upMin: number; downMin: number; uptimePct: number | null }
let cache: { at: number; devices: Record<string, Avail> } | null = null
let pending: Promise<Record<string, Avail> | null> | null = null

// Last 24 h uptime of every device (one request, shared for a minute)
function loadAvailability(): Promise<Record<string, Avail> | null> {
  if (cache && Date.now() - cache.at < 60_000) return Promise.resolve(cache.devices)
  pending ??= fetch('/api/reports/availability?period=24h')
    .then(r => (r.ok ? r.json() : null))
    .then(d => { if (d?.devices) cache = { at: Date.now(), devices: d.devices }; return d?.devices ?? null })
    .catch(() => null)
    .finally(() => { pending = null })
  return pending
}

const fmtMin = (m: number) => { const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60; return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m` }
const ago = (iso?: string | null) => {
  if (!iso) return '—'
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`
}

export default function DeviceDetailCard({ device, room, parent, onClose }: {
  device: Device
  room: string | null        // the room it is in on this floor
  parent?: Device            // what it is connected to (topology)
  onClose: () => void
}) {
  const [avail, setAvail] = useState<Avail | null | undefined>(cache?.devices[device.id])
  useEffect(() => {
    let live = true
    loadAvailability().then(all => { if (live) setAvail(all ? all[device.id] ?? null : null) })
    return () => { live = false }
  }, [device.id])

  const st = statusOf(device)
  const rows: [string, React.ReactNode][] = [
    ['IP address', <span key="ip" className="mono">{device.ip}</span>],
    ['MAC', device.mac ? <span key="mac" className="mono">{device.mac}</span> : '—'],
    ['Category', device.type],
    ...(device.vendor ? [['Vendor', device.vendor] as [string, React.ReactNode]] : []),
    ['Building', device.location || 'Unassigned'],
    ['Room', room ?? 'Not in a room'],
    ['Last seen', device.last_seen ? <span key="ls" title={new Date(device.last_seen).toLocaleString()}>{ago(device.last_seen)}</span> : '—'],
    ['Detected by', device.last_method ?? '—'],
    ['Connected to', parent ? `${parent.name}${device.parent_port ? ` · port ${device.parent_port}` : ''}` : '—'],
    ['Last 24 h', avail === undefined ? 'Loading…'
      : !avail || avail.uptimePct == null ? 'Not measured'
      : <span key="av">up <strong>{fmtMin(avail.upMin)}</strong> · down <strong>{fmtMin(avail.downMin)}</strong> ({avail.uptimePct}%)</span>],
  ]

  return (
    <div style={{ borderBottom: '1px solid var(--border)', borderTop: `3px solid ${st.color}`, background: 'var(--surface)' }} role="region" aria-label="Device details">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px 8px' }}>
        <span style={{ width: 34, height: 34, borderRadius: '50%', border: `2px solid ${st.color}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text)', flexShrink: 0 }}>
          <Icon k={iconForType(device.type)} size={18} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={device.name}>{device.name}</div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, color: st.color }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: st.color }} />{st.label}
          </span>
        </div>
        <button suppressHydrationWarning type="button" onClick={onClose} aria-label="Close device details"
          style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--text3)', fontSize: 16, padding: 4, lineHeight: 1 }}>✕</button>
      </div>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 12px', margin: 0, padding: '2px 14px 10px', fontSize: 12 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt style={{ color: 'var(--text3)' }}>{k}</dt>
            <dd style={{ margin: 0, color: 'var(--text)', overflowWrap: 'anywhere' }}>{v}</dd>
          </div>
        ))}
      </dl>
      <div style={{ display: 'flex', gap: 6, padding: '0 14px 12px' }}>
        <Link href="/devices" className="btn btn-sm">Devices</Link>
        <Link href="/reports" className="btn btn-sm">Uptime report</Link>
      </div>
    </div>
  )
}
