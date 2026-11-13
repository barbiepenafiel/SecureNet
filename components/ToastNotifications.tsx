'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'

type ToastType = 'crit' | 'warn' | 'info' | 'discovery'

interface Toast {
  id:    string
  type:  ToastType
  title: string
  meta:  string
}

const STYLE: Record<ToastType, { bg: string; label: string; icon: string }> = {
  crit:      { bg: '#c0392b',             label: 'Critical Alert',   icon: '▲' },
  warn:      { bg: '#b8860b',             label: 'Warning Alert',    icon: '▲' },
  info:      { bg: '#1a6fad',             label: 'Info',             icon: 'ℹ' },
  discovery: { bg: '#1a5fa8',             label: 'Host Discovered',  icon: '⬡' },
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const s   = STYLE[toast.type]
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  // Split meta: first part is the main detail, second (after ·) is the sub-detail
  const [main, ...rest] = toast.meta.split(' · ')
  const sub = rest.join(' · ')

  return (
    <div style={{
      width: 320, maxWidth: 'calc(100vw - 32px)',
      borderRadius: 10,
      overflow: 'hidden',
      boxShadow: '0 8px 32px rgba(0,0,0,.45)',
      animation: 'toastIn .3s cubic-bezier(.16,1,.3,1)',
    }}>
      {/* ── Header ── */}
      <div style={{
        background: s.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '9px 12px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{s.icon}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{s.label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,.8)' }}>{now}</span>
          <button suppressHydrationWarning onClick={onDismiss} style={{
            background: 'none', border: 'none', color: 'rgba(255,255,255,.85)',
            cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0, fontWeight: 400,
          }}>×</button>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{
        background: '#fff',
        padding: '12px 14px 10px',
      }}>
        <div style={{
          fontSize: 13, fontWeight: 700, color: '#111',
          lineHeight: 1.5, marginBottom: sub ? 8 : 0,
        }}>
          {toast.title}
          {main ? ` — ${main}` : ''}
        </div>

        {sub && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 12, color: '#444', borderTop: '1px solid #eee', paddingTop: 8,
          }}>
            <span style={{ fontSize: 14 }}>🖥</span>
            <span>{sub}</span>
          </div>
        )}
      </div>
    </div>
  )
}

export default function ToastNotifications() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const scanBuffer = useRef<{ ip: string; responded: boolean; scan_type: string }[]>([])
  const scanTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)

  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    setToasts(prev => [...prev.slice(-2), { ...t, id }])   // max 3 toasts visible (oldest drops off)
    setTimeout(() => {
      setToasts(prev => prev.filter(x => x.id !== id))
    }, 6000)
  }, [])

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(x => x.id !== id))
  }, [])

  useEffect(() => {
    // ── 1. Real-time alerts (INSERT only) ──────────────────────────────
    const alertCh = supabase
      .channel('toast-alerts')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'alerts' },
        (payload) => {
          const a = payload.new as { title: string; meta: string; severity: string }
          push({
            type:  (a.severity as ToastType) ?? 'info',
            title: a.title,
            meta:  a.meta,
          })
        }
      )
      .subscribe()

    // ── 2. Real-time scan results — debounce into one summary toast ────
    const scanCh = supabase
      .channel('toast-scans')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'scan_results' },
        (payload) => {
          const r = payload.new as { ip: string; responded: boolean; scan_type: string }
          scanBuffer.current.push(r)

          // Reset debounce — emit summary 2 s after last INSERT
          if (scanTimer.current) clearTimeout(scanTimer.current)
          scanTimer.current = setTimeout(() => {
            const buf      = scanBuffer.current
            const total    = buf.length
            const icmp     = buf.filter(x => x.responded).length
            const arp      = buf.filter(x => x.scan_type === 'arp' || x.scan_type === 'both').length
            scanBuffer.current = []
            scanTimer.current  = null

            if (total > 0) {
              push({
                type:  'discovery',
                title: `${total} host${total !== 1 ? 's' : ''} discovered on subnet`,
                meta:  `ICMP ${icmp} responded · ARP ${arp} resolved`,
              })
            }
          }, 2000)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(alertCh)
      supabase.removeChannel(scanCh)
      if (scanTimer.current) clearTimeout(scanTimer.current)
    }
  }, [push])

  if (toasts.length === 0) return null

  return (
    <div style={{
      position: 'fixed',
      bottom: 24,
      right: 24,
      zIndex: 3000,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      pointerEvents: 'none',
    }}>
      {toasts.map(t => (
        <div key={t.id} style={{ pointerEvents: 'all' }}>
          <ToastItem toast={t} onDismiss={() => dismiss(t.id)} />
        </div>
      ))}
    </div>
  )
}
