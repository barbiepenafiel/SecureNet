'use client'

import { useState } from 'react'
import Modal from './Modal'
import { supabase } from '@/lib/supabase'
import { useBuildings, locationOptions } from '@/lib/buildings'

// ── Add Device (verified live: ICMP · ARP · SNMP) ─────────
const DEVICE_TYPES = ['Router', 'Switch', 'Access Point', 'Firewall', 'Server', 'Computer', 'Client']

interface Probe {
  ip: string; reachable: boolean; localNetwork: boolean
  icmp: { ok: boolean; latencyMs: number | null; ttl: number | null }
  arp:  { ok: boolean; mac: string | null }
  snmp: { ok: boolean; community: string | null; version: string | null; sysName: string | null; sysDescr: string | null
          uptime: string | null; location: string | null; tried: string[]; status?: string; detail?: string }
  hostname: string | null; vendor: string | null; model: string | null; firmware: string | null; osHint: string | null
  suggested: { name: string; type: string; method: string | null }
}
interface Existing { id: string; name: string; ip: string; type: string; status: string; source: string | null; location: string }

// Why SNMP didn't answer (decided by the agent from its current network)
const SNMP_LABEL: Record<string, string> = {
  unreachable: 'Unreachable', disabled: 'SNMP disabled', auth_failed: 'Access refused', timeout: 'Timeout',
}

function Check({ ok, label, children }: { ok: boolean; label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: 12 }}>
      <span style={{ width: 18, fontWeight: 700, color: ok ? 'var(--ok)' : 'var(--text3)' }}>{ok ? '✓' : '✕'}</span>
      <span style={{ width: 44, fontWeight: 600 }}>{label}</span>
      <span style={{ flex: 1, color: ok ? 'var(--text)' : 'var(--text3)', minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  )
}

