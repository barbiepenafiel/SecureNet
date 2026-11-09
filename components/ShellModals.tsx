'use client'

import { useState } from 'react'
import Modal from './Modal'
import { supabase } from '@/lib/supabase'

// ── Add Device ────────────────────────────────────────────
function AddDeviceModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ name: '', ip: '', type: 'Access Point', location: 'Building A', snmp: '' })
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    await supabase.from('devices').insert({
      name: form.name, ip: form.ip, type: form.type,
      location: form.location, status: 'up', uptime: '—', cpu: 0, mem: 0,
      snmp_community: form.snmp || 'nw2026',
      snmp_port: 161,
    })
    setSaving(false)
    onClose()
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  return (
    <Modal title="Add Device" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={saving || !form.name || !form.ip}>
          {saving ? 'Saving…' : 'Add Device'}
        </button>
      </>}
    >
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Hostname</label>
          <input className="form-input" placeholder="e.g. AP-A-05" value={form.name} onChange={set('name')} />
        </div>
        <div className="form-group">
          <label className="form-label">IP Address</label>
          <input className="form-input" placeholder="192.168.1.x" value={form.ip} onChange={set('ip')} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Type</label>
          <select className="form-select" value={form.type} onChange={set('type')}>
            <option>Router</option><option>Switch</option><option>Access Point</option>
            <option>Server</option><option>Firewall</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Building</label>
          <select className="form-select" value={form.location} onChange={set('location')}>
            <option>Building A</option><option>Building B</option>
            <option>Building C</option><option>Data Center</option>
          </select>
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">SNMP Community</label>
        <input className="form-input" placeholder="nw2026" value={form.snmp} onChange={set('snmp')} />
      </div>
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
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save Window'}
        </button>
      </>}
    >
      <div className="form-group">
        <label className="form-label">Name</label>
        <input className="form-input" placeholder="e.g. Patch night" value={form.name} onChange={set('name')} />
      </div>
      <div className="form-group">
        <label className="form-label">Devices</label>
        <input className="form-input" placeholder="SW-A1, SW-A2 or All" value={form.devices} onChange={set('devices')} />
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Start</label>
          <input className="form-input" type="datetime-local" value={form.starts_at} onChange={set('starts_at')} />
        </div>
        <div className="form-group">
          <label className="form-label">End</label>
          <input className="form-input" type="datetime-local" value={form.ends_at} onChange={set('ends_at')} />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Recurrence</label>
        <select className="form-select" value={form.recurrence} onChange={set('recurrence')}>
          <option>Once</option><option>Weekly</option><option>Monthly</option>
        </select>
      </div>
      <div className="form-group">
        <label className="form-label">Note</label>
        <textarea className="form-textarea" placeholder="Reason for maintenance…" value={form.note}
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
