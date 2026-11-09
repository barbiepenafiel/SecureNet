'use client'

import { usePathname } from 'next/navigation'

const PAGE_META: Record<string, [string, string]> = {
  '/':          ['Dashboard',    'Overview'],
  '/devices':   ['Devices',      'All devices'],
  '/alerts':    ['Alerts',       'Active incidents'],
  '/topology':  ['Topology',     'Auto-discovered map'],
  '/floorplan': ['Floor Plan',   'Building A — Floor 1'],
  '/clients':   ['Clients',      'Connected endpoints'],
  '/traffic':   ['Traffic',      'Bandwidth & applications'],
  '/sla':       ['SLA / Uptime', '30-day availability'],
  '/lifecycle': ['Lifecycle',    'Warranty & firmware'],
  '/config':    ['Config Backup','Backup & diff'],
  '/reports':   ['Reports',      'Scheduled exports'],
  '/settings':  ['Settings',     'Configuration'],
  '/auditlog':  ['Audit Log',    'Activity history'],
}

interface Props {
  onMaintenance: () => void
  onAddDevice: () => void
}

export default function Topbar({ onMaintenance, onAddDevice }: Props) {
  const path = usePathname()
  const [title, sub] = PAGE_META[path] ?? ['Securenet', '']

  return (
    <div className="topbar">
      <span className="topbar-title">{title}</span>
      <span className="topbar-sep">/</span>
      <span className="topbar-sub">{sub}</span>
      <div className="topbar-actions">
        <div className="dot-pulse" />
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>Live</span>
        <button className="btn btn-sm" onClick={onMaintenance}>🔧 Maintenance</button>
        <button className="btn btn-primary btn-sm" onClick={onAddDevice}>+ Add Device</button>
      </div>
    </div>
  )
}