function AddDeviceModal({ onClose }: { onClose: () => void }) {
  const { names: buildingNames } = useBuildings()
  const [target,   setTarget]   = useState({ ip: '', community: '', port: '161' })
  const [form,     setForm]     = useState({ name: '', type: 'Client', location: 'Unassigned' })
  const [probe,    setProbe]    = useState<Probe | null>(null)
  const [existing, setExisting] = useState<Existing[]>([])
  const [useId,    setUseId]    = useState<string | null>(null)
  const [jobId,    setJobId]    = useState<string | null>(null)   // the agent's measurement (hosted dashboard)
  const [probing,  setProbing]  = useState(false)
  const [saving,   setSaving]   = useState(false)
  const [err,      setErr]      = useState<string | null>(null)

  // Changing what to probe invalidates the last result
  const setT = (k: keyof typeof target) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setTarget(t => ({ ...t, [k]: e.target.value })); setProbe(null); setExisting([]); setUseId(null); setJobId(null); setErr(null)
  }
  const setF = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function detect() {
    setProbing(true); setErr(null); setProbe(null); setExisting([]); setUseId(null)
    try {
      const res = await fetch('/api/devices/probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: target.ip.trim(), community: target.community.trim(), port: Number(target.port) || 161 }),
      })
      const d = await res.json()
      if (!res.ok) { setErr(d.error ?? 'Detection failed'); return }
      const p = d.result as Probe
      const ex = (d.existing ?? []) as Existing[]
      setProbe(p); setExisting(ex); setJobId(d.jobId ?? null)
      if (ex.length) {
        // Prefill from the existing record so it is updated, not duplicated
        setUseId(ex[0].id)
        setForm({ name: ex[0].name, type: DEVICE_TYPES.includes(ex[0].type) ? ex[0].type : p.suggested.type, location: ex[0].location || 'Unassigned' })
      } else {
        setForm(f => ({ ...f, name: p.suggested.name || f.name, type: p.suggested.type }))
      }
    } catch {
      setErr('Could not reach the server')
    } finally {
      setProbing(false)
    }
  }

  async function save() {
    if (!probe) return
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/devices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: probe.ip, community: target.community.trim(), port: Number(target.port) || 161,
          name: form.name.trim(), type: form.type, location: form.location, existingId: useId, jobId,
        }),
      })
      const d = await res.json()
      if (!res.ok) { setErr(d.error ?? 'Could not save'); return }
      onClose()
    } catch {
      setErr('Could not reach the server')
    } finally {
      setSaving(false)
    }
  }

  const canDetect = /^\d{1,3}(\.\d{1,3}){3}$/.test(target.ip.trim()) && !probing
  const saveLabel = saving ? 'Saving…' : useId ? 'Update Device' : probe && !probe.reachable ? 'Add Anyway' : 'Add Device'

  return (
    <Modal title="Add Device" onClose={onClose}
      footer={<>
        <button suppressHydrationWarning className="btn" onClick={onClose}>Cancel</button>
        <button suppressHydrationWarning className="btn btn-primary" onClick={save}
                disabled={!probe || saving || !form.name.trim()}>
          {saveLabel}
        </button>
      </>}
    >
      {/* 1. What to check */}
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">IP Address *</label>
          <input suppressHydrationWarning className="form-input mono" placeholder="192.168.1.20" value={target.ip}
                 onChange={setT('ip')} onKeyDown={e => { if (e.key === 'Enter' && canDetect) detect() }} />
        </div>
        <div className="form-group">
          <label className="form-label">SNMP Community</label>
          <input suppressHydrationWarning className="form-input" placeholder="blank = try “public”" value={target.community}
                 onChange={setT('community')} onKeyDown={e => { if (e.key === 'Enter' && canDetect) detect() }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
        <div className="form-group" style={{ width: 110, marginBottom: 0 }}>
          <label className="form-label">SNMP Port</label>
          <input suppressHydrationWarning className="form-input" value={target.port} onChange={setT('port')} />
        </div>
        <button suppressHydrationWarning className="btn btn-primary" onClick={detect} disabled={!canDetect}>
          {probing ? 'Checking ICMP · ARP · SNMP…' : probe ? 'Check Again' : 'Detect Device'}
        </button>
      </div>

      {err && <div style={{ color: 'var(--crit)', fontSize: 13, marginBottom: 10 }}>{err}</div>}

      {!probe && !probing && (
        <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.6 }}>
          SecureNet contacts the device now — ping (ICMP), MAC address (ARP) and SNMP — and fills in what it finds.
        </div>
      )}

      {/* 2. What the device answered */}
      {probe && (
        <>
          <div style={{ marginBottom: 12 }}>
            <Check ok={probe.icmp.ok} label="ICMP">
              {probe.icmp.ok
                ? <>Replied · {probe.icmp.latencyMs} ms · TTL {probe.icmp.ttl}{probe.osHint ? ` · ${probe.osHint}` : ''}</>
                : 'No ping reply (device off, or it blocks ping)'}
            </Check>
            <Check ok={probe.arp.ok} label="ARP">
              {probe.arp.ok
                ? <><span className="mono">{probe.arp.mac}</span>{probe.vendor ? ` · ${probe.vendor}` : ''}</>
                : probe.localNetwork ? 'No MAC answer on this network' : 'Not on the monitoring agent’s network (routed) — MAC not visible'}
            </Check>
            <Check ok={probe.snmp.ok} label="SNMP">
              {probe.snmp.ok
                ? <>{probe.snmp.version} · community “{probe.snmp.community}” · {probe.snmp.sysName ?? 'no name'}
                    {probe.snmp.uptime ? ` · up ${probe.snmp.uptime}` : ''}
                    {probe.snmp.sysDescr && <div style={{ color: 'var(--text3)' }}>{probe.snmp.sysDescr.slice(0, 120)}</div>}</>
                : probe.snmp.status && probe.snmp.detail
                  ? <><strong>{SNMP_LABEL[probe.snmp.status] ?? 'No answer'}</strong> — {probe.snmp.detail} (tried {probe.snmp.tried.join(', ')})</>
                  : <>No answer (tried {probe.snmp.tried.join(', ')}). Enable SNMP on the device and allow this server&apos;s IP.</>}
            </Check>
            {(probe.model || probe.firmware || probe.hostname) && (
              <div style={{ fontSize: 12, color: 'var(--text2)', borderTop: '1px solid var(--border)', paddingTop: 7 }}>
                {probe.model && <>Model <strong>{probe.model}</strong> · </>}
                {probe.firmware && <>Firmware <strong>{probe.firmware}</strong> · </>}
                {probe.hostname && <>DNS <strong>{probe.hostname}</strong></>}
              </div>
            )}
          </div>

          {!probe.reachable && (
            <div style={{ border: '1px solid var(--crit)', background: 'rgba(248,81,73,.08)', borderRadius: 8, padding: '8px 12px', fontSize: 12, marginBottom: 12 }}>
              <strong style={{ color: 'var(--crit)' }}>No answer by ICMP, ARP or SNMP.</strong> Check the IP and that the device is on.
              You can still add it — it will show as Unknown until the monitor reaches it.
            </div>
          )}

          {existing.length > 0 && (
            <div style={{ border: '1px solid var(--warn)', background: 'rgba(210,153,34,.08)', borderRadius: 8, padding: '8px 12px', fontSize: 12, marginBottom: 12 }}>
              <strong style={{ color: 'var(--warn)' }}>Already in SecureNet:</strong>{' '}
              {existing.map(e => `${e.name} (${e.ip}, ${e.source ?? 'manual'})`).join(', ')}.
              {' '}Saving updates that record instead of creating a duplicate.
            </div>
          )}

          {/* 3. How to list it */}
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Name *</label>
              <input suppressHydrationWarning className="form-input" value={form.name} onChange={setF('name')} placeholder="e.g. AP-A-05" />
            </div>
            <div className="form-group">
              <label className="form-label">Type</label>
              <select suppressHydrationWarning className="form-select" value={form.type} onChange={setF('type')}>
                {DEVICE_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Location</label>
            <select suppressHydrationWarning className="form-select" value={form.location} onChange={setF('location')}>
              {locationOptions(buildingNames, form.location).map(l => <option key={l}>{l}</option>)}
            </select>
          </div>
        </>
      )}
    </Modal>
  )
}

