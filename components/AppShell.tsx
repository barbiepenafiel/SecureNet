'use client'

import { usePathname } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import TopbarShell from '@/components/TopbarShell'
import ShellModals from '@/components/ShellModals'
import AIInsightsButton from '@/components/AIInsightsButton'
import ToastNotifications from '@/components/ToastNotifications'
import PingMonitor from '@/components/PingMonitor'

// The login page renders on its own; every other page gets the full app frame.
export default function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname()
  if (path === '/login') return <>{children}</>

  return (
    <>
      <div className="app">
        <Sidebar />
        <div className="main">
          <TopbarShell />
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
