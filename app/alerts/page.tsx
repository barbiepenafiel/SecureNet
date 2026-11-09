'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import Modal from '@/components/Modal'
import type { Alert } from '@/lib/database.types'

type Tab = 'all' | 'active' | 'critical' | 'warning' | 'resolved'

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
  const [by,      setBy]      = useState('Barbie Admin')
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
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={resolve} disabled={saving || !by}>
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
        <textarea
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
        <input className="form-input" value={by} onChange={e => setBy(e.target.value)} placeholder="Your name" />
      </div>
      {err && (
        <div style={{ background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#ef4444' }}>
          {err}
        </div>
      )}
    </Modal>
  )
}

const TAB_LABEL: Record<Tab, string> = {
  all:      'All Alerts',
  active:   'Open',
  critical: 'Critical',
  warning:  'Warning',
  resolved: 'Resolved',
}

export default function AlertsPage() {
  const [alerts,    setAlerts]  = useState<Alert[]>([])
  const [tab,       setTab]     = useState<Tab>('all')
  const [resolving, setResolving] = useState<Alert | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from('alerts').select('*').order('created_at', { ascending: false })
    setAlerts(data ?? [])
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const ch = supabase.channel('alerts-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
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

  const isDiscovered = (a: Alert) => a.meta?.includes('[Discovered]') ?? false

  const filtered = alerts.filter(a => {
    if (tab === 'active')   return !a.acked && !a.suppressed && !a.resolved_at
    if (tab === 'critical') return a.severity === 'crit' && !a.resolved_at
    if (tab === 'warning')  return a.severity === 'warn' && !a.resolved_at
    if (tab === 'resolved') return !!a.resolved_at
    return true
  })

  // Discovered device alerts always appear first
  const visible = [...filtered].sort((a, b) => {
    const ad = isDiscovered(a) ? 0 : 1
    const bd = isDiscovered(b) ? 0 : 1
    if (ad !== bd) return ad - bd
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })

  const counts = {
    all:      alerts.length,
    active:   alerts.filter(a => !a.acked && !a.suppressed && !a.resolved_at).length,
    critical: alerts.filter(a => a.severity === 'crit' && !a.resolved_at).length,
    warning:  alerts.filter(a => a.severity === 'warn' && !a.resolved_at).length,
    resolved: alerts.filter(a => !!a.resolved_at).length,
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="tabs" style={{ marginBottom: 0 }}>
          {(['all','active','critical','warning','resolved'] as Tab[]).map(t => (
            <div key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {TAB_LABEL[t]} ({counts[t]})
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        {visible.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>No alerts in this category.</div>
        )}
        {visible.map(a => (
          <div key={a.id} className="alert-item">
            <div style={{ width: 4, background: SEV_COLOR[a.severity] ?? 'var(--text3)', borderRadius: 2, alignSelf: 'stretch', flexShrink: 0 }} />
            <div className="alert-body">
              <div className="alert-title">
                {a.title}
                {isDiscovered(a) && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, marginLeft: 7, padding: '2px 7px',
                    borderRadius: 10, background: 'rgba(37,99,235,.12)', color: '#2563eb',
                    border: '1px solid rgba(37,99,235,.25)', verticalAlign: 'middle',
                  }}>ICMP/ARP</span>
                )}
              </div>
              <div className="alert-meta">
                <span>{isDiscovered(a) ? a.meta.replace('[Discovered] ', '') : a.meta}</span>
                <span>{new Date(a.created_at).toLocaleString()}</span>
              </div>
              {a.resolved_at && (
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                  ✓ Resolved by <strong>{a.resolved_by}</strong> on {new Date(a.resolved_at).toLocaleString()}
                  {a.resolution_notes && <> — <em>{a.resolution_notes}</em></>}
                </div>
              )}
            </div>
            <div className="alert-actions">
              {/* Severity badge */}
              <span className={`chip chip-${a.severity === 'crit' ? 'crit' : a.severity === 'warn' ? 'warn' : 'info'}`}
                style={{ fontSize: 12, fontWeight: 700, padding: '4px 12px' }}>
                ● {{ crit: 'Critical', warn: 'Warning', info: 'Info' }[a.severity] ?? a.severity}
              </span>

              {/* Resolve button for active/acked alerts */}
              {!a.resolved_at && (
                <button className="btn btn-sm btn-primary" onClick={() => setResolving(a)}>Resolve</button>
              )}

              {/* Reopen for resolved */}
              {a.resolved_at && (
                <>
                  <span className="chip chip-maint" style={{ fontSize: 11 }}>Resolved</span>
                  <button className="btn btn-sm" style={{ color: 'var(--text3)', borderColor: 'var(--border2)' }}
                    onClick={() => reopen(a.id)}>Reopen</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Escalation policy */}
      <div className="card">
        <div className="card-header">Escalation Policy</div>
        <div className="card-body">
          <table className="tbl">
            <thead><tr><th>Level</th><th>Wait</th><th>Notify</th><th>Channel</th></tr></thead>
            <tbody>
              <tr><td>L1</td><td>0 min</td><td>On-call tech</td><td>Email + Telegram</td></tr>
              <tr><td>L2</td><td>15 min (no ack)</td><td>Network Admin</td><td>SMS + Slack</td></tr>
              <tr><td>L3</td><td>30 min (no ack)</td><td>IT Manager</td><td>Phone call</td></tr>
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text3)' }}>
            Note: Escalation is triggered only after grace period expires, avoiding notifications for temporary flaps.
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
