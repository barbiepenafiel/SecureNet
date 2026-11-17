'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/components/AuthProvider'
import NotificationItem from '@/components/NotificationItem'
import type { AlertSeverity } from '@/lib/database.types'
import {
  listNotifications, countNotifications, unreadCount, markRead, clearOne, markAllRead,
  MIGRATION_FILE, type AppNotification,
} from '@/lib/notifications'
import Pagination, { usePager, clampPage } from '@/components/Pagination'

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
  const [count, setCount]     = useState(0)          // unread (all filters)
  const [total, setTotal]     = useState(0)          // rows matching this filter
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [error, setError]     = useState('')
  const pager = usePager(`${filter}|${showCleared}`, 25)
  const { page, pageSize, offset, setPage } = pager

  // Later pages are a snapshot (notifications raised before this time), so
  // new notifications don't push rows onto the next page and show them twice
  const anchor = useRef<string | null>(null)
  if (page === 1) anchor.current = null
  else if (!anchor.current) anchor.current = new Date().toISOString()
  const reqId = useRef(0)

  const reload = useCallback(async () => {
    const id = ++reqId.current
    setLoading(true)
    const opts = {
      before: anchor.current,
      unreadOnly: filter === 'unread',
      severity: filter === 'crit' || filter === 'warn' || filter === 'info' ? filter : null,
      includeCleared: showCleared,
    }
    const [r, n, t] = await Promise.all([
      listNotifications({ ...opts, limit: pageSize, offset }),
      unreadCount(),
      countNotifications(opts),
    ])
    if (id !== reqId.current) return
    setItems(r.items)
    setMissing(r.missingMigration)
    setError(r.error ?? '')
    setCount(n ?? 0)
    setTotal(t ?? r.items.length)
    setLoading(false)
    const last = clampPage(page, pageSize, t ?? 0)
    if (t != null && last !== page) setPage(last)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, showCleared, page, pageSize, offset])

  useEffect(() => { if (userId) reload() }, [userId, reload])

  // Live: new alerts and changes from other tabs refresh the page you're on
  useEffect(() => {
    if (!userId) return
    let t: ReturnType<typeof setTimeout> | null = null
    const soon = () => { if (t) clearTimeout(t); t = setTimeout(reload, 500) }
    const ch = supabase.channel('notif-history')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notification_reads', filter: `user_id=eq.${userId}` }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notification_cursor', filter: `user_id=eq.${userId}` }, soon)
      .subscribe()
    return () => { supabase.removeChannel(ch); if (t) clearTimeout(t) }
  }, [userId, reload])

  async function handleRead(id: number) {
    if (!userId) return
    if (items.some(n => n.alert.id === id && !n.read)) setCount(c => Math.max(0, c - 1))
    setItems(prev => filter === 'unread' ? prev.filter(n => n.alert.id !== id) : prev.map(n => n.alert.id === id ? { ...n, read: true } : n))
    const err = await markRead(userId, [id])
    if (err) { setError(err.message); reload() }
  }

  async function handleClear(id: number) {
    if (!userId) return
    if (items.some(n => n.alert.id === id && !n.read)) setCount(c => Math.max(0, c - 1))
    setItems(prev => showCleared ? prev.map(n => n.alert.id === id ? { ...n, read: true, cleared: true } : n) : prev.filter(n => n.alert.id !== id))
    const err = await clearOne(userId, id)
    if (err) { setError(err.message); reload() }
  }

  async function handleMarkAll() {
    if (!userId) return
    setCount(0)
    setItems(prev => filter === 'unread' ? [] : prev.map(n => ({ ...n, read: true })))
    const err = await markAllRead(userId)
    if (err) setError(err.message)
    reload()
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

      <div className={`notif-list page${loading && items.length ? ' pager-busy' : ''}`} role="list">
        {loading && !items.length && <div className="notif-empty">Loading…</div>}
        {!loading && items.length === 0 && (
          <div className="notif-empty">{filter === 'unread' ? 'You’re all caught up.' : 'No notifications match this filter.'}</div>
        )}
        {items.map(n => (
          <NotificationItem key={n.alert.id} n={n} canChange={!missing} onRead={handleRead} onClear={handleClear} />
        ))}
      </div>

      {total > 0 && (
        <Pagination page={page} pageSize={pageSize} total={total} loading={loading} label="notifications"
          onPage={setPage} onPageSize={pager.setPageSize} />
      )}
    </div>
  )
}
