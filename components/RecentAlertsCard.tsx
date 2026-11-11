'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import type { Alert, ScanResult } from '@/lib/database.types'
import { alertDetails } from '@/lib/alert-details'

type ScanRow = Pick<ScanResult, 'ip' | 'mac' | 'scan_type' | 'responded' | 'latency_ms' | 'scanned_at'>
type Conn = 'connecting' | 'live' | 'reconnecting'

const MAX_ROWS     = 4                       // same size as before
const WINDOW_MS    = 24 * 60 * 60 * 1000     // alerts from the last 24 h
const POLL_MS      = 5_000                   // safety net if a realtime event is missed
const NEW_HIGHLIGHT_MS = 6_000               // briefly highlight alerts that just arrived

// "Today 6:45:12 PM" / "Yesterday 2:20:03 PM" / "Nov 9, 3:58:41 PM"
function when(iso: string) {
  const d = new Date(iso)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yday = new Date(today); yday.setDate(yday.getDate() - 1)
  if (d >= today) return `Today ${time}`
  if (d >= yday) return `Yesterday ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

// Same rule the database query uses: open and recent
function belongs(a: Alert) {
  return !a.suppressed && !a.resolved_at && Date.now() - new Date(a.created_at).getTime() < WINDOW_MS
}

// Newest first, no duplicates (a realtime event and a reload can deliver the
// same row), and only the latest alert per device — so a phone that went
// offline after coming back shows OFFLINE, not both ONLINE and OFFLINE.
function merge(list: Alert[]) {
  const byId = new Map<number, Alert>()
  for (const a of list) byId.set(a.id, a)
  const newest = [...byId.values()]
    .filter(belongs)
    .sort((x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime())
  const seenDevice = new Set<string>()
  return newest.filter(a => {
    const ip = alertDetails(a).ip
    const key = ip !== '—' ? ip : `id-${a.id}`
    if (seenDevice.has(key)) return false
    seenDevice.add(key)
    return true
  })
}

function alertType(a: Alert): { label: string; cls: string } {
  const s = alertDetails(a).status
  if (s === 'online')  return { label: 'ONLINE',  cls: 'chip-ok' }
  if (s === 'offline') return { label: 'OFFLINE', cls: 'chip-crit' }
  if (a.severity === 'warn') return { label: 'WARNING', cls: 'chip-warn' }
  if (a.severity === 'crit') return { label: 'CRITICAL', cls: 'chip-crit' }
  return { label: 'INFO', cls: 'chip-info' }
}

const SEVERITY: Record<string, string> = { crit: 'Critical', warn: 'Warning', info: 'Info' }

export default function RecentAlertsCard() {
  const [alerts,    setAlerts]    = useState<Alert[]>([])
  const [openCount, setOpenCount] = useState(0)
  const [loaded,    setLoaded]    = useState(false)
  const [conn,      setConn]      = useState<Conn>('connecting')
  const [fresh,     setFresh]     = useState<Set<number>>(new Set())
  const [scanRows,  setScanRows]  = useState<ScanRow[]>([])

  const scanBuffer = useRef<ScanRow[]>([])
  const scanTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Full reload from the database (initial load, reconnect, safety net) ──
  const loadAlerts = useCallback(async () => {
    const [{ data, error }, { count }] = await Promise.all([
      supabase.from('alerts').select('*')
        .is('resolved_at', null)
        .eq('suppressed', false)
        .gte('created_at', new Date(Date.now() - WINDOW_MS).toISOString())
        .order('created_at', { ascending: false })
        .limit(50),                        // extra rows so per-device de-duplication still fills the list
      // Open problems (offline/critical/warning alerts not yet resolved)
      supabase.from('alerts').select('id', { count: 'exact', head: true })
        .is('resolved_at', null).eq('suppressed', false).neq('severity', 'info'),
    ])
    if (error) return
    setAlerts(merge((data ?? []) as Alert[]).slice(0, MAX_ROWS))
    setOpenCount(count ?? 0)
    setLoaded(true)
  }, [])

  const loadScans = useCallback(async () => {
    const { data } = await supabase
      .from('scan_results')
      .select('ip, mac, scan_type, responded, latency_ms, scanned_at')
      .gte('scanned_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())   // last hour only
      .order('scanned_at', { ascending: false })
      .limit(50)
    if (!data?.length) { setScanRows([]); return }
    // Deduplicate by IP
    const seen = new Set<string>()
    const unique = data.filter((r: { ip: string }) => {
      if (seen.has(r.ip)) return false
      seen.add(r.ip); return true
    })
    setScanRows(unique.slice(0, 3))
  }, [])

  // ── Real-time alerts, with automatic reconnect ──
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    let stopped = false

    const onChange = (payload: { eventType: string; new: Partial<Alert>; old: Partial<Alert> }) => {
      if (payload.eventType === 'DELETE') {
        const id = payload.old.id
        setAlerts(prev => prev.filter(a => a.id !== id))
        loadAlerts()                       // refill the list and the count
        return
      }
      const row = payload.new as Alert
      if (payload.eventType === 'INSERT' && belongs(row)) {
        // Show the saved alert right away, newest first
        setAlerts(prev => merge([row, ...prev]).slice(0, MAX_ROWS))
        setFresh(prev => new Set(prev).add(row.id))
        setTimeout(() => setFresh(prev => { const n = new Set(prev); n.delete(row.id); return n }), NEW_HIGHLIGHT_MS)
        if (row.severity !== 'info') setOpenCount(c => c + 1)
      } else if (payload.eventType === 'UPDATE') {
        // e.g. an offline alert was resolved because the device came back
        setAlerts(prev => merge(prev.map(a => (a.id === row.id ? { ...a, ...row } : a))).slice(0, MAX_ROWS))
        loadAlerts()                       // keep the open count exact
      }
    }

    const connect = () => {
      if (stopped) return
      setConn(attempt === 0 ? 'connecting' : 'reconnecting')
      channel = supabase
        .channel(`recent-alerts-${Date.now()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, onChange)
        .subscribe(status => {
          if (stopped) return
          if (status === 'SUBSCRIBED') {
            attempt = 0
            setConn('live')
            loadAlerts()                   // catch up on anything missed while disconnected
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            setConn('reconnecting')
            if (channel) supabase.removeChannel(channel)
            channel = null
            const delay = Math.min(30_000, 1_000 * 2 ** attempt++)   // 1 s, 2 s, 4 s … max 30 s
            if (retry) clearTimeout(retry)
            retry = setTimeout(connect, delay)
          }
        })
    }

    loadAlerts()
    loadScans()
    connect()

    // Coming back online / to the tab → reload and make sure we're connected
    const resync = () => {
      if (document.visibilityState !== 'visible') return
      loadAlerts(); loadScans()
      if (!channel && !retry) connect()
    }
    window.addEventListener('online', resync)
    document.addEventListener('visibilitychange', resync)

    // Safety net: realtime can silently miss events (e.g. not enabled for a
    // table yet), so reload every few seconds as well. Also refreshes scans.
    const poll = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      loadAlerts(); loadScans()
    }, POLL_MS)

    // Discovered hosts: the agent rewrites scan_results in batches → debounce
    const scanCh = supabase
      .channel('ra-scans-rt')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'scan_results' },
        (payload) => {
          scanBuffer.current.push(payload.new as ScanRow)
          if (scanTimer.current) clearTimeout(scanTimer.current)
          scanTimer.current = setTimeout(() => {
            const seen = new Set<string>()
            const unique = scanBuffer.current.filter((r) => {
              if (seen.has(r.ip)) return false
              seen.add(r.ip); return true
            })
            setScanRows(unique.slice(0, 3))
            scanBuffer.current = []
            scanTimer.current  = null
          }, 2000)
        }
      )
      .subscribe()

    return () => {
      stopped = true
      clearInterval(poll)
      if (retry) clearTimeout(retry)
      if (channel) supabase.removeChannel(channel)
      supabase.removeChannel(scanCh)
      window.removeEventListener('online', resync)
      document.removeEventListener('visibilitychange', resync)
      if (scanTimer.current) clearTimeout(scanTimer.current)
    }
  }, [loadAlerts, loadScans])

  return (
    <div className="card" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="card-header" style={{ flexShrink: 0 }}>
        Recent Alerts
        {openCount > 0 && (
          <span className="chip chip-crit" style={{ fontSize: 10 }} title="Offline / critical / warning alerts not yet resolved">
            {openCount} open
          </span>
        )}
        <span
          title={conn === 'live'
            ? 'Connected — new alerts appear as soon as they are saved'
            : 'Real-time connection unavailable — reconnecting. Still checking for new alerts every 5 seconds.'}
          style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 500, color: 'var(--text3)' }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
            background: conn === 'live' ? 'var(--ok)' : 'var(--warn)',
            animation: conn === 'live' ? 'none' : 'pulse 1.2s ease-in-out infinite',
          }} />
          {conn === 'live' ? 'Live' : conn === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        </span>
        <a href="/alerts" style={{ fontSize: 11, color: 'var(--accent)', marginLeft: 'auto', textDecoration: 'none' }}>
          View all →
        </a>
      </div>

      {/* Scrolls inside the card so the card never stretches the dashboard row */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {!loaded && (
        <div style={{ padding: 20, color: 'var(--text3)', textAlign: 'center', fontSize: 13 }}>Loading alerts…</div>
      )}

      {/* ── Alert rows ── */}
      {alerts.map(a => {
        const d = alertDetails(a)
        const online = d.status === 'online'
        const type = alertType(a)
        const isFresh = fresh.has(a.id)
        return (
          <div key={`a-${a.id}`} className="alert-item"
            style={isFresh ? { background: 'rgba(22,163,74,.07)', transition: 'background .6s' } : { transition: 'background .6s' }}>
            <div className={online ? undefined : `alert-sev-${a.severity}`}
              style={online ? { width: 3, background: 'var(--ok)', borderRadius: 2, flexShrink: 0, alignSelf: 'stretch' } : undefined} />
            <div className="alert-body">
              <div className="alert-title">
                {d.name !== '—' ? d.name : d.ip}
                {isFresh && <span className="chip chip-info" style={{ fontSize: 10, marginLeft: 6 }}>New</span>}
                {!online && a.acked && <span className="chip chip-ok" style={{ fontSize: 11, marginLeft: 6 }}>acknowledged</span>}
              </div>
              <div className="alert-meta" style={{ flexWrap: 'wrap' }}>
                {d.ip !== '—' && <span className="mono">{d.ip}</span>}
                {d.mac !== '—' && <span className="mono">{d.mac}</span>}
                {d.location !== '—' && <span>{d.location}</span>}
              </div>
              {a.root_cause && (
                <div style={{ fontSize: 11.5, color: 'var(--text2)', marginTop: 2 }}>{a.root_cause}</div>
              )}
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                {SEVERITY[a.severity] ?? a.severity} · {d.method !== '—' ? `${d.method} · ` : ''}
                <span title={new Date(a.created_at).toLocaleString()}>{when(a.created_at)}</span>
              </div>
            </div>
            <span className={`chip ${type.cls}`} style={{ fontSize: 10, flexShrink: 0, alignSelf: 'center' }}>
              {type.label}
            </span>
          </div>
        )
      })}

      {/* ── Section divider ── */}
      {scanRows.length > 0 && (
        <div style={{
          margin: '4px 16px 2px', borderTop: '1px solid var(--border)', paddingTop: 6,
          fontSize: 10, color: 'var(--text3)', fontWeight: 600, letterSpacing: .5,
        }}>
          ICMP / ARP DISCOVERED
        </div>
      )}

      {/* ── Discovered host rows ── */}
      {scanRows.map((s, i) => (
        <div key={`s-${s.ip}-${i}`} className="alert-item">
          <div style={{ width: 3, background: 'var(--accent)', borderRadius: 2, flexShrink: 0, alignSelf: 'stretch' }} />
          <div className="alert-body">
            <div className="alert-title" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span className="mono" style={{ fontSize: 12 }}>{s.ip}</span>
              <span className="chip chip-info" style={{ fontSize: 10 }}>{s.scan_type.toUpperCase()}</span>
              {s.responded && <span className="chip chip-ok" style={{ fontSize: 10 }}>ICMP OK</span>}
              <span className="chip chip-info" style={{ fontSize: 10 }}>DISCOVERED</span>
            </div>
            <div className="alert-meta">
              <span>
                {s.mac ?? 'No MAC'}
                {s.latency_ms != null ? ` · ${s.latency_ms}ms` : ''}
                {' · '}{new Date(s.scanned_at).toLocaleTimeString()}
              </span>
            </div>
          </div>
        </div>
      ))}

      {loaded && alerts.length === 0 && scanRows.length === 0 && (
        <div style={{ padding: 24, color: 'var(--text3)', textAlign: 'center', fontSize: 13 }}>
          ✓ No alerts in the last 24 hours
        </div>
      )}
      </div>
    </div>
  )
}
