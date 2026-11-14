'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import Modal from '@/components/Modal'
import type { AlertConfig } from '@/lib/database.types'
import { useAuth } from '@/components/AuthProvider'
import ManageSection from '@/components/ManageSection'
import { ROLE_LABEL, type Profile, type Role } from '@/lib/roles'

type SettingsTab = 'notif' | 'roles' | 'manage' | 'maint'
const SETTINGS_TABS: SettingsTab[] = ['notif', 'roles', 'manage', 'maint']

import type { SmtpStatus, NotificationRecipient } from '@/lib/database.types'

// Who gets alert emails and the daily report (notification_recipients)
function RecipientsPanel() {
  const [list, setList] = useState<NotificationRecipient[] | null>(null)
  const [missing, setMissing] = useState(false)
  const [form, setForm] = useState({ email: '', name: '', min_severity: 'crit' as 'crit' | 'warn', daily_report: true })
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    const { data, error } = await supabase.from('notification_recipients').select('*').order('created_at')
    if (error) { setMissing(/schema cache|does not exist|relation/i.test(error.message)); setList([]); return }
    setMissing(false)
    setList((data ?? []) as NotificationRecipient[])
  }
  useEffect(() => { load() }, [])

  async function add() {
    setErr(null)
    const email = form.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setErr('Enter a valid email address'); return }
    const { error } = await supabase.from('notification_recipients')
      .insert({ email, name: form.name.trim() || null, min_severity: form.min_severity, daily_report: form.daily_report })
    if (error) { setErr(/duplicate|unique/i.test(error.message) ? 'That address is already on the list' : error.message); return }
    setForm({ email: '', name: '', min_severity: 'crit', daily_report: true })
    load()
  }
  async function patch(id: string, p: Partial<NotificationRecipient>) {
    await supabase.from('notification_recipients').update(p).eq('id', id)
    load()
  }
  async function remove(id: string) {
    await supabase.from('notification_recipients').delete().eq('id', id)
    load()
  }

  if (missing) return (
    <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 14 }}>
      Run <code>supabase/migration_objectives.sql</code> in Supabase to manage recipients here. Until then the agent emails the addresses in its <code>SMTP_TO</code> setting.
    </div>
  )
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Recipients</div>
      {list && !list.length && <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>No recipients yet — the agent falls back to its <code>SMTP_TO</code> setting.</div>}
      {list?.map(r => (
        <div key={r.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 12 }}>
          <span style={{ flex: '1 1 180px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', opacity: r.enabled ? 1 : .5 }}>
            <strong>{r.email}</strong>{r.name ? ` · ${r.name}` : ''}
          </span>
          <select suppressHydrationWarning className="form-select" style={{ width: 'auto', fontSize: 12, padding: '2px 6px' }}
            value={r.min_severity} onChange={e => patch(r.id, { min_severity: e.target.value as 'crit' | 'warn' })}>
            <option value="crit">Critical only</option>
            <option value="warn">Critical + warning</option>
          </select>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input suppressHydrationWarning type="checkbox" checked={r.daily_report} onChange={e => patch(r.id, { daily_report: e.target.checked })} />Daily report
          </label>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input suppressHydrationWarning type="checkbox" checked={r.enabled} onChange={e => patch(r.id, { enabled: e.target.checked })} />On
          </label>
          <button suppressHydrationWarning className="btn btn-sm" style={{ color: 'var(--crit)' }} onClick={() => remove(r.id)}>Remove</button>
        </div>
      ))}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        <input suppressHydrationWarning className="form-input" style={{ flex: '2 1 180px' }} placeholder="it-team@dnsc.edu.ph" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
        <input suppressHydrationWarning className="form-input" style={{ flex: '1 1 110px' }} placeholder="Name (optional)" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        <select suppressHydrationWarning className="form-select" style={{ flex: '1 1 140px' }} value={form.min_severity} onChange={e => setForm(f => ({ ...f, min_severity: e.target.value as 'crit' | 'warn' }))}>
          <option value="crit">Critical only</option>
          <option value="warn">Critical + warning</option>
        </select>
        <button suppressHydrationWarning className="btn btn-sm btn-primary" onClick={add}>Add</button>
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--crit)', marginTop: 6 }}>{err}</div>}
    </div>
  )
}

