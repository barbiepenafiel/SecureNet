'use client'

import { usePathname } from 'next/navigation'
import PingMonitor from './PingMonitor'
import { useAuth } from './AuthProvider'

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

export default function TopbarShell({ onMenu, menuOpen = false }: { onMenu?: () => void; menuOpen?: boolean }) {
  const path = usePathname()
  const [title, sub] = PAGE_META[path] ?? ['Securenet', '']
  const { can } = useAuth()

  return (
    <div className="topbar" suppressHydrationWarning>
      {/* Menu button — shown on tablets and phones only */}
      <button type="button" className="nav-toggle" onClick={onMenu} aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={menuOpen} suppressHydrationWarning>☰</button>
      <div className="topbar-title-wrap">
        <div className="topbar-title-bar" />
        <span className="topbar-title">{title}</span>
      </div>
      <span className="topbar-sep">/</span>
      <span className="topbar-sub">{sub}</span>
      <div className="topbar-actions">
        <PingMonitor />
        <div className="topbar-divider" style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
        <div className="dot-pulse" />
        <span className="topbar-live" style={{ fontSize: 12, color: 'var(--text3)' }}>Live</span>
        {can('maintenance.manage') && <button className="btn btn-sm" onClick={openMaintenance} title="Maintenance" suppressHydrationWarning>🔧<span className="btn-text"> Maintenance</span></button>}
        {can('devices.manage') && <button className="btn btn-primary btn-sm" onClick={openAddDevice} title="Add Device" suppressHydrationWarning>+<span className="btn-text"> Add Device</span></button>}
      </div>
    </div>
  )
}
