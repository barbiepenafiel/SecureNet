'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { Device } from '@/lib/database.types'
import {
  useFloorRooms, useFloorPlans, roomOfDevice, FLOORPLAN_BUILDING, allSheets, roomsOfSheet, sheetsForLocation, roomsForLocation, floorLabel,
  type FloorRoom, type FloorPlan,
} from '@/lib/floor-rooms'
import { RoomLabel, SheetBackground } from '@/components/TopologyHub'
import { useBuildings, type Building } from '@/lib/buildings'

// Settings → Manage: device details and floor plans / rooms (Network Admins only)

const STATUS: Record<string, { label: string; cls: string }> = {
  up: { label: 'Online', cls: 'chip-ok' }, warn: { label: 'Warning', cls: 'chip-warn' },
  unreachable: { label: 'Unreachable', cls: 'chip-warn' }, down: { label: 'Offline', cls: 'chip-crit' },
  unknown: { label: 'Unknown', cls: 'chip-off' }, maint: { label: 'Maintenance', cls: 'chip-maint' },
}
const TYPES = ['Router', 'Switch', 'Access Point', 'Firewall', 'Server', 'Computer', 'Client']

export default function ManageSection() {
  const [part, setPart] = useState<'devices' | 'buildings' | 'rooms'>('devices')
  const { rooms, managed, reload } = useFloorRooms()
  const { plans } = useFloorPlans()

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 2, padding: 3, background: 'var(--surface3)', borderRadius: 8 }}>
          {([['devices', 'Devices'], ['buildings', 'Buildings'], ['rooms', 'Floor plans']] as const).map(([k, l]) => (
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
      {part === 'devices' && <DevicesManager rooms={rooms} roomsManaged={managed} plans={plans}/>}
      {part === 'buildings' && <BuildingsManager/>}
      {part === 'rooms'   && <RoomsManager rooms={rooms} managed={managed} reload={reload}/>}
    </div>
  )
}

// ─── Devices ──────────────────────────────────────────────────────────────────

// parent: '' = learned automatically by the agent, otherwise a device id (set by hand)
type Draft = { name: string; type: string; location: string; room_id: string; maint: boolean; parent: string }

function DevicesManager({ rooms, roomsManaged, plans }: { rooms: FloorRoom[]; roomsManaged: boolean; plans: FloorPlan[] }) {
  const [devices, setDevices] = useState<Device[]>([])
  const { names: buildingNames } = useBuildings()
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
    // A room only applies inside a building that has a floor plan with that room
    if (roomsManaged) patch.room_id = x.room_id && roomsForLocation(x.location, rooms, plans).some(r => r.id === x.room_id) ? x.room_id : null
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
    [...new Set(['Unassigned', ...buildingNames, ...plans.map(p => p.building), ...devices.map(d => d.location).filter(Boolean)])], [devices, plans, buildingNames])
  const shown = devices.filter(d => !q || [d.name, d.ip, d.mac, d.location, d.type].filter(Boolean).join(' ').toLowerCase().includes(q.toLowerCase()))
  const roomName = (d: Device) => roomOfDevice(d, roomsForLocation(d.location, rooms, plans))?.label
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
              const sheetsHere = sheetsForLocation(x.location, plans)
              const inPlanBuilding = sheetsHere.length > 0
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
                      title={!inPlanBuilding ? 'Rooms are available for buildings with a floor plan (Floor plans → + Add floor plan)' : undefined}>
                      <option value="">{inPlanBuilding ? '— No room —' : '—'}</option>
                      {sheetsHere.map(s => (
                        <optgroup key={s.key} label={floorLabel(s.floor)}>
                          {roomsOfSheet(rooms, s).map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
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

// ─── Floor plans and rooms ────────────────────────────────────────────────────
// Pick a building floor (IC Building's built-in drawings or an uploaded plan),
// add / rename / place rooms on it. "+ Add floor plan" uploads a drawing for
// any building and floor (supabase/migration_floor_plans.sql).

function RoomsManager({ rooms, managed, reload }: { rooms: FloorRoom[]; managed: boolean; reload: () => void }) {
  const { plans, plansManaged, reloadPlans } = useFloorPlans()
  const sheets = useMemo(() => allSheets(plans), [plans])
  const [sheetKey, setSheetKey] = useState<string>('builtin-1')
  const sheet = sheets.find(s => s.key === sheetKey) ?? sheets[0]
  const [placing, setPlacing] = useState<string | null>(null)   // room id waiting for a click on the plan
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [devices, setDevices] = useState<Device[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => { supabase.from('devices').select('*').then(({ data }) => setDevices((data ?? []) as Device[])) }, [rooms])

  const { vbW, vbH } = sheet
  const floorRooms = roomsOfSheet(rooms, sheet)
  const deviceCount = (r: FloorRoom) => devices.filter(d =>
    sheetsForLocation(d.location, plans).some(s => s.key === sheet.key) &&
    roomOfDevice(d, roomsForLocation(d.location, rooms, plans))?.id === r.id).length

  async function update(r: FloorRoom, patch: Partial<FloorRoom>) {
    setErr(null)
    const { error } = await supabase.from('floor_rooms').update(patch).eq('id', r.id)
    if (error) setErr(error.message); else reload()
  }

  async function addRoom() {
    setErr(null)
    const row: Record<string, unknown> = { building: sheet.building, floor: sheet.floor, label: 'New room', x: Math.round(vbW / 2), y: Math.round(vbH / 2) }
    if (sheet.planId) row.plan_id = sheet.planId
    const { data, error } = await supabase.from('floor_rooms').insert(row).select('id').single()
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

  async function removePlan() {
    const plan = plans.find(p => p.id === sheet.planId)
    if (!plan) return
    if (!confirm(`Delete the ${floorLabel(plan.floor)} plan of ${plan.building}? Its ${floorRooms.length} room(s) are deleted too; devices in them become "not in a room".`)) return
    setErr(null)
    const { error } = await supabase.from('floor_plans').delete().eq('id', plan.id)
    if (error) { setErr(error.message); return }
    await supabase.storage.from('floor-plans').remove([plan.image_path])
    setSheetKey('builtin-1')
    reloadPlans(); reload()
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

  // Room names scale with the drawing so they stay readable on large images
  const labelScale = Math.max(1, vbW / 1000)

  return (
    <div className="card">
      <div className="card-header">
        Floor plans
        <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>{sheet.building} · {floorLabel(sheet.floor)}</span>
        <div className="card-header-actions" style={{ flexWrap: 'wrap' }}>
          <select suppressHydrationWarning className="form-select" style={{ width: 'auto' }} value={sheet.key}
            onChange={e => { setSheetKey(e.target.value); setPlacing(null) }}>
            {[...new Set(sheets.map(s => s.building))].map(b => (
              <optgroup key={b} label={b}>
                {sheets.filter(s => s.building === b).map(s => <option key={s.key} value={s.key}>{b} — {floorLabel(s.floor)}</option>)}
              </optgroup>
            ))}
          </select>
          <button suppressHydrationWarning className="btn btn-sm btn-primary" disabled={!plansManaged}
            title={!plansManaged ? 'Run supabase/migration_floor_plans.sql in Supabase first' : undefined}
            onClick={() => setAdding(true)}>+ Add floor plan</button>
          <button suppressHydrationWarning className="btn btn-sm" disabled={!managed} onClick={addRoom}>+ Add room</button>
          {sheet.planId && <button suppressHydrationWarning className="btn btn-sm" style={{ color: 'var(--crit)' }} onClick={removePlan}>Delete plan</button>}
        </div>
      </div>
      {!plansManaged && (
        <div style={{ padding: '8px 14px', fontSize: 12, color: 'var(--warn)', borderBottom: '1px solid var(--border)' }}>
          To add floor plans for other buildings, run <span className="mono">supabase/migration_floor_plans.sql</span> in Supabase.
        </div>
      )}

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
            <SheetBackground sheet={sheet}/>
            <svg ref={svgRef} viewBox={`0 0 ${vbW} ${vbH}`} onClick={onPlanClick}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: placing ? 'crosshair' : 'default' }}>
              {floorRooms.map(r => (
                <g key={r.id} transform={labelScale > 1 ? `translate(${r.x},${r.y}) scale(${labelScale}) translate(${-r.x},${-r.y})` : undefined}>
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
          {!floorRooms.length && <div style={{ padding: 16, fontSize: 12, color: 'var(--text3)' }}>No rooms on this floor yet — press “+ Add room”.</div>}
          <div style={{ padding: '10px 14px', fontSize: 11.5, color: 'var(--text3)' }}>
            Assign devices to rooms in the <strong>Devices</strong> section: set a device&apos;s Building to <strong>{sheet.builtin ? 'IC Building / Building A' : sheet.building}</strong>, then pick its room. Changes appear on the Floor Plan right away.
          </div>
        </div>
      </div>

      {adding && <AddPlanModal plans={plans} onClose={() => setAdding(false)}
        onSaved={key => { setAdding(false); reloadPlans(); setSheetKey(key) }}/>}
    </div>
  )
}

// Upload a floor drawing for a building and floor
function AddPlanModal({ plans, onClose, onSaved }: { plans: FloorPlan[]; onClose: () => void; onSaved: (sheetKey: string) => void }) {
  const [building, setBuilding] = useState('')
  const [floor, setFloor] = useState(1)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<{ url: string; w: number; h: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [known, setKnown] = useState<string[]>([])
  const { names: buildingNames } = useBuildings()

  useEffect(() => {
    supabase.from('devices').select('location').then(({ data }) => {
      const locs = (data ?? []).map((d: { location: string }) => d.location).filter(l => l && l !== 'Unassigned')
      setKnown([...new Set([...locs, ...buildingNames, ...plans.map(p => p.building)])].sort())
    })
  }, [plans, buildingNames])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url) }, [preview])

  function pick(f: File | null) {
    setErr(null); setFile(null); setPreview(null)
    if (!f) return
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { setErr('Use a PNG, JPG or WebP image of the floor plan.'); return }
    if (f.size > 10 * 1024 * 1024) { setErr('The image is larger than 10 MB.'); return }
    const url = URL.createObjectURL(f)
    const img = new window.Image()
    img.onload = () => { setFile(f); setPreview({ url, w: img.naturalWidth, h: img.naturalHeight }) }
    img.onerror = () => { URL.revokeObjectURL(url); setErr('That file could not be read as an image.') }
    img.src = url
  }

  const name = building.trim()
  const exists = plans.some(p => p.building.trim().toLowerCase() === name.toLowerCase() && p.floor === floor)

  async function save() {
    if (!name) { setErr('Enter the building name.'); return }
    if (!file || !preview) { setErr('Choose the floor plan image.'); return }
    if (exists) { setErr(`${name} already has a ${floorLabel(floor)} plan — delete it first to replace it.`); return }
    setSaving(true); setErr(null)
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
    const path = `${crypto.randomUUID()}.${ext}`
    const up = await supabase.storage.from('floor-plans').upload(path, file, { contentType: file.type, upsert: false })
    if (up.error) { setSaving(false); setErr(`Upload failed: ${up.error.message}`); return }
    const { data, error } = await supabase.from('floor_plans')
      .insert({ building: name, floor, image_path: path, width: preview.w, height: preview.h }).select('id').single()
    if (error) {
      await supabase.storage.from('floor-plans').remove([path])
      setSaving(false); setErr(error.message); return
    }
    setSaving(false)
    onSaved(data.id)
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card" onClick={e => e.stopPropagation()} style={{ width: 520, maxWidth: '100%', maxHeight: '90vh', overflow: 'auto' }}>
        <div className="card-header">Add floor plan</div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="form-group">
            <label className="form-label">Building</label>
            <input suppressHydrationWarning className="form-input" list="fp-buildings" placeholder="e.g. Library, Admin Building"
              value={building} onChange={e => setBuilding(e.target.value)}/>
            <datalist id="fp-buildings">{known.map(b => <option key={b} value={b}/>)}</datalist>
            <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>Devices whose Building (location) has this exact name appear on this plan.</div>
          </div>
          <div className="form-group">
            <label className="form-label">Floor</label>
            <select suppressHydrationWarning className="form-select" value={floor} onChange={e => setFloor(Number(e.target.value))}>
              {Array.from({ length: 10 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{floorLabel(n)}</option>)}
            </select>
            {exists && <div style={{ fontSize: 11.5, color: 'var(--crit)', marginTop: 4 }}>This building already has a {floorLabel(floor)} plan.</div>}
          </div>
          <div className="form-group">
            <label className="form-label">Floor plan image (PNG, JPG or WebP, up to 10 MB)</label>
            <input suppressHydrationWarning type="file" accept="image/png,image/jpeg,image/webp" onChange={e => pick(e.target.files?.[0] ?? null)}/>
          </div>
          {preview && (
            <div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview.url} alt="Floor plan preview" style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 8, display: 'block' }}/>
              <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>{preview.w} × {preview.h} px</div>
            </div>
          )}
          {err && <div style={{ fontSize: 12.5, color: 'var(--crit)' }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button suppressHydrationWarning className="btn" onClick={onClose} disabled={saving}>Cancel</button>
            <button suppressHydrationWarning className="btn btn-primary" onClick={save} disabled={saving || !file || !name}>
              {saving ? 'Uploading…' : 'Add floor plan'}
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>After adding, press “+ Add room” and place each room name on the drawing.</div>
        </div>
      </div>
    </div>
  )
}

// ─── Buildings ────────────────────────────────────────────────────────────────
// The names in every Building / Location dropdown. Renaming also moves the
// devices, floor plans, rooms and users that used the old name (/api/buildings).

function BuildingsManager() {
  const { buildings, managed, reload } = useBuildings()
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)

  const loadCounts = useCallback(async () => {
    const { data } = await supabase.from('devices').select('location')
    const c: Record<string, number> = {}
    for (const d of (data ?? []) as { location: string }[]) c[d.location] = (c[d.location] ?? 0) + 1
    setCounts(c)
  }, [])
  useEffect(() => { loadCounts() }, [loadCounts, buildings])

  const flash = (text: string, ok: boolean) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 5000) }

  async function call(method: string, body?: object, query = '') {
    const res = await fetch(`/api/buildings${query}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(d.error ?? 'Request failed')
    return d
  }

  async function add() {
    const name = newName.trim()
    if (!name) return
    setBusy('new')
    try { await call('POST', { name }); setNewName(''); flash(`Added ${name}`, true); reload() }
    catch (e) { flash((e as Error).message, false) }
    setBusy(null)
  }

  async function rename(b: Building) {
    const name = (drafts[b.id] ?? b.name).trim()
    if (!name || name === b.name) return
    const n = counts[b.name] ?? 0
    // The IC Building's built-in floor drawings follow names like "IC Building" / "Building A"
    const loses = FLOORPLAN_BUILDING.test(b.name) && !FLOORPLAN_BUILDING.test(name)
    if (!confirm(`Rename "${b.name}" to "${name}"?${n ? ` Its ${n} device(s) move with it.` : ''}${loses ? '\n\nNote: the built-in IC Building floor drawings only show for names containing "IC Building" (or "Building A") — upload a floor plan for the new name under Floor plans.' : ''}`)) return
    setBusy(b.id)
    try {
      await call('PATCH', { id: b.id, name })
      setDrafts(p => { const x = { ...p }; delete x[b.id]; return x })
      flash(`Renamed ${b.name} to ${name}`, true); reload()
    } catch (e) { flash((e as Error).message, false) }
    setBusy(null)
  }

  async function remove(b: Building) {
    const n = counts[b.name] ?? 0
    if (!confirm(`Delete "${b.name}"?${n ? ` Its ${n} device(s) become Unassigned.` : ''}`)) return
    setBusy(b.id)
    try { await call('DELETE', undefined, `?id=${encodeURIComponent(b.id)}`); flash(`Deleted ${b.name}`, true); reload() }
    catch (e) { flash((e as Error).message, false) }
    setBusy(null)
  }

  if (!managed) return (
    <div className="card"><div className="card-body" style={{ fontSize: 13, color: 'var(--text2)' }}>
      To add and rename buildings, run <span className="mono">supabase/migration_buildings.sql</span> in the Supabase SQL Editor.
      Until then the built-in names (Building A, B, C, Data Center, Library, Admin Building) are used.
    </div></div>
  )

  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <div className="card-header">
        Buildings
        <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>Names used in every Building / Location list</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl">
          <thead><tr><th>Name</th><th>Devices</th><th></th></tr></thead>
          <tbody>
            {buildings.map(b => {
              const draft = drafts[b.id] ?? b.name
              const changed = draft.trim() !== b.name && !!draft.trim()
              return (
                <tr key={b.id} style={changed ? { background: 'rgba(22,163,74,.05)' } : undefined}>
                  <td style={{ minWidth: 240 }}>
                    <input suppressHydrationWarning className="form-input" value={draft} maxLength={60}
                      onChange={e => setDrafts(p => ({ ...p, [b.id]: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') rename(b) }}/>
                  </td>
                  <td style={{ color: 'var(--text2)' }}>{counts[b.name] ?? 0}</td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button suppressHydrationWarning className="btn btn-sm btn-primary" disabled={!changed || busy === b.id} onClick={() => rename(b)}>
                      {busy === b.id ? 'Saving…' : 'Rename'}
                    </button>{' '}
                    <button suppressHydrationWarning className="btn btn-sm" style={{ color: 'var(--crit)' }} disabled={busy === b.id} onClick={() => remove(b)}>Delete</button>
                  </td>
                </tr>
              )
            })}
            {!buildings.length && <tr><td colSpan={3} style={{ textAlign: 'center', padding: 20, color: 'var(--text3)' }}>No buildings yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--border)', flexWrap: 'wrap', alignItems: 'center' }}>
        <input suppressHydrationWarning className="form-input" style={{ flex: '1 1 220px' }} placeholder="New building name" maxLength={60}
          value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add() }}/>
        <button suppressHydrationWarning className="btn btn-primary" disabled={!newName.trim() || busy === 'new'} onClick={add}>+ Add building</button>
        {msg && <span style={{ fontSize: 12.5, color: msg.ok ? 'var(--ok)' : 'var(--crit)' }}>{msg.text}</span>}
      </div>
      <div style={{ padding: '0 16px 12px', fontSize: 11.5, color: 'var(--text3)' }}>
        Renaming moves its devices, floor plans, rooms and users&apos; building access to the new name. Deleting sets its devices to Unassigned.
      </div>
    </div>
  )
}
