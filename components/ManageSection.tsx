'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { Device } from '@/lib/database.types'
import {
  useFloorRooms, roomOfDevice, stripRoomLabels, FLOOR_VIEWBOX, FLOORPLAN_BUILDING, type FloorRoom,
} from '@/lib/floor-rooms'
import { FLOOR_1_SVG, FLOOR_2_SVG, RoomLabel } from '@/components/TopologyHub'

// Settings → Manage: device details and floor plan rooms (Network Admins only)

const STATUS: Record<string, { label: string; cls: string }> = {
  up: { label: 'Online', cls: 'chip-ok' }, warn: { label: 'Warning', cls: 'chip-warn' },
  unreachable: { label: 'Unreachable', cls: 'chip-warn' }, down: { label: 'Offline', cls: 'chip-crit' },
  unknown: { label: 'Unknown', cls: 'chip-off' }, maint: { label: 'Maintenance', cls: 'chip-maint' },
}
const TYPES = ['Router', 'Switch', 'Access Point', 'Firewall', 'Server', 'Computer', 'Client']
const BUILDINGS = ['Building A', 'Building B', 'Building C', 'Data Center', 'Library', 'Admin Building']

export default function ManageSection() {
  const [part, setPart] = useState<'devices' | 'lifecycle' | 'rooms'>('devices')
  const { rooms, managed, reload } = useFloorRooms()

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 2, padding: 3, background: 'var(--surface3)', borderRadius: 8 }}>
          {([['devices', 'Devices'], ['lifecycle', 'Lifecycle'], ['rooms', 'Floor plan rooms']] as const).map(([k, l]) => (
            <button suppressHydrationWarning key={k} onClick={() => setPart(k)} style={{
              padding: '6px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none',
              background: part === k ? 'var(--surface)' : 'transparent', color: part === k ? 'var(--accent2)' : 'var(--text2)',
              boxShadow: part === k ? '0 1px 3px rgba(15,23,42,.12)' : 'none',
            }}>{l}</button>
          ))}
        </div>
        {!managed && (
          <span style={{ fontSize: 12, color: 'var(--warn)' }}>
            Rooms are read-only until you run <span className="mono">supabase/migration_floor_rooms.sql</span> in Supabase.
          </span>
        )}
      </div>
      {part === 'devices'   && <DevicesManager rooms={rooms} roomsManaged={managed}/>}
      {part === 'lifecycle' && <LifecycleManager/>}
      {part === 'rooms'     && <RoomsManager rooms={rooms} managed={managed} reload={reload}/>}
    </div>
  )
}

// ─── Devices ──────────────────────────────────────────────────────────────────

// parent: '' = learned automatically by the agent, otherwise a device id (set by hand)
type Draft = { name: string; type: string; location: string; room_id: string; maint: boolean; parent: string }

