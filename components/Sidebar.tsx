'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

const NAV_GROUPS = [
  {
    label: 'Monitor',
    items: [
      { href: '/',          icon: '◈', label: 'Dashboard'  },
      { href: '/devices',   icon: '⬡', label: 'Devices'    },
      { href: '/alerts',    icon: '⚡', label: 'Alerts',  badge: true },
      { href: '/topology',  icon: '⬡', label: 'Topology'   },
      { href: '/floorplan', icon: '⊞', label: 'Floor Plan' },
    ],
  },
  {
    label: 'Insights',
    items: [
      { href: '/clients', icon: '◉', label: 'Clients' },
      { href: '/traffic', icon: '≋', label: 'Traffic'  },
      { href: '/sla',     icon: '◎', label: 'SLA / Uptime' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { href: '/lifecycle', icon: '⟳', label: 'Lifecycle'    },
      { href: '/config',    icon: '◫', label: 'Config Backup' },
      { href: '/reports',   icon: '◧', label: 'Reports'       },
    ],
  },
  {
    label: 'Admin',
    items: [
      { href: '/settings', icon: '◈', label: 'Settings'  },
      { href: '/auditlog', icon: '≡', label: 'Audit Log' },
    ],
  },
]

export default function Sidebar() {
  const path = usePathname()
  const [alertBadge, setAlertBadge] = useState<number>(0)
  const [clock, setClock] = useState('')

  useEffect(() => {
    // Live clock
    const tick = () => setClock(new Date().toLocaleTimeString())
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    // Active alert count (unacked, not suppressed)
    async function fetchCount() {
      const { count } = await supabase
        .from('alerts')
        .select('*', { count: 'exact', head: true })
        .eq('acked', false)
        .eq('suppressed', false)
      setAlertBadge(count ?? 0)
    }
    fetchCount()

    // Real-time subscription
    const channel = supabase
      .channel('alerts-count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, fetchCount)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  function isActive(href: string) {
    if (href === '/') return path === '/'
    return path.startsWith(href)
  }

  return (
    <aside className="sidebar">
      <div className="logo">
        <div className="logo-dot" />
        <span>Securenet</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>{clock}</span>
      </div>

      <nav>
        {NAV_GROUPS.map(group => (
          <div className="nav-section" key={group.label}>
            <div className="nav-label">{group.label}</div>
            {group.items.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-item${isActive(item.href) ? ' active' : ''}`}
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
                {item.badge && alertBadge > 0 && (
                  <span className="badge">{alertBadge}</span>
                )}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="avatar">BA</div>
        <div className="sidebar-user">
          <strong>Barbie Admin</strong>
          <span>Main Admin</span>
        </div>
      </div>
    </aside>
  )
}
