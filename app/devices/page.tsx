'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import Modal from '@/components/Modal'
import type { Device, ScanResult } from '@/lib/database.types'

type SourceFilter = 'all' | 'managed' | 'discovered'
type StatusFilter = 'all' | 'up' | 'warn' | 'down' | 'maint' | 'attention'

type UnifiedRow =
  | { kind: 'managed';    dev: Device }
  | { kind: 'discovered'; scan: ScanResult }

function CheckNowButton({ onDone }: { onDone: () => void }) {
  const [checking, setChecking] = useState(false)
  const [result,   setResult]   = useState<string | null>(null)

  async function checkNow() {
    setChecking(true)
    setResult(null)
    try {
      const res  = await fetch('/api/monitor', { method: 'POST' })
      const data = await res.json()
      const down = (data.managed ?? data.results ?? []).filter((r: { up: boolean }) => !r.up).length
      const total = data.checked ?? 0
      setResult(down > 0 ? `${down} device(s) offline` : `All ${total} device(s) online`)
      onDone()
    } catch {
      setResult('Check failed')
    } finally {
      setChecking(false)
      setTimeout(() => setResult(null), 4000)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button className="btn btn-sm" onClick={checkNow} disabled={checking}
        style={{ background: checking ? undefined : '#1e3a5f', color: '#fff', border: 'none' }}>
        {checking ? '⏳ Checking…' : '⚡ Check Now'}
      </button>
      {result && (
        <span style={{
          fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
          background: result.includes('offline') ? 'rgba(239,68,68,.1)' : 'rgba(34,197,94,.1)',
          color: result.includes('offline') ? 'var(--crit)' : 'var(--ok)',
        }}>{result}</span>
      )}
    </div>
  )
}

function statusChip(s: string) {
  const cls:   Record<string, string> = { up: 'chip-ok', warn: 'chip-warn', down: 'chip-crit', maint: 'chip-maint' }
  const label: Record<string, string> = { up: 'Online', warn: 'Warning', down: 'Offline', maint: 'Maintenance' }
  return <span className={`chip ${cls[s] ?? 'chip-off'}`}>{label[s] ?? s}</span>
}

function cpuColor(v: number) {
  return v >= 90 ? 'var(--crit)' : v >= 75 ? 'var(--warn)' : 'var(--ok)'
}

function needsAttention(d: Device) {
  return d.status === 'down' || d.cpu >= 75 || d.mem >= 85
}

// ── Edit Device Modal ───────────────────────────────────────────────────
function EditDeviceModal({ device, onClose, onSaved }: {
  device: Device; onClose: () => void; onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: device.name, type: device.type,
    ip: device.ip, location: device.location, status: device.status,
  })
  const [saving, setSaving] = useState(false)
  const [err,    setErr]    = useState<string | null>(null)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function save() {
    setSaving(true); setErr(null)
    const { error } = await supabase.from('devices').update({
      name: form.name, type: form.type, ip: form.ip,
      location: form.location, status: form.status,
    }).eq('id', device.id)
    setSaving(false)
    if (error) { setErr(error.message); return }
    onSaved(); onClose()
  }

  return (
    <Modal title={`Edit Device: ${device.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button></>}>
      {err && <div style={{ color: 'var(--crit)', marginBottom: 10, fontSize: 13 }}>{err}</div>}
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Name</label>
          <input className="form-input" value={form.name} onChange={set('name')} />
        </div>
        <div className="form-group">
          <label className="form-label">Type</label>
          <select suppressHydrationWarning className="form-select" value={form.type} onChange={set('type')}>
            {['Firewall','Router','Switch','Access Point','Server'].map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">IP Address</label>
          <input suppressHydrationWarning className="form-input mono" value={form.ip} onChange={set('ip')} />
        </div>
        <div className="form-group">
          <label className="form-label">Location</label>
          <select suppressHydrationWarning className="form-select" value={form.location} onChange={set('location')}>
            {['Building A','Building B','Building C','Data Center','Library','Admin Building'].map(l => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Status</label>
        <select suppressHydrationWarning className="form-select" value={form.status} onChange={set('status')}>
          <option value="up">Up</option>
          <option value="warn">Warning</option>
          <option value="down">Down</option>
          <option value="maint">Maintenance</option>
        </select>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>
        Last updated: {new Date(device.updated_at).toLocaleString()}
      </div>
    </Modal>
  )
}

// ── Add Discovered Device Modal ─────────────────────────────────────────
function AddDiscoveredModal({ scan, onClose, onSaved }: {
  scan: ScanResult; onClose: () => void; onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: scan.hostname ?? '', type: 'Server',
    ip: scan.ip, location: 'Building A',
  })
  const [saving, setSaving] = useState(false)
  const [err,    setErr]    = useState<string | null>(null)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function save() {
    if (!form.name.trim()) { setErr('Name is required'); return }
    setSaving(true); setErr(null)
    const { error } = await supabase.from('devices').insert({
      name: form.name, type: form.type, ip: form.ip,
      location: form.location, status: 'up',
      cpu: 0, mem: 0, uptime: '—',
    })
    setSaving(false)
    if (error) { setErr(error.message); return }
    onSaved(); onClose()
  }

  return (
    <Modal title="Add Discovered Device" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Adding…' : 'Add Device'}
        </button></>}>
      {err && <div style={{ color: 'var(--crit)', marginBottom: 10, fontSize: 13 }}>{err}</div>}
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>
        Discovered via {scan.scan_type.toUpperCase()} · IP {scan.ip}
        {scan.mac ? ` · MAC ${scan.mac}` : ''}
        {scan.latency_ms != null ? ` · ${scan.latency_ms}ms` : ''}
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Device Name *</label>
          <input suppressHydrationWarning className="form-input" value={form.name} onChange={set('name')} placeholder="e.g. AP-B-03" />
        </div>
        <div className="form-group">
          <label className="form-label">Type</label>
          <select suppressHydrationWarning className="form-select" value={form.type} onChange={set('type')}>
            {['Firewall','Router','Switch','Access Point','Server'].map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">IP Address</label>
          <input suppressHydrationWarning className="form-input mono" value={form.ip} onChange={set('ip')} />
        </div>
        <div className="form-group">
          <label className="form-label">Location</label>
          <select suppressHydrationWarning className="form-select" value={form.location} onChange={set('location')}>
            {['Building A','Building B','Building C','Data Center','Library','Admin Building'].map(l => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  )
}

export default function DevicesPage() {
  const [devices,     setDevices]   = useState<Device[]>([])
  const [search,      setSearch]    = useState('')
  const [typeF,       setTypeF]     = useState('')
  const [bldgF,       setBldgF]     = useState('')
  const [statusF,     setStatusF]   = useState<StatusFilter>('all')
  const [sourceF,     setSourceF]   = useState<SourceFilter>('all')
  const [deleting,    setDeleting]  = useState<string | null>(null)   // device id being deleted
  const [detail,      setDetail]    = useState<Device | null>(null)
  const [editing,     setEditing]   = useState<Device | null>(null)
  const [addingScan,  setAddingScan] = useState<ScanResult | null>(null)

  const [scanResults, setScanResults] = useState<ScanResult[]>([])
  const [scanSubnet,  setScanSubnet]  = useState(() =>
    typeof window !== 'undefined' ? (localStorage.getItem('nms_scan_subnet') ?? '192.168.1') : '192.168.1'
  )
  const [scanning,    setScanning]    = useState(false)
  const [scanLastAt,  setScanLastAt]  = useState<string | null>(null)
  const [scanError,   setScanError]   = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from('devices').select('*').order('name')
    setDevices(data ?? [])
  }, [])

  async function deleteDevice(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return
    setDeleting(id)
    await supabase.from('devices').delete().eq('id', id)
    setDeleting(null)
    load()
  }

  const doScan = useCallback(async (sub: string) => {
    setScanning(true); setScanError(null)
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subnet: sub }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Scan failed')
      setScanResults(d.results ?? [])
      setScanLastAt(d.scanned_at ?? null)
    } catch (e: unknown) {
      setScanError(e instanceof Error ? e.message : 'Scan error')
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    load()
    fetch('/api/scan').then(r => r.json()).then(d => {
      const cached: ScanResult[] = d.results ?? []
      setScanResults(cached)
      setScanLastAt(d.scanned_at ?? null)
      const age = d.scanned_at ? Date.now() - new Date(d.scanned_at).getTime() : Infinity
      if (cached.length === 0 || age > 5 * 60 * 1000) doScan(scanSubnet)
    }).catch(() => doScan(scanSubnet))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, doScan])

  useEffect(() => {
    const ch = supabase.channel('devices-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  // Build unified row list
  const managedIPs = new Set(devices.map(d => d.ip))

  // Deduplicate scan results by IP
  const scanByIp = new Map<string, ScanResult>()
  scanResults.forEach(r => { if (!scanByIp.has(r.ip)) scanByIp.set(r.ip, r) })
  // Only include discovered rows whose IP is NOT already a managed device
  const discoveredOnly = [...scanByIp.values()].filter(r => !managedIPs.has(r.ip))

  const q = search.toLowerCase()

  const rows: UnifiedRow[] = []

  // Discovered rows first
  if (sourceF !== 'managed') {
    discoveredOnly.forEach(s => {
      if (q && !s.ip.includes(q) && !(s.hostname ?? '').toLowerCase().includes(q) && !(s.mac ?? '').toLowerCase().includes(q)) return
      if (statusF !== 'all' && statusF !== 'attention') return
      rows.push({ kind: 'discovered', scan: s })
    })
  }

  // Managed rows after
  if (sourceF !== 'discovered') {
    devices.forEach(d => {
      if (q && !d.name.toLowerCase().includes(q) && !d.ip.includes(q) && !d.location.toLowerCase().includes(q)) return
      if (typeF && d.type !== typeF) return
      if (bldgF && d.location !== bldgF) return
      if (statusF === 'attention' && !needsAttention(d)) return
      if (statusF !== 'all' && statusF !== 'attention' && d.status !== statusF) return
      rows.push({ kind: 'managed', dev: d })
    })
  }

  const attentionCount = devices.filter(needsAttention).length

  return (
    <>

      {/* ── Attention banner ── */}
      {attentionCount > 0 && (
        <div style={{
          marginBottom: 12, padding: '8px 14px', borderRadius: 'var(--r)',
          background: 'rgba(248,81,73,.08)', border: '1px solid rgba(248,81,73,.25)',
          fontSize: 13, color: 'var(--crit)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8,
        }} onClick={() => setStatusF('attention')}>
          ⚠ {attentionCount} device{attentionCount > 1 ? 's' : ''} require attention
          <span style={{ fontSize: 11, opacity: .7 }}>(offline or high CPU/MEM) — click to filter</span>
        </div>
      )}

      {/* ── Filters ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <input suppressHydrationWarning className="form-input" style={{ width: 200 }} placeholder="Search devices…"
          value={search} onChange={e => setSearch(e.target.value)} />
        <select suppressHydrationWarning className="form-select" style={{ width: 150 }} value={typeF} onChange={e => setTypeF(e.target.value)}>
          <option value="">All types</option>
          {['Router','Switch','Access Point','Server','Firewall'].map(t => <option key={t}>{t}</option>)}
        </select>
        <select suppressHydrationWarning className="form-select" style={{ width: 150 }} value={bldgF} onChange={e => setBldgF(e.target.value)}>
          <option value="">All buildings</option>
          {['Building A','Building B','Building C','Data Center'].map(b => <option key={b}>{b}</option>)}
        </select>
        <select suppressHydrationWarning className="form-select" style={{ width: 160 }} value={statusF}
          onChange={e => setStatusF(e.target.value as StatusFilter)}>
          <option value="all">All statuses</option>
          <option value="up">Online</option>
          <option value="warn">Warning</option>
          <option value="down">Offline</option>
          <option value="maint">Maintenance</option>
          <option value="attention">⚠ Needs Attention</option>
        </select>
        <select suppressHydrationWarning className="form-select" style={{ width: 150 }} value={sourceF}
          onChange={e => setSourceF(e.target.value as SourceFilter)}>
          <option value="all">All sources</option>
          <option value="managed">Managed only</option>
          <option value="discovered">Discovered only</option>
        </select>

        {/* Scan + Check Now controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          {scanning && <span style={{ fontSize: 12, color: 'var(--info)' }}>⏳ Scanning…</span>}
          {scanError && <span style={{ fontSize: 12, color: 'var(--crit)' }}>{scanError}</span>}
          <input suppressHydrationWarning className="form-input" style={{ width: 110, fontSize: 12 }}
            value={scanSubnet}
            onChange={e => { setScanSubnet(e.target.value); localStorage.setItem('nms_scan_subnet', e.target.value) }}
            placeholder="192.168.1" disabled={scanning} />
          <button suppressHydrationWarning className="btn btn-sm btn-primary" onClick={() => doScan(scanSubnet)} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
          <CheckNowButton onDone={load} />
        </div>
      </div>

      {/* ── Unified device table ── */}
      <div className="card">
        <div className="card-header">
          All Devices
          <span style={{ marginLeft: 8, color: 'var(--text3)', fontWeight: 400, fontSize: 12 }}>
            {devices.length} managed · {discoveredOnly.length} discovered
            {scanLastAt ? ` · scanned ${new Date(scanLastAt).toLocaleTimeString()}` : ''}
          </span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Device Name</th>
                <th>Type</th>
                <th>IP Address</th>
                <th>Location</th>
                <th>Status</th>
                <th>Uptime</th>
                <th>CPU %</th>
                <th>Memory %</th>
                <th>Source</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                if (row.kind === 'managed') {
                  const d = row.dev
                  return (
                    <tr key={d.id} style={needsAttention(d) ? { background: 'rgba(248,81,73,.04)' } : {}}>
                      <td>
                        <strong>{d.name}</strong>
                        {needsAttention(d) && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--crit)' }}>⚠</span>}
                      </td>
                      <td><span className="tag">{d.type}</span></td>
                      <td className="mono">{d.ip}</td>
                      <td>{d.location}</td>
                      <td>{statusChip(d.status)}</td>
                      <td className="mono" style={{ fontSize: 12 }}>{d.uptime}</td>
                      <td style={{ color: cpuColor(d.cpu), fontWeight: 500 }}>{d.cpu ? `${d.cpu}%` : '—'}</td>
                      <td style={{ color: d.mem >= 85 ? 'var(--warn)' : 'var(--text2)' }}>{d.mem ? `${d.mem}%` : '—'}</td>
                      <td><span className="chip chip-ok" style={{ fontSize: 10 }}>Managed</span></td>
                      <td>
                        <div className="tbl-actions">
                          <button className="btn btn-sm" onClick={() => setDetail(d)}>Details</button>
                          <button className="btn btn-sm" onClick={() => setEditing(d)}>Edit</button>
                          <button
                            className="btn btn-sm"
                            style={{ color: 'var(--crit)', borderColor: 'rgba(248,81,73,.3)' }}
                            disabled={deleting === d.id}
                            onClick={() => deleteDevice(d.id, d.name)}>
                            {deleting === d.id ? '…' : 'Delete'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                }

                // discovered row
                const s = row.scan
                const methodChip = s.scan_type === 'both'
                  ? <span className="chip chip-ok" style={{ fontSize: 10 }}>ICMP+ARP</span>
                  : s.scan_type === 'icmp'
                    ? <span className="chip chip-warn" style={{ fontSize: 10 }}>ICMP</span>
                    : <span className="chip chip-info" style={{ fontSize: 10 }}>ARP</span>
                return (
                  <tr key={s.id ?? `scan-${i}`} style={{ background: 'rgba(47,129,247,.04)' }}>
                    <td style={{ color: 'var(--text2)' }}>
                      {s.hostname
                        ? <><strong>{s.hostname}</strong></>
                        : <span style={{ color: 'var(--text3)', fontStyle: 'italic' }}>Unknown host</span>}
                    </td>
                    <td>{methodChip}</td>
                    <td className="mono">{s.ip}</td>
                    <td style={{ color: 'var(--text3)' }}>—</td>
                    <td>
                      <span className={`chip chip-${s.responded ? 'ok' : 'off'}`} style={{ fontSize: 10 }}>
                        {s.responded ? 'Responding' : 'No Response'}
                      </span>
                    </td>
                    <td style={{ color: 'var(--text3)' }}>—</td>
                    <td style={{ color: 'var(--text3)' }}>—</td>
                    <td style={{ color: 'var(--text3)', fontSize: 11 }}>{s.mac ?? '—'}</td>
                    <td><span className="chip chip-info" style={{ fontSize: 10 }}>Discovered</span></td>
                    <td>
                      <div className="tbl-actions">
                        <button className="btn btn-sm btn-primary" onClick={() => setAddingScan(s)}>
                          + Add
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'center', padding: 32, color: 'var(--text3)' }}>
                    {scanning ? '⏳ Scanning network…' : 'No devices found.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Detail modal ── */}
      {detail && (
        <Modal title={`Device: ${detail.name}`} onClose={() => setDetail(null)}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
            {[
              ['Type',      detail.type],
              ['IP',        detail.ip],
              ['Location',  detail.location],
              ['Status',    detail.status],
              ['Uptime',    detail.uptime],
              ['CPU / Mem', detail.cpu ? `${detail.cpu}% / ${detail.mem}%` : '—'],
            ].map(([k, v]) => (
              <div key={k}>
                <div className="form-label">{k}</div>
                <div className="mono">{v}</div>
              </div>
            ))}
          </div>
          {needsAttention(detail) && (
            <div style={{ background: 'rgba(248,81,73,.08)', border: '1px solid rgba(248,81,73,.2)', borderRadius: 'var(--r)', padding: '8px 12px', marginBottom: 12, fontSize: 13, color: 'var(--crit)' }}>
              ⚠ This device requires attention.
              {detail.status === 'down' && ' Device is offline — check cable and power.'}
              {detail.status !== 'down' && detail.cpu >= 90 && ` CPU at ${detail.cpu}% — consider rebooting during maintenance.`}
              {detail.status !== 'down' && detail.mem >= 90 && ` Memory at ${detail.mem}% — check for memory leaks or high load.`}
            </div>
          )}
          <button className="btn btn-sm" onClick={() => { setDetail(null); setEditing(detail) }} style={{ marginTop: 4 }}>
            Edit Device
          </button>
        </Modal>
      )}

      {/* ── Edit modal ── */}
      {editing && (
        <EditDeviceModal device={editing} onClose={() => setEditing(null)} onSaved={load} />
      )}

      {/* ── Add discovered device modal ── */}
      {addingScan && (
        <AddDiscoveredModal scan={addingScan} onClose={() => setAddingScan(null)} onSaved={load} />
      )}
    </>
  )
}
