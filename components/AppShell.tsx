'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import TopbarShell from '@/components/TopbarShell'
import ShellModals from '@/components/ShellModals'
import AIInsightsButton from '@/components/AIInsightsButton'
import ToastNotifications from '@/components/ToastNotifications'
import PingMonitor from '@/components/PingMonitor'

// The login page renders on its own; every other page gets the full app frame.
// Navigation: full sidebar on desktop, an icon rail on tablets and a slide-in
// drawer on phones (opened from the ☰ button in the top bar).
export default function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname()
  const [navOpen, setNavOpen] = useState(false)

  // Close the menu after navigating, and with Escape
  useEffect(() => { setNavOpen(false) }, [path])
  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])

  if (path === '/login') return <>{children}</>

  return (
    <>
      <div className={`app${navOpen ? ' nav-open' : ''}`}>
        <Sidebar onClose={() => setNavOpen(false)} />
        <div className="nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />
        <div className="main">
          <TopbarShell onMenu={() => setNavOpen(o => !o)} menuOpen={navOpen} />
          <div className="content">{children}</div>
        </div>
      </div>
      <PingMonitor />
      <ShellModals />
      <AIInsightsButton />
      <ToastNotifications />
    </>
  )
}