// ── Maintenance Window ────────────────────────────────────
function MaintenanceModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({
    name: '', devices: '', starts_at: '', ends_at: '', recurrence: 'Once', note: '',
  })
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!form.name || !form.starts_at || !form.ends_at) return
    setSaving(true)
    await supabase.from('maintenance_windows').insert({
      name: form.name, devices: form.devices, starts_at: form.starts_at,
      ends_at: form.ends_at, recurrence: form.recurrence, note: form.note, status: 'Scheduled',
    })
    setSaving(false)
    onClose()
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  return (
    <Modal title="New Maintenance Window" onClose={onClose}
      footer={<>
        <button suppressHydrationWarning className="btn" onClick={onClose}>Cancel</button>
        <button suppressHydrationWarning className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save Window'}
        </button>
      </>}
    >
      <div className="form-group">
        <label className="form-label">Name</label>
        <input suppressHydrationWarning className="form-input" placeholder="e.g. Patch night" value={form.name} onChange={set('name')} />
      </div>
      <div className="form-group">
        <label className="form-label">Devices</label>
        <input suppressHydrationWarning className="form-input" placeholder="SW-A1, SW-A2 or All" value={form.devices} onChange={set('devices')} />
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Start</label>
          <input suppressHydrationWarning className="form-input" type="datetime-local" value={form.starts_at} onChange={set('starts_at')} />
        </div>
        <div className="form-group">
          <label className="form-label">End</label>
          <input suppressHydrationWarning className="form-input" type="datetime-local" value={form.ends_at} onChange={set('ends_at')} />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Recurrence</label>
        <select suppressHydrationWarning className="form-select" value={form.recurrence} onChange={set('recurrence')}>
          <option>Once</option><option>Weekly</option><option>Monthly</option>
        </select>
      </div>
      <div className="form-group">
        <label className="form-label">Note</label>
        <textarea suppressHydrationWarning className="form-textarea" placeholder="Reason for maintenance…" value={form.note}
          onChange={set('note')} />
      </div>
    </Modal>
  )
}

// ── Shell wrapper (rendered inside layout) ─────────────────
export default function ShellModals() {
  const [modal, setModal] = useState<'addDevice' | 'maintenance' | null>(null)

  // Expose open functions via custom events so Topbar can trigger them
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__openAddDevice    = () => setModal('addDevice')
    ;(window as unknown as Record<string, unknown>).__openMaintenance = () => setModal('maintenance')
  }

  if (!modal) return null
  if (modal === 'addDevice')   return <AddDeviceModal   onClose={() => setModal(null)} />
  if (modal === 'maintenance') return <MaintenanceModal onClose={() => setModal(null)} />
  return null
}
