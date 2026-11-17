'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import Modal from '@/components/Modal'
import { useAuth } from '@/components/AuthProvider'
import type { Alert } from '@/lib/database.types'
import { alertDetails } from '@/lib/alert-details'
import Pagination, { usePager, clampPage } from '@/components/Pagination'

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div className={mono ? 'mono' : undefined} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={value}>{value}</div>
    </div>
  )
}

type Tab = 'all' | 'active' | 'critical' | 'warning' | 'online' | 'resolved'

const SEV_COLOR: Record<string, string> = { crit: 'var(--crit)', warn: 'var(--warn)', info: 'var(--info)' }

// Auto-suggest fix based on alert content
function suggestFix(title: string, severity: string): string {
  const t = title.toLowerCase()
  if (t.includes('down') || t.includes('offline') || t.includes('unreachable'))
    return 'Verify physical connection (cable/port). Check if device is powered on. Ping from server to confirm reachability.'
  if (t.includes('cpu') || t.includes('high load'))
    return 'SSH into device and review running processes. Consider traffic shaping or reboot during a maintenance window.'
  if (t.includes('mem') || t.includes('memory'))
    return 'Check for memory leaks or unexpected processes. Reboot device if memory usage exceeds 95% and persists.'
  if (t.includes('latency') || t.includes('slow'))
    return 'Check for duplex mismatch, cable quality, or upstream congestion. Run traceroute to identify bottleneck.'
  if (t.includes('link') || t.includes('port'))
    return 'Inspect physical port and cable. Try alternate port on switch. Check SFP/transceiver if applicable.'
  if (t.includes('temp') || t.includes('heat'))
    return 'Check room temperature and ventilation. Clean dust from vents. Verify cooling fan operation.'
  if (severity === 'crit')
    return 'High severity — investigate immediately. Check device logs and upstream connectivity.'
  return 'Inspect device status page, review recent changes, and check for related alerts on connected devices.'
}

