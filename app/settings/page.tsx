'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import Modal from '@/components/Modal'
import type { AlertConfig } from '@/lib/database.types'
import { useAuth } from '@/components/AuthProvider'
import ManageSection from '@/components/ManageSection'
import { ROLE_LABEL, type Profile, type Role } from '@/lib/roles'

type SettingsTab = 'notif' | 'roles' | 'manage' | 'maint' | 'disc' | 'integrations'
const SETTINGS_TABS: SettingsTab[] = ['notif', 'roles', 'manage', 'maint', 'disc', 'integrations']

import type { SmtpStatus } from '@/lib/database.types'

function Toggle({ label, sub, defaultChecked }: { label: string; sub: string; defaultChecked?: boolean }) {
  const [on, setOn] = useState(defaultChecked ?? false)
  return (
    <div className="toggle-wrap">
      <label className="toggle">
        <input suppressHydrationWarning type="checkbox" checked={on} onChange={e => setOn(e.target.checked)} />
        <span className="toggle-slider" />
      </label>
      <div>
        <div style={{ fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>{sub}</div>
      </div>
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
  flap_threshold: 3, grace_period_min: 5,
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
    setCfgMsg(res.ok ? '✓ Thresholds saved.' : '✗ Failed — run supabase/alert_enhancements.sql first.')
    setTimeout(() => setCfgMsg(null), 4000)
  }

  return (
    <>
      <div className="tabs" id="settings-tabs">
        {(['notif','roles','manage','maint','disc','integrations'] as SettingsTab[]).map(t => (
          <div key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {{ notif:'Notifications', roles:'Roles & Access', manage:'Manage', maint:'Maintenance', disc:'Discovery', integrations:'Integrations' }[t]}
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
                    ? <>✓ SMTP configured — <strong>{smtp.user}</strong> via {smtp.host}:{smtp.port} → <strong>{smtp.to ?? smtp.user}</strong></>
                    : <>✗ SMTP not configured. Add these to <code>.env.local</code> and restart:</>
                  }
                  {!smtp.configured && (
                    <pre style={{ margin: '8px 0 0', fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text2)', whiteSpace: 'pre-wrap' }}>
{`SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@email.com
SMTP_PASS=your-app-password
SMTP_TO=alerts-recipient@email.com`}
                    </pre>
                  )}
                </div>
              )}
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
                        ? (d.sent === 0 ? '✓ SMTP works — no active alerts to send right now' : `✓ Sent ${d.sent} alert(s) to ${d.to}`)
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
                Email is sent automatically when a critical alert fires (after {smtp?.cooldown_min ?? 30} min cooldown per alert). Configure SMTP credentials in <code>.env.local</code>.
              </div>
              <Toggle label="Browser Push Notifications" sub="Alert shown in OS notification center" defaultChecked />
              <Toggle label="Telegram"        sub="@nw_alerts_bot → #securenet-alerts (configure via webhook)" />
              <Toggle label="Slack"           sub="#network-ops workspace (configure via webhook)" />
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
                Grace period prevents alerts for temporary flaps. Flap threshold ignores rapid state changes.
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

      {/* ── Discovery ── */}
      {tab === 'disc' && (
        <div className="grid-2">
          <div className="card">
            <div className="card-header">Network Discovery</div>
            <div className="card-body">
              <div className="form-group"><label className="form-label">Subnet Range</label><input suppressHydrationWarning className="form-input" defaultValue="192.168.0.0/16" /></div>
              <div className="form-group"><label className="form-label">SNMP Community</label><input suppressHydrationWarning className="form-input" defaultValue="nw2026" type="password" /></div>
              <div className="form-group"><label className="form-label">Polling Interval</label>
                <select suppressHydrationWarning className="form-select"><option>1 second</option><option selected>30 seconds</option><option>1 minute</option><option>5 minutes</option></select>
              </div>
              <button suppressHydrationWarning className="btn btn-primary" onClick={() => alert('Discovery started on 192.168.0.0/16…')}>Start Discovery</button>
            </div>
          </div>
          <div className="card">
            <div className="card-header">Rogue Device Alerts</div>
            <div className="card-body">
              <Toggle label="Alert on unknown MACs" sub="Notify when unrecognized device joins" defaultChecked />
              <Toggle label="Auto-quarantine rogues" sub="Block unknown MACs automatically" defaultChecked />
              <div style={{ background: 'rgba(210,153,34,.08)', border: '1px solid rgba(210,153,34,.2)', borderRadius: 'var(--r)', padding: 10, fontSize: 13 }}>
                <strong style={{ color: 'var(--warn)' }}>1 unknown MAC detected</strong><br />
                <span style={{ color: 'var(--text2)' }}>E4:5F:01:9D:72:AB — Building B</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Integrations ── */}
      {tab === 'integrations' && (
        <div className="grid-3">
          {[
            { icon: '🎫', label: 'Ticketing Webhook', sub: 'Auto-create tickets on critical alerts', placeholder: 'https://your-psa.example/api/tickets' },
            { icon: '☸',  label: 'Kubernetes',        sub: 'Monitor cluster nodes and services',    placeholder: 'kubeconfig or API server URL' },
          ].map(item => (
            <div className="card" key={item.label}>
              <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 20 }}>{item.icon}</div>
                <div style={{ fontWeight: 600 }}>{item.label}</div>
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>{item.sub}</div>
                <input suppressHydrationWarning className="form-input" placeholder={item.placeholder} />
                <button suppressHydrationWarning className="btn btn-sm">Save</button>
              </div>
            </div>
          ))}
          <div className="card">
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 20 }}>📡</div>
              <div style={{ fontWeight: 600 }}>JSON-RPC API</div>
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>External access via API tokens</div>
              <code style={{ background: 'var(--surface2)', padding: '6px 8px', borderRadius: 'var(--r)', display: 'block', wordBreak: 'break-all', fontFamily: 'var(--mono)', fontSize: 11 }}>nw_tok_abc123def456</code>
              <button suppressHydrationWarning className="btn btn-sm" onClick={() => alert('Token regenerated!')}>Regenerate</button>
            </div>
          </div>
        </div>
      )}

    </>
  )
}
