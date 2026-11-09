import type { Metadata } from 'next'
import './globals.css'
import Sidebar from '@/components/Sidebar'
import TopbarShell from '@/components/TopbarShell'
import ShellModals from '@/components/ShellModals'
import AIInsightsButton from '@/components/AIInsightsButton'
import ToastNotifications from '@/components/ToastNotifications'
import PingMonitor from '@/components/PingMonitor'

export const metadata: Metadata = {
  title: 'Securenet — Network Monitoring',
  description: 'Network monitoring system for DNSC',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
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
      </body>
    </html>
  )
}
