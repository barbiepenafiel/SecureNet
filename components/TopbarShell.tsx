'use client'

import { usePathname } from 'next/navigation'
import PingMonitor from './PingMonitor'

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

function openAddDevice()   { (window as unknown as Record<string, () => void>).__openAddDevice?.()    }
function openMaintenance() { (window as unknown as Record<string, () => void>).__openMaintenance?.() }

export default function TopbarShell() {
  const path = usePathname()
  const [title, sub] = PAGE_META[path] ?? ['Securenet', '']

  return (
    <div className="topbar" suppressHydrationWarning>
      <div className="topbar-title-wrap">
        <div className="topbar-title-bar" />
        <span className="topbar-title">{title}</span>
      </div>
      <span className="topbar-sep">/</span>
      <span className="topbar-sub">{sub}</span>
      <div className="topbar-actions">
        <PingMonitor />
        <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
        <div className="dot-pulse" />
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>Live</span>
        <button className="btn btn-sm" onClick={openMaintenance} suppressHydrationWarning>🔧 Maintenance</button>
        <button className="btn btn-primary btn-sm" onClick={openAddDevice} suppressHydrationWarning>+ Add Device</button>
      </div>
    </div>
  )
}