const BUILDINGS = ['All sites', 'Building A', 'Building B', 'Building C']

function AddUserModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ full_name: '', email: '', password: '', role: 'it_staff' as Role, building_access: 'All sites' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function save() {
    setSaving(true); setError(null)
    const res = await fetch('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
    })
    const d = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) { setError(d.error ?? 'Failed to add user'); return }
    onSaved(); onClose()
  }

  return (
    <Modal title="Add User" onClose={onClose}
      footer={<><button suppressHydrationWarning className="btn" onClick={onClose}>Cancel</button>
        <button suppressHydrationWarning className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Adding…' : 'Add User'}</button></>}
    >
      <div className="form-row">
        <div className="form-group"><label className="form-label">Full Name</label><input suppressHydrationWarning className="form-input" value={form.full_name} onChange={set('full_name')} /></div>
        <div className="form-group"><label className="form-label">Email</label><input suppressHydrationWarning className="form-input" type="email" value={form.email} onChange={set('email')} /></div>
      </div>
      <div className="form-row">
        <div className="form-group"><label className="form-label">Role</label>
          <select suppressHydrationWarning className="form-select" value={form.role} onChange={set('role')}>
            <option value="it_staff">{ROLE_LABEL.it_staff}</option>
            <option value="net_admin">{ROLE_LABEL.net_admin}</option>
          </select>
        </div>
        <div className="form-group"><label className="form-label">Building Access</label>
          <select suppressHydrationWarning className="form-select" value={form.building_access} onChange={set('building_access')}>
            {BUILDINGS.map(b => <option key={b}>{b}</option>)}
          </select>
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Temporary Password (min. 8 characters)</label>
        <input suppressHydrationWarning className="form-input" type="text" autoComplete="off" value={form.password} onChange={set('password')} />
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>Give this to the user so they can sign in.</div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text2)', background: 'var(--surface2)', padding: 10, borderRadius: 6 }}>
        <strong>{ROLE_LABEL.net_admin}:</strong> full access, including settings, users, devices and config backups.<br />
        <strong>{ROLE_LABEL.it_staff}:</strong> can view all monitoring pages and acknowledge or resolve alerts. Cannot change devices, settings or users.
      </div>
      {error && <div style={{ color: 'var(--crit)', fontSize: 13, marginTop: 10 }}>{error}</div>}
    </Modal>
  )
}

