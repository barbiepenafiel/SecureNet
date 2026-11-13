'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import Modal from '@/components/Modal'
import { useAuth } from '@/components/AuthProvider'
import type { AgentStatus, Device, ScanResult } from '@/lib/database.types'

type SourceFilter = 'all' | 'managed' | 'discovered'
type StatusFilter = 'all' | 'up' | 'warn' | 'down' | 'maint' | 'unreachable' | 'unknown' | 'attention'

const AGENT_FRESH_MS = 60_000   // agent counts as reporting if it checked in within this window

// Detection history: which devices were seen by the agent in a period
type Period = 'today' | '7d' | '30d' | 'all'
const PERIODS: [Period, string][] = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All time']]
const PERIOD_WHEN: Record<Period, string> = {
  today: 'today', '7d': 'in the last 7 days', '30d': 'in the last 30 days', all: '',
}
const PERIOD_TEXT: Record<Period, string> = {
  today: 'detected today', '7d': 'detected in the last 7 days',
  '30d': 'detected in the last 30 days', all: 'in total',
}
function periodStart(p: Period): number | null {
  const now = Date.now()
  if (p === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }
  if (p === '7d')  return now - 7 * 24 * 3600_000
  if (p === '30d') return now - 30 * 24 * 3600_000
  return null
}

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
      <button suppressHydrationWarning className="btn btn-sm" onClick={checkNow} disabled={checking}
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

const STATUS_CLS:   Record<string, string> = { up: 'chip-ok', warn: 'chip-warn', down: 'chip-crit', maint: 'chip-maint', unreachable: 'chip-warn', unknown: 'chip-off' }
const STATUS_LABEL: Record<string, string> = { up: 'Online', warn: 'Warning', down: 'Offline', maint: 'Maintenance', unreachable: 'Unreachable', unknown: 'Unknown' }
const STATUS_HELP:  Record<string, string> = {
  up: 'Answered the latest check',
  unreachable: 'Missed 1–2 checks — not yet considered offline',
  down: 'No ICMP or ARP answer for 3 checks in a row',
  unknown: 'The agent can’t see this device’s network right now',
}

function statusChip(s: string, method?: string | null) {
  return (
    <span className={`chip ${STATUS_CLS[s] ?? 'chip-off'}`} title={STATUS_HELP[s]}>
      {STATUS_LABEL[s] ?? s}{s === 'up' && method ? ` · ${method}` : ''}
    </span>
  )
}

const NEW_DEVICE_MS = 10 * 60 * 1000   // "New" badge for devices first seen in the last 10 min