function DevicesManager({ rooms, roomsManaged }: { rooms: FloorRoom[]; roomsManaged: boolean }) {
  const [devices, setDevices] = useState<Device[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null)
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    const { data } = await supabase.from('devices').select('*').order('name')
    setDevices((data ?? []) as Device[])
  }, [])
  useEffect(() => { load() }, [load])

  const draftOf = (d: Device): Draft => drafts[d.id] ?? {
    name: d.name, type: d.type, location: d.location || 'Unassigned',
    room_id: d.room_id ?? '', maint: d.status === 'maint',
    parent: d.parent_source === 'manual' ? d.parent_id ?? '' : '',
  }
  const edit = (d: Device, patch: Partial<Draft>) => setDrafts(p => ({ ...p, [d.id]: { ...draftOf(d), ...patch } }))
  const dirty = (d: Device) => {
    const x = drafts[d.id]
    return !!x && (x.name !== d.name || x.type !== d.type || x.location !== (d.location || 'Unassigned')
      || x.room_id !== (d.room_id ?? '') || x.maint !== (d.status === 'maint')
      || x.parent !== (d.parent_source === 'manual' ? d.parent_id ?? '' : ''))
  }

  async function save(d: Device) {
    const x = draftOf(d)
    if (!x.name.trim()) { setMsg({ id: d.id, text: 'Name is required', ok: false }); return }
    setBusy(d.id); setMsg(null)
    const patch: Record<string, unknown> = { name: x.name.trim(), type: x.type, location: x.location }
    // Room only applies inside the floor-plan building
    if (roomsManaged) patch.room_id = FLOORPLAN_BUILDING.test(x.location) && x.room_id ? x.room_id : null
    if (x.maint !== (d.status === 'maint')) patch.status = x.maint ? 'maint' : 'unknown'   // the agent re-checks it
    // Topology link: a device chosen by hand is kept; Automatic hands it back to the agent
    if (linksManaged && x.parent !== (d.parent_source === 'manual' ? d.parent_id ?? '' : '')) {
      Object.assign(patch, x.parent
        ? { parent_id: x.parent, parent_port: null, parent_source: 'manual', parent_updated_at: new Date().toISOString() }
        : { parent_id: null, parent_port: null, parent_source: null, parent_updated_at: new Date().toISOString() })
    }
    const { error } = await supabase.from('devices').update(patch).eq('id', d.id)
    setBusy(null)
    if (error) {
      setMsg({ id: d.id, ok: false, text: /duplicate|unique/i.test(error.message) ? 'Another device already has that name' : error.message })
      return
    }
    // Lifecycle details are stored by device name — keep them attached after a rename
    if (patch.name !== d.name) {
      await supabase.from('lifecycle').update({ device_name: patch.name }).ilike('device_name', d.name).then(() => {}, () => {})
    }
    setDrafts(p => { const n = { ...p }; delete n[d.id]; return n })
    setMsg({ id: d.id, text: 'Saved', ok: true })
    setTimeout(() => setMsg(m => (m?.id === d.id ? null : m)), 2500)
    load()
  }

  async function remove(d: Device) {
    if (!confirm(`Delete "${d.name}"? Auto-discovered devices are added again if the agent still sees them.`)) return
    setBusy(d.id)
    await supabase.from('devices').delete().eq('id', d.id)
    setBusy(null)
    load()
  }

  const locations = useMemo(() =>
    [...new Set(['Unassigned', ...BUILDINGS, ...devices.map(d => d.location).filter(Boolean)])], [devices])
  const shown = devices.filter(d => !q || [d.name, d.ip, d.mac, d.location, d.type].filter(Boolean).join(' ').toLowerCase().includes(q.toLowerCase()))
  const roomName = (d: Device) => roomOfDevice(d, rooms)?.label
  // parent_* columns installed (supabase/migration_objectives.sql)?
  const linksManaged = devices.length > 0 && 'parent_id' in devices[0]
  const byId = useMemo(() => new Map(devices.map(d => [d.id, d])), [devices])
  // Devices below this one can't be chosen as what it connects to (no loops)
  const descendants = (id: string) => {
    const out = new Set<string>([id])
    let grew = true
    while (grew) { grew = false; for (const d of devices) if (d.parent_id && out.has(d.parent_id) && !out.has(d.id)) { out.add(d.id); grew = true } }
    return out
  }
  const SOURCE_LABEL: Record<string, string> = { snmp: 'router table', gateway: 'same network as gateway' }

  return (
    <div className="card">
      <div className="card-header">
        Device details
        <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>Name, type, building, room and monitoring</span>
        <div className="card-header-actions">
          <input suppressHydrationWarning className="form-input" style={{ width: 220 }} placeholder="Search name, IP, MAC…" value={q} onChange={e => setQ(e.target.value)}/>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl">
          <thead>
            <tr><th>Name</th><th>Type</th><th>Building</th><th>Room</th><th>Connected to</th><th>IP / MAC</th><th>Status</th><th>Monitoring</th><th></th></tr>
          </thead>
          <tbody>
            {shown.map(d => {
              const x = draftOf(d)
              const inPlanBuilding = FLOORPLAN_BUILDING.test(x.location)
              const st = STATUS[d.status] ?? STATUS.unknown
              const autoRoom = !d.room_id && roomName(d)
              return (
                <tr key={d.id} style={dirty(d) ? { background: 'rgba(22,163,74,.05)' } : undefined}>
                  <td style={{ minWidth: 180 }}>
                    <input suppressHydrationWarning className="form-input" value={x.name} onChange={e => edit(d, { name: e.target.value })}/>
                    {d.source === 'discovered' && <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 2 }}>Auto-discovered</div>}
                  </td>
                  <td style={{ minWidth: 130 }}>
                    <select suppressHydrationWarning className="form-select" value={x.type} onChange={e => edit(d, { type: e.target.value })}>
                      {[...new Set([...TYPES, d.type])].map(t => <option key={t}>{t}</option>)}
                    </select>
                  </td>
                  <td style={{ minWidth: 140 }}>
                    <select suppressHydrationWarning className="form-select" value={x.location} onChange={e => edit(d, { location: e.target.value })}>
                      {locations.map(l => <option key={l}>{l}</option>)}
                    </select>
                  </td>
                  <td style={{ minWidth: 170 }}>
                    <select suppressHydrationWarning className="form-select" value={inPlanBuilding ? x.room_id : ''}
                      disabled={!inPlanBuilding || !roomsManaged} onChange={e => edit(d, { room_id: e.target.value })}
                      title={!inPlanBuilding ? 'Rooms are available for the building with a floor plan' : undefined}>
                      <option value="">{inPlanBuilding ? '— No room —' : '—'}</option>
                      {[1, 2].map(f => (
                        <optgroup key={f} label={f === 1 ? '1st Floor' : '2nd Floor'}>
                          {rooms.filter(r => r.floor === f).map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                        </optgroup>
                      ))}
                    </select>
                    {autoRoom && inPlanBuilding && (
                      <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 2 }}>Placed in {autoRoom} by its name</div>
                    )}
                  </td>
                  <td style={{ minWidth: 170 }}>
                    {(() => {
                      const auto = d.parent_source && d.parent_source !== 'manual' && d.parent_id ? byId.get(d.parent_id) : null
                      const blocked = descendants(d.id)
                      return (<>
                        <select suppressHydrationWarning className="form-select" value={x.parent} disabled={!linksManaged}
                          title={!linksManaged ? 'Run supabase/migration_objectives.sql to store topology links' : undefined}
                          onChange={e => edit(d, { parent: e.target.value })}>
                          <option value="">Automatic{auto ? ' — ' + auto.name : ''}</option>
                          {devices.filter(p => !blocked.has(p.id)).map(p => <option key={p.id} value={p.id}>{p.name} ({p.ip})</option>)}
                        </select>
                        {auto && !x.parent && (
                          <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 2 }}>
                            {d.parent_port ? 'Port ' + d.parent_port + ' · ' : ''}from {SOURCE_LABEL[d.parent_source!] ?? d.parent_source}
                          </div>
                        )}
                      </>)
                    })()}
                  </td>
                  <td className="mono" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                    {d.ip}<div style={{ color: 'var(--text3)' }}>{d.mac ?? '—'}</div>
                  </td>
                  <td><span className={`chip ${st.cls}`} style={{ fontSize: 11 }}>{st.label}</span></td>
                  <td>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer' }}
                      title="Maintenance pauses monitoring and alerts for this device">
                      <input suppressHydrationWarning type="checkbox" checked={x.maint} onChange={e => edit(d, { maint: e.target.checked })}/>
                      Maintenance
                    </label>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button suppressHydrationWarning className="btn btn-sm btn-primary" disabled={!dirty(d) || busy === d.id} onClick={() => save(d)}>
                      {busy === d.id ? 'Saving…' : 'Save'}
                    </button>{' '}
                    <button suppressHydrationWarning className="btn btn-sm" style={{ color: 'var(--crit)' }} disabled={busy === d.id} onClick={() => remove(d)}>Delete</button>
                    {msg?.id === d.id && <div style={{ fontSize: 11, marginTop: 3, color: msg.ok ? 'var(--ok)' : 'var(--crit)' }}>{msg.text}</div>}
                  </td>
                </tr>
              )
            })}
            {!shown.length && <tr><td colSpan={9} style={{ textAlign: 'center', padding: 24, color: 'var(--text3)' }}>No devices found.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Lifecycle (model, firmware, warranty, end of maintenance / life) ────────

type LcRow = {
  id?: string; device_name: string; model: string; firmware: string; latest_fw: string
  warranty_date: string | null; eom_date: string | null; eol_date: string | null
}
type LcDraft = { model: string; firmware: string; latest_fw: string; warranty_date: string; eom_date: string; eol_date: string }

function LifecycleManager() {
  const [devices, setDevices] = useState<Device[]>([])
  const [records, setRecords] = useState<LcRow[]>([])
  const [drafts, setDrafts]   = useState<Record<string, LcDraft>>({})
  const [busy, setBusy]       = useState<string | null>(null)
  const [msg, setMsg]         = useState<{ key: string; text: string; ok: boolean } | null>(null)
  const [q, setQ]             = useState('')

  const load = useCallback(async () => {
    const [{ data: devs }, { data: lc }] = await Promise.all([
      supabase.from('devices').select('*').order('name'),
      supabase.from('lifecycle').select('*'),
    ])
    setDevices((devs ?? []) as Device[])
    setRecords((lc ?? []) as LcRow[])
  }, [])
  useEffect(() => { load() }, [load])

  // Same matching as the Lifecycle page: by device name, ignoring case
  const recOf = (d: Device) => records.find(r => r.device_name.toLowerCase() === d.name.toLowerCase())
  const orphans = records.filter(r => !devices.some(d => d.name.toLowerCase() === r.device_name.toLowerCase()))

  const base = (d: Device): LcDraft => {
    const r = recOf(d)
    return {
      model: r?.model ?? d.model ?? '', firmware: r?.firmware ?? d.firmware ?? '', latest_fw: r?.latest_fw ?? '',
      warranty_date: r?.warranty_date ?? '', eom_date: r?.eom_date ?? '', eol_date: r?.eol_date ?? '',
    }
  }
  const draftOf = (d: Device) => drafts[d.id] ?? base(d)
  const edit = (d: Device, patch: Partial<LcDraft>) => setDrafts(p => ({ ...p, [d.id]: { ...draftOf(d), ...patch } }))
  const dirty = (d: Device) => {
    const x = drafts[d.id], b = base(d)
    return !!x && (Object.keys(b) as (keyof LcDraft)[]).some(k => x[k] !== b[k])
  }

  async function save(d: Device) {
    const x = draftOf(d)
    setBusy(d.id); setMsg(null)
    const row = {
      device_name: recOf(d)?.device_name ?? d.name,
      model: x.model.trim(), firmware: x.firmware.trim(), latest_fw: x.latest_fw.trim(),
      warranty_date: x.warranty_date || null, eom_date: x.eom_date || null, eol_date: x.eol_date || null,
    }
    const { error } = await supabase.from('lifecycle').upsert(row, { onConflict: 'device_name' })
    setBusy(null)
    if (error) { setMsg({ key: d.id, text: error.message, ok: false }); return }
    setDrafts(p => { const n = { ...p }; delete n[d.id]; return n })
    setMsg({ key: d.id, text: 'Saved', ok: true })
    setTimeout(() => setMsg(m => (m?.key === d.id ? null : m)), 2500)
    load()
  }

  async function clear(d: Device) {
    const r = recOf(d)
    if (!r || !confirm(`Clear lifecycle details for "${d.name}"?`)) return
    setBusy(d.id)
    await supabase.from('lifecycle').delete().eq('device_name', r.device_name)
    setBusy(null)
    setDrafts(p => { const n = { ...p }; delete n[d.id]; return n })
    load()
  }

  async function removeOrphan(r: LcRow) {
    await supabase.from('lifecycle').delete().eq('device_name', r.device_name)
    load()
  }
  async function removeAllOrphans() {
    if (!confirm(`Remove ${orphans.length} lifecycle record(s) for devices that aren't in the inventory?`)) return
    await supabase.from('lifecycle').delete().in('device_name', orphans.map(r => r.device_name))
    load()
  }

  const fwState = (x: LcDraft) => !x.firmware || !x.latest_fw ? null
    : x.firmware === x.latest_fw ? { text: 'Up to date', color: 'var(--ok)' } : { text: 'Update available', color: 'var(--warn)' }
  const dateState = (iso: string) => {
    if (!iso) return null
    const days = (new Date(iso).getTime() - Date.now()) / 86_400_000
    return days < 0 ? { text: 'Passed', color: 'var(--crit)' } : days < 90 ? { text: `${Math.ceil(days)} days left`, color: 'var(--warn)' } : null
  }

  const shown = devices.filter(d => !q || [d.name, d.ip, d.type, draftOf(d).model].join(' ').toLowerCase().includes(q.toLowerCase()))
  const inp = { padding: '6px 8px', fontSize: 12.5 } as const

  return (
    <>
      <div className="card">
        <div className="card-header">
          Lifecycle
          <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>Model, firmware, warranty and end-of-life dates — shown on the Lifecycle page</span>
          <div className="card-header-actions">
            <input suppressHydrationWarning className="form-input" style={{ width: 200 }} placeholder="Search devices…" value={q} onChange={e => setQ(e.target.value)}/>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr><th>Device</th><th>Model</th><th>Current FW</th><th>Latest FW</th><th>Warranty Expiry</th><th>End of Maint.</th><th>End of Life</th><th></th></tr>
            </thead>
            <tbody>
              {shown.map(d => {
                const x = draftOf(d)
                const fw = fwState(x)
                const hasRec = !!recOf(d)
                return (
                  <tr key={d.id} style={dirty(d) ? { background: 'rgba(22,163,74,.05)' } : undefined}>
                    <td style={{ minWidth: 160 }}>
                      <strong style={{ fontSize: 13 }}>{d.name}</strong>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{d.ip} · {d.type}</div>
                    </td>
                    <td style={{ minWidth: 160 }}>
                      <input suppressHydrationWarning className="form-input" style={inp} placeholder="e.g. TP-Link Archer C6" value={x.model} onChange={e => edit(d, { model: e.target.value })}/>
                    </td>
                    <td style={{ minWidth: 110 }}>
                      <input suppressHydrationWarning className="form-input mono" style={inp} placeholder="1.0.4" value={x.firmware} onChange={e => edit(d, { firmware: e.target.value })}/>
                    </td>
                    <td style={{ minWidth: 110 }}>
                      <input suppressHydrationWarning className="form-input mono" style={inp} placeholder="1.0.5" value={x.latest_fw} onChange={e => edit(d, { latest_fw: e.target.value })}/>
                      {fw && <div style={{ fontSize: 10.5, color: fw.color, marginTop: 2 }}>{fw.text}</div>}
                    </td>
                    {(['warranty_date', 'eom_date', 'eol_date'] as const).map(k => {
                      const ds = dateState(x[k])
                      return (
                        <td key={k} style={{ minWidth: 140 }}>
                          <input suppressHydrationWarning type="date" className="form-input" style={inp} value={x[k] ?? ''} onChange={e => edit(d, { [k]: e.target.value } as Partial<LcDraft>)}/>
                          {ds && <div style={{ fontSize: 10.5, color: ds.color, marginTop: 2 }}>{ds.text}</div>}
                        </td>
                      )
                    })}
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button suppressHydrationWarning className="btn btn-sm btn-primary" disabled={!dirty(d) || busy === d.id} onClick={() => save(d)}>
                        {busy === d.id ? 'Saving…' : 'Save'}
                      </button>{' '}
                      <button suppressHydrationWarning className="btn btn-sm" disabled={!hasRec || busy === d.id} onClick={() => clear(d)} title="Remove this device's lifecycle details">Clear</button>
                      {msg?.key === d.id && <div style={{ fontSize: 11, marginTop: 3, color: msg.ok ? 'var(--ok)' : 'var(--crit)' }}>{msg.text}</div>}
                    </td>
                  </tr>
                )
              })}
              {!shown.length && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--text3)' }}>No devices found.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {orphans.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-header">
            Records for devices not in the inventory
            <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>Old or sample entries — no matching device</span>
            <div className="card-header-actions">
              <button suppressHydrationWarning className="btn btn-sm" style={{ color: 'var(--crit)' }} onClick={removeAllOrphans}>Remove all</button>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Device name</th><th>Model</th><th>Current FW</th><th>Latest FW</th><th>Warranty Expiry</th><th>End of Maint.</th><th>End of Life</th><th></th></tr></thead>
              <tbody>
                {orphans.map(r => (
                  <tr key={r.device_name}>
                    <td><strong>{r.device_name}</strong></td>
                    <td>{r.model || '—'}</td>
                    <td className="mono">{r.firmware || '—'}</td>
                    <td className="mono">{r.latest_fw || '—'}</td>
                    <td>{r.warranty_date ?? '—'}</td>
                    <td>{r.eom_date ?? '—'}</td>
                    <td>{r.eol_date ?? '—'}</td>
                    <td><button suppressHydrationWarning className="btn btn-sm" style={{ color: 'var(--crit)' }} onClick={() => removeOrphan(r)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}

// ─── Floor plan rooms ─────────────────────────────────────────────────────────

function RoomsManager({ rooms, managed, reload }: { rooms: FloorRoom[]; managed: boolean; reload: () => void }) {
  const [floor, setFloor] = useState<1 | 2>(1)
  const [placing, setPlacing] = useState<string | null>(null)   // room id waiting for a click on the plan
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [devices, setDevices] = useState<Device[]>([])
  const [err, setErr] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => { supabase.from('devices').select('*').then(({ data }) => setDevices((data ?? []) as Device[])) }, [rooms])

  const [vbW, vbH] = FLOOR_VIEWBOX[floor]
  const plan = useMemo(() => stripRoomLabels(floor === 1 ? FLOOR_1_SVG : FLOOR_2_SVG), [floor])
  const floorRooms = rooms.filter(r => r.floor === floor)
  const deviceCount = (r: FloorRoom) => devices.filter(d => FLOORPLAN_BUILDING.test(d.location) && roomOfDevice(d, rooms)?.id === r.id).length

  async function update(r: FloorRoom, patch: Partial<FloorRoom>) {
    setErr(null)
    const { error } = await supabase.from('floor_rooms').update(patch).eq('id', r.id)
    if (error) setErr(error.message); else reload()
  }

  async function addRoom() {
    setErr(null)
    const { data, error } = await supabase.from('floor_rooms')
      .insert({ floor, label: 'New room', x: Math.round(vbW / 2), y: Math.round(vbH / 2) }).select('id').single()
    if (error) { setErr(error.message); return }
    reload()
    setPlacing(data.id)
  }

  async function removeRoom(r: FloorRoom) {
    const n = deviceCount(r)
    if (!confirm(`Delete room "${r.label}"?${n ? ` ${n} device(s) in it will become "not in a room".` : ''}`)) return
    const { error } = await supabase.from('floor_rooms').delete().eq('id', r.id)
    if (error) setErr(error.message); else reload()
  }

  // Click on the plan → move the selected room's name there
  function onPlanClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!placing || !svgRef.current) return
    const pt = svgRef.current.createSVGPoint()
    pt.x = e.clientX; pt.y = e.clientY
    const p = pt.matrixTransform(svgRef.current.getScreenCTM()!.inverse())
    const r = rooms.find(x => x.id === placing)
    setPlacing(null)
    if (r) update(r, { x: Math.round(p.x), y: Math.round(p.y) })
  }

  const saveLabel = (r: FloorRoom) => {
    const v = (labels[r.id] ?? r.label).trim()
    if (v && v !== r.label) update(r, { label: v })
    setLabels(p => { const n = { ...p }; delete n[r.id]; return n })
  }

  return (
    <div className="card">
      <div className="card-header">
        Floor plan rooms
        <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>IC Building</span>
        <div className="card-header-actions">
          <div style={{ display: 'flex', gap: 2, padding: 3, background: 'var(--surface3)', borderRadius: 8 }}>
            {([1, 2] as const).map(f => (
              <button suppressHydrationWarning key={f} onClick={() => { setFloor(f); setPlacing(null) }} style={{
                padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
                background: floor === f ? 'var(--surface)' : 'transparent', color: floor === f ? 'var(--accent2)' : 'var(--text2)',
              }}>{f === 1 ? '1st' : '2nd'} Floor</button>
            ))}
          </div>
          <button suppressHydrationWarning className="btn btn-sm btn-primary" disabled={!managed} onClick={addRoom}>+ Add room</button>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        {/* Plan */}
        <div style={{ flex: '1 1 520px', minWidth: 0, padding: 14, background: 'var(--surface2)' }}>
          <div style={{ fontSize: 12, marginBottom: 8, color: placing ? 'var(--accent2)' : 'var(--text3)', fontWeight: placing ? 600 : 400 }}>
            {placing
              ? `Click on the plan to place “${rooms.find(r => r.id === placing)?.label}” — or press Cancel`
              : 'Use “Place” next to a room, then click on the plan to move its name there.'}
            {placing && <button suppressHydrationWarning className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => setPlacing(null)}>Cancel</button>}
          </div>
          <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', background: '#fff', aspectRatio: `${vbW} / ${vbH}` }}>
            <div dangerouslySetInnerHTML={{ __html: plan.replace(/<svg /, '<svg style="width:100%;height:100%;display:block" ') }} style={{ lineHeight: 0, width: '100%', height: '100%' }}/>
            <svg ref={svgRef} viewBox={`0 0 ${vbW} ${vbH}`} onClick={onPlanClick}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: placing ? 'crosshair' : 'default' }}>
              {floorRooms.map(r => (
                <g key={r.id}>
                  {placing === r.id && <circle cx={r.x} cy={r.y} r="26" fill="rgba(22,163,74,.15)" stroke="var(--accent)" strokeDasharray="4 3"/>}
                  <RoomLabel room={{ ...r, label: labels[r.id] ?? r.label }} color={placing === r.id ? '#15803d' : '#111'}/>
                </g>
              ))}
            </svg>
          </div>
        </div>

        {/* Room list */}
        <div style={{ flex: '0 0 340px', maxWidth: '100%', borderLeft: '1px solid var(--border)', padding: '10px 0' }}>
          {err && <div style={{ color: 'var(--crit)', fontSize: 12, padding: '0 14px 8px' }}>{err}</div>}
          {floorRooms.map(r => (
            <div key={r.id} style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', background: placing === r.id ? 'rgba(22,163,74,.06)' : undefined }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input suppressHydrationWarning className="form-input" value={labels[r.id] ?? r.label} disabled={!managed}
                  onChange={e => setLabels(p => ({ ...p, [r.id]: e.target.value }))}
                  onBlur={() => saveLabel(r)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}/>
                <button suppressHydrationWarning className="btn btn-sm" disabled={!managed} onClick={() => setPlacing(p => p === r.id ? null : r.id)}>
                  {placing === r.id ? 'Placing…' : 'Place'}
                </button>
                <button suppressHydrationWarning className="btn btn-sm" style={{ color: 'var(--crit)' }} disabled={!managed} onClick={() => removeRoom(r)}>✕</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 5, fontSize: 11.5, color: 'var(--text3)' }}>
                <span>{deviceCount(r)} device{deviceCount(r) === 1 ? '' : 's'}</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: managed ? 'pointer' : 'default' }}>
                  <input suppressHydrationWarning type="checkbox" checked={r.vertical} disabled={!managed} onChange={e => update(r, { vertical: e.target.checked })}/>
                  Vertical name
                </label>
              </div>
            </div>
          ))}
          {!floorRooms.length && <div style={{ padding: 16, fontSize: 12, color: 'var(--text3)' }}>No rooms on this floor yet.</div>}
          <div style={{ padding: '10px 14px', fontSize: 11.5, color: 'var(--text3)' }}>
            Assign devices to rooms in the <strong>Devices</strong> section. Changes appear on the Floor Plan right away.
          </div>
        </div>
      </div>
    </div>
  )
}