function timeAgo(iso: string | null) {
  if (!iso) return 'Never'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'Just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function UsersPanel() {
  const { profile: me } = useAuth()
  const [users, setUsers] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function load() {
    const res = await fetch('/api/users')
    const d = await res.json().catch(() => ({}))
    if (res.ok) setUsers(d.users ?? [])
    else setMsg(d.error ?? 'Could not load users — run supabase/roles.sql first.')
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function update(id: string, patch: Partial<Profile>) {
    const res = await fetch('/api/users', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...patch }),
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) setMsg(d.error ?? 'Update failed')
    load()
  }

  async function remove(u: Profile) {
    if (!confirm(`Remove ${u.full_name || u.email}? They will no longer be able to sign in.`)) return
    const res = await fetch(`/api/users?id=${u.id}`, { method: 'DELETE' })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) setMsg(d.error ?? 'Delete failed')
    load()
  }

  return (
    <div className="card">
      <div className="card-header">
        User Roles
        <div className="card-header-actions">
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)} suppressHydrationWarning>+ Add User</button>
        </div>
      </div>
      {msg && <div style={{ padding: '10px 16px', color: 'var(--crit)', fontSize: 13 }}>{msg}</div>}
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Building Access</th><th>Last Login</th><th></th></tr></thead>
          <tbody>
            {loading && <tr><td colSpan={6} style={{ color: 'var(--text3)' }}>Loading…</td></tr>}
            {!loading && users.map(u => {
              const isMe = u.id === me?.id
              return (
                <tr key={u.id}>
                  <td><strong>{u.full_name || '—'}</strong>{isMe && <span style={{ fontSize: 11, color: 'var(--text3)' }}> (you)</span>}</td>
                  <td style={{ fontSize: 12 }}>{u.email}</td>
                  <td>
                    <select suppressHydrationWarning className="form-select" style={{ width: 'auto', padding: '3px 6px', fontSize: 12 }}
                      value={u.role} disabled={isMe} onChange={e => update(u.id, { role: e.target.value as Role })}>
                      <option value="net_admin">{ROLE_LABEL.net_admin}</option>
                      <option value="it_staff">{ROLE_LABEL.it_staff}</option>
                    </select>
                  </td>
                  <td>
                    <select suppressHydrationWarning className="form-select" style={{ width: 'auto', padding: '3px 6px', fontSize: 12 }}
                      value={u.building_access} onChange={e => update(u.id, { building_access: e.target.value })}>
                      {BUILDINGS.map(b => <option key={b}>{b}</option>)}
                    </select>
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text3)' }}>{timeAgo(u.last_login)}</td>
                  <td>{!isMe && <button className="btn btn-sm" style={{ color: 'var(--crit)' }} onClick={() => remove(u)} suppressHydrationWarning>Remove</button>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {adding && <AddUserModal onClose={() => setAdding(false)} onSaved={load} />}
    </div>
  )
}

const DEFAULT_CFG: Omit<AlertConfig, 'id' | 'updated_at' | 'updated_by'> = {
  cpu_warn_pct: 80, cpu_crit_pct: 95,
  mem_warn_pct: 85, mem_crit_pct: 95,
  latency_warn_ms: 100, latency_crit_ms: 250,
  flap_threshold: 3, grace_period_min: 0,
}

export default function SettingsPage() {
  const [tab,         setTab]      = useState<SettingsTab>('notif')
  // Open a tab from the link, e.g. /settings?tab=manage
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab') as SettingsTab | null
    if (t && SETTINGS_TABS.includes(t)) setTab(t)
  }, [])
  const { profile } = useAuth()
  const myName = profile?.full_name || profile?.email || 'Unknown'
  const [cfg,         setCfg]      = useState(DEFAULT_CFG)
  const [cfgSaving,   setCfgSaving] = useState(false)
  const [cfgMsg,      setCfgMsg]   = useState<string | null>(null)
  const [smtp,        setSmtp]     = useState<SmtpStatus | null>(null)
  const [testingEmail, setTestingEmail] = useState(false)
  const [emailMsg,    setEmailMsg] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/alert-config')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setCfg({ cpu_warn_pct: d.cpu_warn_pct, cpu_crit_pct: d.cpu_crit_pct, mem_warn_pct: d.mem_warn_pct, mem_crit_pct: d.mem_crit_pct, latency_warn_ms: d.latency_warn_ms, latency_crit_ms: d.latency_crit_ms, flap_threshold: d.flap_threshold, grace_period_min: d.grace_period_min }) })
      .catch(() => {})
    fetch('/api/notify/email')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setSmtp(d) })
      .catch(() => {})
  }, [])

  const setN = (k: keyof typeof cfg) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCfg(c => ({ ...c, [k]: Number(e.target.value) }))

  async function saveThresholds() {
    setCfgSaving(true); setCfgMsg(null)
    const res = await fetch('/api/alert-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...cfg, updated_by: myName }),
    })
    await supabase.from('audit_log').insert({
      user_name: myName, user_ip: 'browser',
      action: 'Threshold Changed', object_name: 'Alert thresholds',
      before_val: 'old', after_val: JSON.stringify(cfg),
    })
    setCfgSaving(false)
    setCfgMsg(res.ok ? '✓ Thresholds saved.' : '✗ Failed — run supabase/migration_objectives.sql first.')
    setTimeout(() => setCfgMsg(null), 4000)
  }

  return (
    <>
      <div className="tabs" id="settings-tabs">
        {SETTINGS_TABS.map(t => (
          <div key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {{ notif:'Notifications', roles:'Roles & Access', manage:'Manage', maint:'Maintenance' }[t]}
          </div>
        ))}
      </div>

      {/* ── Manage: device details + floor plan rooms ── */}
      {tab === 'manage' && <ManageSection />}

      {/* ── Notifications ── */}
      {tab === 'notif' && (
        <div className="grid-2">
          <div className="card">
            <div className="card-header">Email Notifications (SMTP)</div>
            <div className="card-body">
              {smtp && (
                <div style={{
                  marginBottom: 14, padding: '8px 12px', borderRadius: 'var(--r)',
                  background: smtp.configured ? 'rgba(63,185,80,.08)' : 'rgba(248,81,73,.08)',
                  border: `1px solid ${smtp.configured ? 'rgba(63,185,80,.2)' : 'rgba(248,81,73,.2)'}`,
                  fontSize: 12,
                }}>
                  {smtp.configured
                    ? <>✓ Email is on — {smtp.status}</>
                    : !smtp.migrated
                      ? <>✗ Run <code>supabase/migration_objectives.sql</code> in Supabase, then restart the agent.</>
                      : !smtp.status
                        ? <>✗ No email status from the agent yet{smtp.agentOnline ? ' — restart the agent' : ' (agent offline)'}.</>
                        : <>✗ Email is off — add these to the agent&apos;s <code>.env</code> (on the monitoring laptop) and run <code>pm2 restart securenet</code>:</>
                  }
                  {smtp.migrated && smtp.status && !smtp.configured && (
                    <pre style={{ margin: '8px 0 0', fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text2)', whiteSpace: 'pre-wrap' }}>
{`SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@email.com
SMTP_PASS=your-app-password`}
                    </pre>
                  )}
                  {smtp.configured && !smtp.agentOnline && <div style={{ marginTop: 4, color: 'var(--warn)' }}>Agent offline — emails resume when it reports again.</div>}
                </div>
              )}
              <RecipientsPanel />
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <button suppressHydrationWarning
                  className="btn btn-sm btn-primary"
                  disabled={!smtp?.configured || testingEmail}
                  onClick={async () => {
                    setTestingEmail(true); setEmailMsg(null)
                    try {
                      const r = await fetch('/api/notify/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
                      const d = await r.json()
                      setEmailMsg(r.ok
                        ? `✓ Test email sent to ${d.to}${d.sent ? ` (with ${d.sent} open alert${d.sent === 1 ? '' : 's'})` : ''}`
                        : `✗ ${d.error}`)
                    } catch { setEmailMsg('✗ Request failed') }
                    finally { setTestingEmail(false); setTimeout(() => setEmailMsg(null), 6000) }
                  }}
                >
                  {testingEmail ? 'Sending…' : 'Send Test Email'}
                </button>
                {emailMsg && <span style={{ fontSize: 12, alignSelf: 'center', color: emailMsg.startsWith('✓') ? 'var(--ok)' : 'var(--crit)' }}>{emailMsg}</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 14 }}>
                The monitoring agent emails a device that has been offline / not responding for 45 minutes (one that comes back sooner is not emailed), other critical alerts such as CPU or memory within about 20 seconds (and warnings, for recipients who chose them), an incident report when an emailed incident is resolved, and the daily report each morning — no dashboard needs to be open. Each alert is emailed once.
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-header">Alert Thresholds</div>
            <div className="card-body">
              <div className="form-row">
                <div className="form-group"><label className="form-label">CPU Warning (%)</label><input suppressHydrationWarning className="form-input" type="number" value={cfg.cpu_warn_pct} onChange={setN('cpu_warn_pct')} /></div>
                <div className="form-group"><label className="form-label">CPU Critical (%)</label><input suppressHydrationWarning className="form-input" type="number" value={cfg.cpu_crit_pct} onChange={setN('cpu_crit_pct')} /></div>
              </div>
              <div className="form-row">
                <div className="form-group"><label className="form-label">Memory Warning (%)</label><input suppressHydrationWarning className="form-input" type="number" value={cfg.mem_warn_pct} onChange={setN('mem_warn_pct')} /></div>
                <div className="form-group"><label className="form-label">Memory Critical (%)</label><input suppressHydrationWarning className="form-input" type="number" value={cfg.mem_crit_pct} onChange={setN('mem_crit_pct')} /></div>
              </div>
              <div className="form-row">
                <div className="form-group"><label className="form-label">Latency Warning (ms)</label><input suppressHydrationWarning className="form-input" type="number" value={cfg.latency_warn_ms} onChange={setN('latency_warn_ms')} /></div>
                <div className="form-group"><label className="form-label">Latency Critical (ms)</label><input suppressHydrationWarning className="form-input" type="number" value={cfg.latency_crit_ms} onChange={setN('latency_crit_ms')} /></div>
              </div>
              <div className="form-row">
                <div className="form-group"><label className="form-label">Flap Threshold (flips / 5 min)</label><input suppressHydrationWarning className="form-input" type="number" value={cfg.flap_threshold} onChange={setN('flap_threshold')} /></div>
                <div className="form-group"><label className="form-label">Grace Period (min before alert)</label><input suppressHydrationWarning className="form-input" type="number" value={cfg.grace_period_min} onChange={setN('grace_period_min')} /></div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
                CPU / memory: alert while an SNMP device is at or above the level (critical above the critical level). Flap threshold: a device that goes offline and comes back this many times in 5 minutes raises a &quot;flapping&quot; warning. Grace period: minutes a device must stay offline before the offline alert (0 = alert as soon as it is confirmed offline). Used by the agent within a minute of saving.
              </div>
              {cfgMsg && <div style={{ marginBottom: 10, fontSize: 13, color: cfgMsg.startsWith('✓') ? 'var(--ok)' : 'var(--crit)' }}>{cfgMsg}</div>}
              <button suppressHydrationWarning className="btn btn-primary" onClick={saveThresholds} disabled={cfgSaving}>
                {cfgSaving ? 'Saving…' : 'Save Thresholds'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Roles ── */}
      {tab === 'roles' && <UsersPanel />}

      {/* ── Maintenance ── */}
      {tab === 'maint' && (
        <div className="card">
          <div className="card-header">
            Maintenance Windows
            <div className="card-header-actions">
              <button suppressHydrationWarning className="btn btn-primary btn-sm" onClick={() => (window as unknown as Record<string,()=>void>).__openMaintenance?.()}>+ New Window</button>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Name</th><th>Devices</th><th>Start</th><th>End</th><th>Recurrence</th><th>Status</th><th></th></tr></thead>
              <tbody>
                <tr><td>Weekly Patch Night</td><td>All switches</td><td>Sat 23:00</td><td>Sun 03:00</td><td>Weekly</td><td><span className="chip chip-maint">Scheduled</span></td><td><button suppressHydrationWarning className="btn btn-sm">Edit</button></td></tr>
                <tr><td>Bldg B UPS Replacement</td><td>SW-B2, AP-B-01</td><td>2026-11-06 08:00</td><td>2026-11-06 12:00</td><td>Once</td><td><span className="chip chip-warn">Upcoming</span></td><td><button suppressHydrationWarning className="btn btn-sm">Edit</button></td></tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

    </>
  )
}