function ResolveModal({ alert, onClose, onResolved }: {
  alert: Alert; onClose: () => void; onResolved: () => void
}) {
  const [notes,   setNotes]   = useState('')
  const { profile } = useAuth()
  const by = profile?.full_name || profile?.email || ''
  const [saving,  setSaving]  = useState(false)
  const [err,     setErr]     = useState('')
  const suggestion = suggestFix(alert.title, alert.severity)

  async function resolve() {
    setSaving(true)
    setErr('')
    const { error } = await supabase.from('alerts').update({
      acked: true,
      resolved_at:      new Date().toISOString(),
      resolved_by:      by,
      resolution_notes: notes || suggestion,
    }).eq('id', alert.id)
    setSaving(false)
    if (error) {
      setErr(`Save failed: ${error.message}`)
      return
    }
    onResolved()
    onClose()
  }

  return (
    <Modal title="Resolve Alert" onClose={onClose}
      footer={<><button suppressHydrationWarning className="btn" onClick={onClose}>Cancel</button>
        <button suppressHydrationWarning className="btn btn-primary" onClick={resolve} disabled={saving || !by}>
          {saving ? 'Saving…' : 'Mark Resolved'}
        </button></>}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{alert.title}</div>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>{alert.meta} · {new Date(alert.created_at).toLocaleString()}</div>
      </div>

      <div style={{
        background: 'rgba(47,129,247,.08)', border: '1px solid rgba(47,129,247,.2)',
        borderRadius: 'var(--r)', padding: '8px 12px', marginBottom: 14, fontSize: 12,
      }}>
        <div style={{ fontWeight: 600, color: 'var(--info)', marginBottom: 4 }}>💡 Suggested Fix</div>
        <div style={{ color: 'var(--text2)', lineHeight: 1.6 }}>{suggestion}</div>
      </div>

      <div className="form-group">
        <label className="form-label">Resolution Notes <span style={{ color: 'var(--text3)', fontWeight: 400 }}>(what was done to fix it)</span></label>
        <textarea suppressHydrationWarning
          className="form-input"
          rows={3}
          style={{ resize: 'vertical', fontFamily: 'inherit' }}
          placeholder={suggestion}
          value={notes}
          onChange={e => setNotes(e.target.value)}
        />
      </div>
      <div className="form-group">
        <label className="form-label">Resolved By</label>
        <input suppressHydrationWarning className="form-input" value={by} readOnly disabled />
      </div>
      {err && (
        <div style={{ background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#ef4444' }}>
          {err}
        </div>
      )}
    </Modal>
  )
}

// Alert history: which alerts were raised in a period
type Period = 'today' | '7d' | '30d' | 'all'
const PERIODS: [Period, string][] = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All time']]
const PERIOD_WHEN: Record<Period, string> = { today: 'today', '7d': 'in the last 7 days', '30d': 'in the last 30 days', all: '' }
function periodStart(p: Period): number | null {
  if (p === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }
  if (p === '7d')  return Date.now() - 7 * 24 * 3600_000
  if (p === '30d') return Date.now() - 30 * 24 * 3600_000
  return null
}

const TAB_LABEL: Record<Tab, string> = {
  all:      'All Alerts',
  active:   'Open',
  critical: 'Critical',
  warning:  'Warning',
  online:   'Back Online',
  resolved: 'Resolved',
}

const TABS: Tab[] = ['all', 'active', 'critical', 'warning', 'online', 'resolved']
type Counts = Record<Tab, number>
const NO_COUNTS: Counts = { all: 0, active: 0, critical: 0, warning: 0, online: 0, resolved: 0 }

// The tab filters, applied in the database (same rules as before: "Back
// Online" = alertDetails() status 'online' — the status column, or for
// older rows "Status: Online" in meta / "back online" in the title)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withTab(q: any, t: Tab) {
  if (t === 'active')   return q.eq('acked', false).eq('suppressed', false).is('resolved_at', null)
  if (t === 'critical') return q.eq('severity', 'crit').is('resolved_at', null)
  if (t === 'warning')  return q.eq('severity', 'warn').is('resolved_at', null)
  if (t === 'online')   return q.or('status.eq.online,and(status.is.null,or(meta.ilike."*Status: Online*",title.ilike."*back online*"))')
  if (t === 'resolved') return q.not('resolved_at', 'is', null)
  return q
}

export default function AlertsPage() {
  const [alerts,    setAlerts]  = useState<Alert[]>([])
  const [tab,       setTab]     = useState<Tab>('all')
  // Opening Alerts from the sidebar always starts on "Today"
  const [period,    setPeriod]  = useState<Period>('today')
  const [resolving, setResolving] = useState<Alert | null>(null)
  const [counts,    setCounts]  = useState<Counts>(NO_COUNTS)
  const [total,     setTotal]   = useState(0)          // rows in this tab (up to the snapshot time on later pages)
  const [olderOpen, setOlderOpen] = useState(0)
  const [loading,   setLoading] = useState(true)
  const pager = usePager(`${tab}|${period}`, 25)
  const { page, pageSize, offset, setPage } = pager

  // Most recent activity first: when it was resolved, otherwise when it was
  // raised — so an alert you just resolved moves to the top. Needs the
  // last_activity column (supabase/migration_pagination.sql); until then: raised time.
  const sortCol = useRef<'last_activity' | 'created_at'>('last_activity')
  // Pages after the first are a snapshot (rows up to this time), so new
  // alerts don't push rows onto the next page and show them twice
  const anchor = useRef<string | null>(null)
  if (page === 1) anchor.current = null
  else if (!anchor.current) anchor.current = new Date().toISOString()
  const reqId = useRef(0)

  const load = useCallback(async () => {
    const id = ++reqId.current
    setLoading(true)
    const since = periodStart(period)
    const sinceIso = since === null ? null : new Date(since).toISOString()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inPeriod = (q: any) => sinceIso ? q.gte('created_at', sinceIso) : q
    const head = () => supabase.from('alerts').select('id', { count: 'exact', head: true })

    const pageQuery = (col: 'last_activity' | 'created_at') => {
      let q = withTab(inPeriod(supabase.from('alerts').select('*', { count: 'exact' })), tab)
      if (anchor.current) q = q.lte(col, anchor.current)
      return q.order(col, { ascending: false }).order('id', { ascending: false }).range(offset, offset + pageSize - 1)
    }
    const [rows, older, ...tabCounts] = await Promise.all([
      pageQuery(sortCol.current),
      // Problems still open but raised before the period — don't let them disappear silently
      sinceIso
        ? head().lt('created_at', sinceIso).is('resolved_at', null).eq('suppressed', false).neq('severity', 'info')
        : Promise.resolve({ count: 0 }),
      ...TABS.map(t => withTab(inPeriod(head()), t)),
    ])
    let res = rows
    if (res.error && sortCol.current === 'last_activity' && /last_activity/.test(res.error.message)) {
      sortCol.current = 'created_at'
      res = await pageQuery('created_at')
    }
    if (id !== reqId.current) return                // a newer request is on its way
    setAlerts((res.data ?? []) as Alert[])
    setTotal(res.count ?? 0)
    setOlderOpen(older.count ?? 0)
    setCounts(Object.fromEntries(TABS.map((t, i) => [t, tabCounts[i].count ?? 0])) as Counts)
    setLoading(false)
    // The page no longer exists (e.g. alerts were resolved out of this tab)
    const last = clampPage(page, pageSize, res.count ?? 0)
    if (last !== page) setPage(last)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, period, page, pageSize, offset])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    // Live: refresh the current page and the counts (debounced — the agent writes alerts in bursts)
    let t: ReturnType<typeof setTimeout> | null = null
    const soon = () => { if (t) clearTimeout(t); t = setTimeout(load, 800) }
    const ch = supabase.channel('alerts-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, soon)
      .subscribe()
    // Backup refresh every 5 s in case realtime isn't enabled for alerts
    const poll = setInterval(() => { if (document.visibilityState === 'visible') load() }, 5_000)
    return () => { supabase.removeChannel(ch); clearInterval(poll); if (t) clearTimeout(t) }
  }, [load])

  async function acknowledge(id: number) {
    await supabase.from('alerts').update({ acked: true }).eq('id', id)
    load()
  }

  async function reopen(id: number) {
    await supabase.from('alerts').update({
      acked: false, suppressed: false, resolved_at: null, resolved_by: null, resolution_notes: null,
    }).eq('id', id)
    load()
  }

  async function suppress(id: number) {
    await supabase.from('alerts').update({ suppressed: true }).eq('id', id)
    load()
  }

  async function unsuppress(id: number) {
    await supabase.from('alerts').update({ suppressed: false }).eq('id', id)
    load()
  }

  async function ackAll() {
    await supabase.from('alerts').update({ acked: true }).eq('acked', false).eq('suppressed', false)
    load()
  }

  async function suppressAll() {
    await supabase.from('alerts').update({ suppressed: true }).eq('suppressed', false).eq('acked', false)
    load()
  }

  const visible = alerts
  // New alerts in this tab since the snapshot of the later pages was taken
  const newer = anchor.current ? Math.max(0, counts[tab] - total) : 0

  return (
    <>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="tabs" style={{ marginBottom: 0 }}>
          {(['all','active','critical','warning','online','resolved'] as Tab[]).map(t => (
            <div key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {TAB_LABEL[t]} ({counts[t]})
            </div>
          ))}
        </div>
        {/* Period */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 2, padding: 3, background: 'var(--surface3)', borderRadius: 8 }}>
          {PERIODS.map(([k, label]) => (
            <button suppressHydrationWarning key={k} onClick={() => setPeriod(k)} style={{
              padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
              background: period === k ? 'var(--surface)' : 'transparent',
              color: period === k ? 'var(--accent2)' : 'var(--text2)',
              boxShadow: period === k ? '0 1px 3px rgba(15,23,42,.12)' : 'none',
            }}>{label}</button>
          ))}
        </div>
      </div>

      {olderOpen > 0 && period !== 'all' && (
        <div style={{
          marginBottom: 12, padding: '7px 14px', borderRadius: 'var(--r)', fontSize: 12.5,
          background: 'rgba(217,119,6,.08)', border: '1px solid rgba(217,119,6,.25)', color: 'var(--warn)',
        }}>
          {olderOpen} open alert{olderOpen === 1 ? ' was' : 's were'} raised before {PERIOD_WHEN[period]} and {olderOpen === 1 ? 'is' : 'are'} still unresolved.{' '}
          <button suppressHydrationWarning onClick={() => setPeriod('all')}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--warn)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, textDecoration: 'underline' }}>
            Show all time
          </button>
        </div>
      )}

      {newer > 0 && (
        <div style={{
          marginBottom: 12, padding: '7px 14px', borderRadius: 'var(--r)', fontSize: 12.5,
          background: 'rgba(8,145,178,.08)', border: '1px solid rgba(8,145,178,.25)', color: 'var(--info)',
        }}>
          {newer} newer alert{newer === 1 ? '' : 's'} since you left the first page.{' '}
          <button suppressHydrationWarning onClick={() => setPage(1)}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--info)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, textDecoration: 'underline' }}>
            Show latest
          </button>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className={loading && visible.length ? 'pager-busy' : undefined}>
        {visible.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>
            {loading ? 'Loading alerts…' : `No alerts in this category ${period === 'all' ? '' : PERIOD_WHEN[period]}.`}
          </div>
        )}
        {visible.map(a => {
          const d = alertDetails(a)
          return (
          <div key={a.id} className="alert-item">
            <div style={{ width: 4, background: d.status === 'online' ? 'var(--ok)' : (SEV_COLOR[a.severity] ?? 'var(--text3)'), borderRadius: 2, alignSelf: 'stretch', flexShrink: 0 }} />
            <div className="alert-body">
              <div className="alert-title">
                {d.name}
                {d.status && (
                  <span className={`chip chip-${d.status === 'online' ? 'ok' : 'crit'}`} style={{ fontSize: 11, marginLeft: 8, verticalAlign: 'middle' }}>
                    {d.status === 'online' ? 'Online' : 'Offline'}
                  </span>
                )}
                {d.discovered && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, marginLeft: 7, padding: '2px 7px',
                    borderRadius: 10, background: 'rgba(37,99,235,.12)', color: '#2563eb',
                    border: '1px solid rgba(37,99,235,.25)', verticalAlign: 'middle',
                  }}>Discovered</span>
                )}
              </div>
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: '4px 16px', marginTop: 6, fontSize: 12, color: 'var(--text2)',
              }}>
                <DetailField label="IP Address" value={d.ip} mono />
                <DetailField label="MAC Address" value={d.mac} mono />
                <DetailField label="Location" value={d.location} />
                <DetailField label="Detection" value={d.method} />
                <DetailField label="Time" value={new Date(a.created_at).toLocaleString()} />
              </div>
              {a.root_cause && (
                <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6 }}>{a.root_cause}</div>
              )}
              {/* Small one line in the other tabs; the larger box only in the Resolved tab */}
              {a.resolved_at && tab !== 'resolved' && (
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                  ✓ Resolved by <strong>{a.resolved_by}</strong> on {new Date(a.resolved_at).toLocaleString()}
                  {a.resolution_notes && <> — <em>{a.resolution_notes}</em></>}
                </div>
              )}
              {a.resolved_at && tab === 'resolved' && (
                <div style={{
                  display: 'inline-flex', alignItems: 'flex-start', gap: 8, marginTop: 8, padding: '7px 12px',
                  fontSize: 13, color: 'var(--text)', background: 'rgba(22,163,74,.08)',
                  border: '1px solid rgba(22,163,74,.28)', borderLeft: '3px solid var(--ok)', borderRadius: 6,
                }}>
                  <span style={{ color: 'var(--ok)', fontWeight: 700 }}>✓</span>
                  <span>
                    <strong style={{ color: 'var(--ok)' }}>Resolved</strong> by <strong>{a.resolved_by}</strong>
                    <span style={{ color: 'var(--text3)' }}> · {new Date(a.resolved_at).toLocaleString()}</span>
                    {a.resolution_notes && <span style={{ display: 'block', marginTop: 2, color: 'var(--text2)' }}>{a.resolution_notes}</span>}
                  </span>
                </div>
              )}
            </div>
            <div className="alert-actions">
              {/* Severity badge */}
              <span className={`chip chip-${a.severity === 'crit' ? 'crit' : a.severity === 'warn' ? 'warn' : 'info'}`}
                style={{ fontSize: 12, fontWeight: 700, padding: '4px 12px' }}>
                ● {{ crit: 'Critical', warn: 'Warning', info: 'Info' }[a.severity] ?? a.severity}
              </span>

              {/* Resolve button for active/acked alerts (an "online" event needs no action) */}
              {!a.resolved_at && d.status !== 'online' && (
                <button suppressHydrationWarning className="btn btn-sm btn-primary" onClick={() => setResolving(a)}>Resolve</button>
              )}

              {/* Reopen for resolved */}
              {a.resolved_at && (
                <>
                  <span className="chip chip-maint" style={{ fontSize: 11 }}>Resolved</span>
                  <button suppressHydrationWarning className="btn btn-sm" style={{ color: 'var(--text3)', borderColor: 'var(--border2)' }}
                    onClick={() => reopen(a.id)}>Reopen</button>
                </>
              )}
            </div>
          </div>
          )
        })}
        </div>
        {total > 0 && (
          <Pagination page={page} pageSize={pageSize} total={total} loading={loading} label="alerts"
            onPage={setPage} onPageSize={pager.setPageSize} />
        )}
      </div>

      {/* Escalation policy */}
      <div className="card">
        <div className="card-header">Escalation Policy</div>
        <div className="card-body">
          <table className="tbl">
            <thead><tr><th>Step</th><th>When</th><th>Who</th><th>Channel</th></tr></thead>
            <tbody>
              <tr><td>Detect</td><td>every 15 s</td><td colSpan={2}>ICMP ping → ARP → SNMP. A device is marked offline after 3 failed checks in a row.</td></tr>
              <tr><td>Alert</td><td>immediately</td><td>Everyone signed in</td><td>Dashboard alert + browser notification</td></tr>
              <tr><td>Email</td><td>after 45 min still offline</td><td>Email recipients (Settings)</td><td>Email — a device that comes back sooner is not emailed</td></tr>
              <tr><td>Email</td><td>within ~20 s</td><td>Email recipients (Settings)</td><td>Email — CPU / memory critical; warnings only to recipients who chose them</td></tr>
              <tr><td>Resolved</td><td>when it recovers</td><td>Email recipients (Settings)</td><td>Email incident report with the downtime</td></tr>
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text3)' }}>
            The grace period in Settings delays the alert itself; the 45-minute email wait is set on the agent (OFFLINE_EMAIL_DELAY_MIN).
            Configure thresholds in <a href="/settings" style={{ color: 'var(--info)' }}>Settings → Notifications</a>.
          </div>
        </div>
      </div>

      {resolving && (
        <ResolveModal alert={resolving} onClose={() => setResolving(null)} onResolved={load} />
      )}
    </>
  )
}
