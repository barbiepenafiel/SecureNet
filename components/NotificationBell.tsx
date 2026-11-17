'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/components/AuthProvider'
import NotificationItem from '@/components/NotificationItem'
import {
  listNotifications, unreadCount, markRead, clearOne, markAllRead,
  MIGRATION_FILE, type AppNotification,
} from '@/lib/notifications'

const DROPDOWN_LIMIT = 15
const POLL_MS = 30_000          // backup in case Realtime isn't enabled

// Bell in the top bar: red badge with the unread count, dropdown with the
// latest notifications. Notifications are the monitoring agent's alerts
// (table `alerts`); read / cleared state is saved per user.
export default function NotificationBell() {
  const { profile } = useAuth()
  const userId = profile?.id ?? null

  const [open, setOpen]       = useState(false)
  const [tab, setTab]         = useState<'all' | 'unread'>('all')
  const [items, setItems]     = useState<AppNotification[]>([])
  const [count, setCount]     = useState(0)
  const [loaded, setLoaded]   = useState(false)
  const [missing, setMissing] = useState(false)
  const [error, setError]     = useState('')
  const [ring, setRing]       = useState(false)

  const wrapRef  = useRef<HTMLDivElement>(null)
  const tabRef   = useRef(tab)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  tabRef.current = tab

  const load = useCallback(async () => {
    const [list, n] = await Promise.all([
      listNotifications({ limit: DROPDOWN_LIMIT, unreadOnly: tabRef.current === 'unread' }),
      unreadCount(),
    ])
    setItems(list.items)
    setMissing(list.missingMigration)
    setError(list.error ?? '')
    setCount(n ?? 0)
    setLoaded(true)
  }, [])

  const reloadSoon = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => { debounce.current = null; load() }, 400)
  }, [load])

  // Initial load, live updates, backup polling
  useEffect(() => {
    if (!userId) return
    load()
    const alertsCh = supabase
      .channel('notif-bell-alerts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, payload => {
        if (payload.eventType === 'INSERT' && !(payload.new as { suppressed?: boolean }).suppressed) {
          setRing(true)
          setTimeout(() => setRing(false), 1200)
        }
        reloadSoon()
      })
      .subscribe()
    // Read / cleared in another tab or on another device
    const stateCh = supabase
      .channel(`notif-bell-state-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notification_reads', filter: `user_id=eq.${userId}` }, reloadSoon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notification_cursor', filter: `user_id=eq.${userId}` }, reloadSoon)
      .subscribe()
    const poll = setInterval(() => { if (document.visibilityState === 'visible') load() }, POLL_MS)
    return () => {
      supabase.removeChannel(alertsCh)
      supabase.removeChannel(stateCh)
      clearInterval(poll)
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [userId, load, reloadSoon])

  // Switching All / Unread, and opening, refresh the list
  useEffect(() => { if (open && userId) load() }, [open, tab, userId, load])

  // Close on outside click / tap and on Escape
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function handleRead(id: number) {
    if (!userId) return
    const wasUnread = items.some(n => n.alert.id === id && !n.read)
    setItems(prev => tab === 'unread'
      ? prev.filter(n => n.alert.id !== id)
      : prev.map(n => n.alert.id === id ? { ...n, read: true } : n))
    if (wasUnread) setCount(c => Math.max(0, c - 1))
    const err = await markRead(userId, [id])
    if (err) { setError(err.message); load() }
  }

  async function handleClear(id: number) {
    if (!userId) return
    const wasUnread = items.some(n => n.alert.id === id && !n.read)
    setItems(prev => prev.filter(n => n.alert.id !== id))
    if (wasUnread) setCount(c => Math.max(0, c - 1))
    const err = await clearOne(userId, id)
    if (err) { setError(err.message); load() } else reloadSoon()   // fill the freed slot
  }

  async function handleMarkAll() {
    if (!userId) return
    setItems(prev => tab === 'unread' ? [] : prev.map(n => ({ ...n, read: true })))
    setCount(0)
    const err = await markAllRead(userId)
    if (err) setError(err.message)
    load()
  }

  if (!userId) return null

  const badge = count > 99 ? '99+' : String(count)

  return (
    <div className="notif-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`notif-bell${ring ? ' ring' : ''}${open ? ' active' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}
        aria-haspopup="true"
        aria-expanded={open}
        title="Notifications"
        suppressHydrationWarning
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {count > 0 && <span className="notif-badge">{badge}</span>}
      </button>

      <div className={`notif-panel${open ? ' open' : ''}`} role="dialog" aria-label="Notifications" aria-hidden={!open}>
        <div className="notif-head">
          <div className="notif-head-title">
            Notifications
            {count > 0 && <span className="notif-head-count">{badge} unread</span>}
          </div>
          {!missing && count > 0 && (
            <button type="button" className="notif-link" onClick={handleMarkAll}>Mark all as read</button>
          )}
        </div>

        <div className="notif-tabs" role="tablist">
          {(['all', 'unread'] as const).map(t => (
            <button key={t} type="button" role="tab" aria-selected={tab === t}
              className={`notif-tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {t === 'all' ? 'All' : 'Unread'}
            </button>
          ))}
        </div>

        {missing && (
          <div className="notif-note">
            Read status isn&apos;t saved yet. Run <span className="mono">{MIGRATION_FILE}</span> in Supabase.
          </div>
        )}
        {error && !missing && <div className="notif-note err">{error}</div>}

        <div className="notif-list" role="list">
          {!loaded && <div className="notif-empty">Loading…</div>}
          {loaded && items.length === 0 && (
            <div className="notif-empty">
              {tab === 'unread' ? 'You’re all caught up.' : 'No notifications yet.'}
            </div>
          )}
          {items.map(n => (
            <NotificationItem key={n.alert.id} n={n} compact canChange={!missing}
              onRead={handleRead} onClear={handleClear} />
          ))}
        </div>

        <div className="notif-foot">
          <Link href="/notifications" className="notif-link" onClick={() => setOpen(false)}>
            View all notifications
          </Link>
        </div>
      </div>
    </div>
  )
}
