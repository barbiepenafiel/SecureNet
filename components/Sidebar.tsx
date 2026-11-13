'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/components/AuthProvider'
import { ROLE_LABEL, isAdminOnlyPath } from '@/lib/roles'

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
      { href: '/traffic', icon: '≋', label: 'Traffic'  },
      { href: '/sla',     icon: '◎', label: 'SLA / Uptime' },
    ],
  },
  {
    label: 'Operations',
    items: [
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
  const { profile, signOut } = useAuth()
  const isAdmin = profile?.role === 'net_admin'
  const navGroups = NAV_GROUPS
    .map(g => ({ ...g, items: g.items.filter(i => isAdmin || !isAdminOnlyPath(i.href)) }))
    .filter(g => g.items.length > 0)
  const displayName = profile?.full_name || profile?.email || '…'
  const initials = displayName.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(s => s[0]?.toUpperCase()).join('')
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
        .is('resolved_at', null)
      setAlertBadge(count ?? 0)
    }
    fetchCount()

    // Real-time subscription
    const channel = supabase
      .channel('alerts-count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, fetchCount)
      .subscribe()
    // Backup refresh every 5 s in case realtime isn't enabled for alerts
    const poll = setInterval(() => { if (document.visibilityState === 'visible') fetchCount() }, 5_000)
    return () => { supabase.removeChannel(channel); clearInterval(poll) }
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
        {navGroups.map(group => (
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
        <div className="avatar">{initials || '?'}</div>
        <div className="sidebar-user" style={{ minWidth: 0, flex: 1 }}>
          <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</strong>
          <span>{profile ? ROLE_LABEL[profile.role] : ''}</span>
        </div>
        <button onClick={signOut} title="Sign out" aria-label="Sign out" suppressHydrationWarning
          style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.5)', cursor: 'pointer', fontSize: 16, padding: 4 }}>
          ⏻
        </button>
      </div>
    </aside>
  )
}
