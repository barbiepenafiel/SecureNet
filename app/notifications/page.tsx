'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/components/AuthProvider'
import NotificationItem from '@/components/NotificationItem'
import type { AlertSeverity } from '@/lib/database.types'
import {
  listNotifications, unreadCount, markRead, clearOne, markAllRead,
  MIGRATION_FILE, type AppNotification,
} from '@/lib/notifications'

const PAGE = 30

type Filter = 'all' | 'unread' | AlertSeverity
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all',    label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'crit',   label: 'Critical' },
  { key: 'warn',   label: 'Warning' },
  { key: 'info',   label: 'Information' },
]

// Full notification history for the signed-in user (newest first)
export default function NotificationsPage() {
  const { profile } = useAuth()
  const userId = profile?.id ?? null

  const [filter, setFilter]   = useState<Filter>('all')
  const [showCleared, setShowCleared] = useState(false)
  const [items, setItems]     = useState<AppNotification[]>([])
  const [count, setCount]     = useState(0)
  const [loading, setLoading] = useState(true)
  const [more, setMore]       = useState(false)
  const [missing, setMissing] = useState(false)
  const [error, setError]     = useState('')
  const optsRef = useRef({ filter, showCleared })
  optsRef.current = { filter, showCleared }

  const query = useCallback((before: string | null, limit = PAGE) => {
    const { filter: f, showCleared: c } = optsRef.current
    return listNotifications({
      limit, before,
      unreadOnly: f === 'unread',
      severity: f === 'crit' || f === 'warn' || f === 'info' ? f : null,
      includeCleared: c,
    })
  }, [])

  // Reload the first page (or as many rows as are on screen, so live updates don't collapse "Load more")
  const reload = useCallback(async (keep = 0) => {
    const [r, n] = await Promise.all([query(null, Math.max(PAGE, Math.min(keep, 200))), unreadCount()])
    setItems(r.items)
    setMore(r.items.length >= Math.max(PAGE, Math.min(keep, 200)))
    setMissing(r.missingMigration)
    setError(r.error ?? '')
    setCount(n ?? 0)
    setLoading(false)
  }, [query])

  const shown = useRef(0)
  shown.current = items.length

  useEffect(() => { if (userId) { setLoading(true); reload() } }, [userId, filter, showCleared, reload])

  // Live: new alerts and changes from other tabs
  useEffect(() => {
    if (!userId) return
    let t: ReturnType<typeof setTimeout> | null = null
    const soon = () => { if (t) clearTimeout(t); t = setTimeout(() => reload(shown.current), 500) }
    const ch = supabase.channel('notif-history')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notification_reads', filter: `user_id=eq.${userId}` }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notification_cursor', filter: `user_id=eq.${userId}` }, soon)
      .subscribe()
    return () => { supabase.removeChannel(ch); if (t) clearTimeout(t) }
  }, [userId, reload])

  async function loadMore() {
    const last = items[items.length - 1]
    if (!last) return
    const r = await query(last.alert.created_at)
    const seen = new Set(items.map(n => n.alert.id))
    setItems(prev => [...prev, ...r.items.filter(n => !seen.has(n.alert.id))])
    setMore(r.items.length >= PAGE)
  }

  async function handleRead(id: number) {
    if (!userId) return
    if (items.some(n => n.alert.id === id && !n.read)) setCount(c => Math.max(0, c - 1))
    setItems(prev => filter === 'unread' ? prev.filter(n => n.alert.id !== id) : prev.map(n => n.alert.id === id ? { ...n, read: true } : n))
    const err = await markRead(userId, [id])
    if (err) { setError(err.message); reload(shown.current) }
  }

  async function handleClear(id: number) {
    if (!userId) return
    if (items.some(n => n.alert.id === id && !n.read)) setCount(c => Math.max(0, c - 1))
    setItems(prev => showCleared ? prev.map(n => n.alert.id === id ? { ...n, read: true, cleared: true } : n) : prev.filter(n => n.alert.id !== id))
    const err = await clearOne(userId, id)
    if (err) { setError(err.message); reload(shown.current) }
  }

  async function handleMarkAll() {
    if (!userId) return
    setCount(0)
    setItems(prev => filter === 'unread' ? [] : prev.map(n => ({ ...n, read: true })))
    const err = await markAllRead(userId)
    if (err) setError(err.message)
    reload(shown.current)
  }

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div>Notification history</div>
          <div style={{ fontSize: 12, fontWeight: 400, color: 'var(--text3)', marginTop: 2 }}>
            Network events from the monitoring agent · {count} unread
          </div>
        </div>
        <div className="card-header-actions" style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showCleared} onChange={e => setShowCleared(e.target.checked)} disabled={missing} />
            Show cleared
          </label>
          {!missing && (
            <button type="button" className="btn btn-sm" onClick={handleMarkAll} disabled={count === 0}>Mark all as read</button>
          )}
        </div>
      </div>

      <div className="tabs notif-page-tabs" role="tablist">
        {FILTERS.map(f => (
          <button key={f.key} type="button" role="tab" aria-selected={filter === f.key}
            className={`tab${filter === f.key ? ' active' : ''}`} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      {missing && (
        <div className="notif-note" style={{ margin: 16 }}>
          Read and cleared status can&apos;t be saved until <span className="mono">{MIGRATION_FILE}</span> is run in the Supabase SQL Editor.
        </div>
      )}
      {error && !missing && <div className="notif-note err" style={{ margin: 16 }}>{error}</div>}

      <div className="notif-list page" role="list">
        {loading && <div className="notif-empty">Loading…</div>}
        {!loading && items.length === 0 && (
          <div className="notif-empty">{filter === 'unread' ? 'You’re all caught up.' : 'No notifications match this filter.'}</div>
        )}
        {!loading && items.map(n => (
          <NotificationItem key={n.alert.id} n={n} canChange={!missing} onRead={handleRead} onClear={handleClear} />
        ))}
      </div>

      {!loading && more && (
        <div style={{ padding: 16, textAlign: 'center', borderTop: '1px solid var(--border)' }}>
          <button type="button" className="btn btn-sm" onClick={loadMore}>Load more</button>
        </div>
      )}
    </div>
  )
}