function ago(iso?: string | null) {
  if (!iso) return '—'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const isUnassigned = (loc?: string | null) => !loc || loc === 'Unassigned'

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
      footer={<><button suppressHydrationWarning className="btn" onClick={onClose}>Cancel</button>
        <button suppressHydrationWarning className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button></>}>
      {err && <div style={{ color: 'var(--crit)', marginBottom: 10, fontSize: 13 }}>{err}</div>}
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Name</label>
          <input suppressHydrationWarning className="form-input" value={form.name} onChange={set('name')} />
        </div>
        <div className="form-group">
          <label className="form-label">Type</label>
          <select suppressHydrationWarning className="form-select" value={form.type} onChange={set('type')}>
            {[...new Set(['Firewall','Router','Switch','Access Point','Server','Computer','Client', device.type])].map(t => <option key={t}>{t}</option>)}
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
            {[...new Set(['Unassigned','Building A','Building B','Building C','Data Center','Library','Admin Building', device.location])].map(l => (
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
          {(device.status === 'unreachable' || device.status === 'unknown') && (
            <option value={device.status}>{STATUS_LABEL[device.status]}</option>
          )}
        </select>
        {device.source === 'discovered' && (
          <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
            The agent updates this automatically. Set Maintenance to stop monitoring it.
          </div>
        )}
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
      footer={<><button suppressHydrationWarning className="btn" onClick={onClose}>Cancel</button>
        <button suppressHydrationWarning className="btn btn-primary" onClick={save} disabled={saving}>
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
  // Opening Devices from the sidebar always starts on "Today"
  const [period,      setPeriod]    = useState<Period>('today')
  const [deleting,    setDeleting]  = useState<string | null>(null)   // device id being deleted
  const [detail,      setDetail]    = useState<Device | null>(null)
  const [editing,     setEditing]   = useState<Device | null>(null)
  const [addingScan,  setAddingScan] = useState<ScanResult | null>(null)
  const { can } = useAuth()
  const canManage = can('devices.manage')

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
    // Fallback in case realtime isn't enabled for the table: reload every 5 s
    const t = setInterval(() => { if (document.visibilityState === 'visible') load() }, 5_000)
    return () => { supabase.removeChannel(ch); clearInterval(t) }
  }, [load])

  // ── Agent heartbeat: is anyone actually watching the network? ──
  const [agent, setAgent] = useState<AgentStatus | null>(null)
  const [, setTick] = useState(0)   // re-render every 5 s so "last seen" and freshness stay current
  useEffect(() => {
    const loadAgent = async () => {
      const { data } = await supabase.from('agent_status').select('*')
        .order('last_seen', { ascending: false }).limit(1)
      setAgent((data?.[0] as AgentStatus) ?? null)
    }
    loadAgent()
    const ch = supabase.channel('agent-status-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_status' }, loadAgent)
      .subscribe()
    const t = setInterval(() => { setTick(n => n + 1); loadAgent() }, 5000)
    return () => { supabase.removeChannel(ch); clearInterval(t) }
  }, [])
  const agentFresh = !!agent && Date.now() - new Date(agent.last_seen).getTime() < AGENT_FRESH_MS

  // When the agent isn't reporting, nobody can vouch for discovered devices
  const shownStatus = (d: Device) =>
    d.source === 'discovered' && !agentFresh && d.status !== 'maint' ? 'unknown' : d.status

  // Build unified row list
  const knownIPs  = new Set(devices.map(d => d.ip))
  const knownMACs = new Set(devices.map(d => d.mac?.toUpperCase()).filter(Boolean) as string[])

  // Deduplicate scan results by IP
  const scanByIp = new Map<string, ScanResult>()
  scanResults.forEach(r => { if (!scanByIp.has(r.ip)) scanByIp.set(r.ip, r) })
  // Scan hits the agent hasn't registered yet (e.g. before the discovery migration is run)
  const discoveredOnly = [...scanByIp.values()].filter(r =>
    !knownIPs.has(r.ip) && !(r.mac && knownMACs.has(r.mac.toUpperCase())))

  const q = search.toLowerCase()

  // ── Period: only devices detected (seen by the agent) in this window ──
  const since = periodStart(period)
  const seenIn = (d: Device) => since === null || (!!d.last_seen && new Date(d.last_seen).getTime() >= since)
  const periodDevices = devices.filter(seenIn)
  const hiddenCount = devices.length - periodDevices.length
  const newCount = since === null ? 0 : periodDevices.filter(d => d.first_seen && new Date(d.first_seen).getTime() >= since).length

  const rows: UnifiedRow[] = []

  // Inventory
  periodDevices.forEach(d => {
    const discovered = d.source === 'discovered'
    if (sourceF === 'managed' && discovered) return
    if (sourceF === 'discovered' && !discovered) return
    const hay = [d.name, d.ip, d.location, d.mac, d.hostname, d.vendor, d.type].filter(Boolean).join(' ').toLowerCase()
    if (q && !hay.includes(q)) return
    if (typeF && d.type !== typeF) return
    if (bldgF && (bldgF === 'Unassigned' ? !isUnassigned(d.location) : d.location !== bldgF)) return
    if (statusF === 'attention' && !needsAttention(d)) return
    if (statusF !== 'all' && statusF !== 'attention' && shownStatus(d) !== statusF) return
    rows.push({ kind: 'managed', dev: d })
  })

  // Unregistered scan hits after
  if (sourceF !== 'managed') {
    discoveredOnly.forEach(s => {
      if (q && !s.ip.includes(q) && !(s.hostname ?? '').toLowerCase().includes(q) && !(s.mac ?? '').toLowerCase().includes(q)) return
      if (statusF !== 'all' && statusF !== 'attention') return
      if (typeF || bldgF) return
      rows.push({ kind: 'discovered', scan: s })
    })
  }

  const deviceTypes = [...new Set(['Router','Switch','Access Point','Server','Firewall', ...devices.map(d => d.type)])]
  const locations   = [...new Set(['Building A','Building B','Building C','Data Center', ...devices.map(d => d.location).filter(l => !isUnassigned(l))])]
  const onlineCount = periodDevices.filter(d => shownStatus(d) === 'up' || shownStatus(d) === 'warn').length

  const attentionCount = periodDevices.filter(needsAttention).length

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
          {deviceTypes.map(t => <option key={t}>{t}</option>)}
        </select>
        <select suppressHydrationWarning className="form-select" style={{ width: 150 }} value={bldgF} onChange={e => setBldgF(e.target.value)}>
          <option value="">All locations</option>
          {locations.map(b => <option key={b}>{b}</option>)}
          <option value="Unassigned">Unassigned</option>
        </select>
        <select suppressHydrationWarning className="form-select" style={{ width: 160 }} value={statusF}
          onChange={e => setStatusF(e.target.value as StatusFilter)}>
          <option value="all">All statuses</option>
          <option value="up">Online</option>
          <option value="unreachable">Unreachable</option>
          <option value="down">Offline</option>
          <option value="unknown">Unknown</option>
          <option value="warn">Warning</option>
          <option value="maint">Maintenance</option>
          <option value="attention">⚠ Needs Attention</option>
        </select>
        <select suppressHydrationWarning className="form-select" style={{ width: 150 }} value={sourceF}
          onChange={e => setSourceF(e.target.value as SourceFilter)}>
          <option value="all">All sources</option>
          <option value="managed">Added manually</option>
          <option value="discovered">Auto-discovered</option>
        </select>

        {/* Scan + Check Now controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          {scanning && <span style={{ fontSize: 12, color: 'var(--info)' }}>⏳ Scanning…</span>}
          {scanError && <span style={{ fontSize: 12, color: 'var(--crit)' }}>{scanError}</span>}
          {canManage && <>
            <input suppressHydrationWarning className="form-input" style={{ width: 110, fontSize: 12 }}
              value={scanSubnet}
              onChange={e => { setScanSubnet(e.target.value); localStorage.setItem('nms_scan_subnet', e.target.value) }}
              placeholder="192.168.1" disabled={scanning} />
            <button suppressHydrationWarning className="btn btn-sm btn-primary" onClick={() => doScan(scanSubnet)} disabled={scanning}>
              {scanning ? 'Scanning…' : 'Scan'}
            </button>
          </>}
          <CheckNowButton onDone={load} />
        </div>
      </div>

      {/* ── Unified device table ── */}
      <div className="card">
        <div className="card-header" style={{ flexWrap: 'wrap' }}>
          Device Inventory
          <span style={{ marginLeft: 8, color: 'var(--text3)', fontWeight: 400, fontSize: 12 }}>
            {periodDevices.length} device{periodDevices.length === 1 ? '' : 's'} {PERIOD_TEXT[period]} · {onlineCount} online
            {newCount > 0 ? ` · ${newCount} new` : ''}
            {discoveredOnly.length > 0 ? ` · ${discoveredOnly.length} not yet registered` : ''}
          </span>
          {/* Period */}
          <div className="card-header-actions">
            <div style={{ display: 'flex', gap: 2, padding: 3, background: 'var(--surface3)', borderRadius: 8 }}>
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
        </div>
        {hiddenCount > 0 && (
          <div style={{ padding: '7px 16px', fontSize: 12, color: 'var(--text3)', background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
            {hiddenCount} other device{hiddenCount === 1 ? ' was' : 's were'} not detected {PERIOD_WHEN[period]}.{' '}
            <button suppressHydrationWarning onClick={() => setPeriod(period === 'today' ? '7d' : 'all')}
              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>
              {period === 'today' ? 'Show last 7 days' : 'Show all time'}
            </button>
          </div>
        )}
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Device</th>
                <th>Type</th>
                <th>IP Address</th>
                <th>MAC Address</th>
                <th>Network</th>
                <th>Location</th>
                <th>Status</th>
                <th>First Detected</th>
                <th>Last Seen</th>
                <th>Source</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                if (row.kind === 'managed') {
                  const d = row.dev
                  const status = shownStatus(d)
                  const isNew = !!d.first_seen && d.source === 'discovered' && Date.now() - new Date(d.first_seen).getTime() < NEW_DEVICE_MS
                  const sub = [d.hostname && d.hostname !== d.name ? d.hostname : null, d.vendor].filter(Boolean).join(' · ')
                  return (
                    <tr key={d.id} style={needsAttention(d) ? { background: 'rgba(248,81,73,.04)' } : {}}>
                      <td>
                        <strong>{d.name}</strong>
                        {isNew && <span className="chip chip-info" style={{ fontSize: 10, marginLeft: 6 }}>New</span>}
                        {needsAttention(d) && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--crit)' }}>⚠</span>}
                        {sub && <div style={{ fontSize: 11, color: 'var(--text3)' }}>{sub}</div>}
                      </td>
                      <td><span className="tag">{d.type}</span></td>
                      <td className="mono">{d.ip}</td>
                      <td className="mono" style={{ fontSize: 11, color: d.mac ? 'var(--text2)' : 'var(--text3)' }}>{d.mac ?? '—'}</td>
                      <td className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{d.subnet ?? '—'}</td>
                      <td>{isUnassigned(d.location)
                        ? <span style={{ color: 'var(--text3)', fontStyle: 'italic' }}>Unassigned</span>
                        : d.location}</td>
                      <td>{statusChip(status, status === 'up' ? d.last_method : null)}</td>
                      <td style={{ fontSize: 12, color: 'var(--text2)' }} title={d.first_seen ? new Date(d.first_seen).toLocaleString() : undefined}>
                        {d.first_seen ? new Date(d.first_seen).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—'}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text2)' }} title={d.last_seen ? new Date(d.last_seen).toLocaleString() : undefined}>
                        {ago(d.last_seen)}
                      </td>
                      <td>{d.source === 'discovered'
                        ? <span className="chip chip-info" style={{ fontSize: 10 }}>Auto-discovered</span>
                        : <span className="chip chip-ok" style={{ fontSize: 10 }}>Manual</span>}</td>
                      <td>
                        <div className="tbl-actions">
                          <button suppressHydrationWarning className="btn btn-sm" onClick={() => setDetail(d)}>Details</button>
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
                    <td className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{s.mac ?? '—'}</td>
                    <td style={{ color: 'var(--text3)' }}>—</td>
                    <td style={{ color: 'var(--text3)', fontStyle: 'italic' }}>Unassigned</td>
                    <td>
                      <span className={`chip chip-${s.responded ? 'ok' : 'off'}`} style={{ fontSize: 10 }}>
                        {s.responded ? 'Responding' : 'ARP only'}
                      </span>
                    </td>
                    <td style={{ color: 'var(--text3)' }}>—</td>
                    <td style={{ fontSize: 12, color: 'var(--text2)' }}>{ago(s.scanned_at)}</td>
                    <td><span className="chip chip-off" style={{ fontSize: 10 }} title="Seen by the scanner but not yet in the inventory">Not registered</span></td>
                    <td>
                      <div className="tbl-actions">
                        {canManage
                          ? <button suppressHydrationWarning className="btn btn-sm btn-primary" onClick={() => setAddingScan(s)}>+ Add</button>
                          : <span style={{ color: 'var(--text3)' }}>—</span>}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={11} style={{ textAlign: 'center', padding: 32, color: 'var(--text3)' }}>
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
          <div className="form-row" style={{ marginBottom: 16 }}>
            {[
              ['Type',      detail.type],
              ['IP',        detail.ip],
              ['MAC',       detail.mac ?? '—'],
              ['Vendor',    detail.vendor ?? '—'],
              ['Hostname',  detail.hostname ?? '—'],
              ['Network',   detail.subnet ?? '—'],
              ['Location',  isUnassigned(detail.location) ? 'Unassigned' : detail.location],
              ['Status',    `${STATUS_LABEL[shownStatus(detail)] ?? detail.status}${detail.last_method ? ` (last via ${detail.last_method})` : ''}`],
              ['First detected', detail.first_seen ? new Date(detail.first_seen).toLocaleString() : '—'],
              ['Last seen', detail.last_seen ? new Date(detail.last_seen).toLocaleString() : '—'],
              ['Source',    detail.source === 'discovered' ? 'Auto-discovered' : 'Added manually'],
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
          {canManage && (
            <button suppressHydrationWarning className="btn btn-sm" onClick={() => { setDetail(null); setEditing(detail) }} style={{ marginTop: 4 }}>
              Edit Device
            </button>
          )}
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
