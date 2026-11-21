'use client'

import { memo, useEffect, useRef, useState } from 'react'
import type { Device } from '@/lib/database.types'
import type { FloorRoom, FloorSheet } from '@/lib/floor-rooms'
import { drawOrder, saveDesign, useFloorDesigns, type DesignDoc, type El, type FloorDesign } from '@/lib/floor-designs'
import { useAuth } from '@/components/AuthProvider'
import { ElementView, statusOf, isRoomLike } from './elements'

// Saved designs (Settings → Manage → Floor plans → Designer) shown on the
// Floor Plan page in its usual panel: one tab per designed floor, the rooms
// drawn in the design as its room list, and the finished layout as the drawing.
// Network Admins can also move device markers there and drop devices onto it.

// A floor of the Floor Plan panel: an uploaded / built-in drawing, or a design
export type PanelSheet = FloorSheet & { design?: DesignDoc; label?: string; designId?: string; version?: number }

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export function designsForLocation(location: string, designs: FloorDesign[]): FloorDesign[] {
  return designs.filter(d => sameName(d.building, location)).sort((a, b) => a.floor_no - b.floor_no)
}

export function designSheet(d: FloorDesign): PanelSheet {
  return {
    key: `design-${d.id}`, building: d.building, floor: d.floor_no, planId: null, builtin: null, imageUrl: null,
    vbW: d.doc.width, vbH: d.doc.height, design: d.doc, label: d.floor_name, designId: d.id, version: d.version,
  }
}

const roomName = (e: El) => [e.text, e.roomNumber].filter(Boolean).join(' · ') || 'Unnamed room'

// The design's rooms (room shapes, and labelled rectangles / circles / polygons)
export function designRooms(sheet: PanelSheet): FloorRoom[] {
  return (sheet.design?.elements ?? []).filter(e => !e.hidden && isRoomLike(e)).map(e => ({
    id: `el-${e.id}`, building: sheet.building, floor: sheet.floor, label: roomName(e),
    x: Math.round(e.x + e.w / 2), y: Math.round(e.y + e.h / 2), vertical: false,
  }))
}

function inside(el: El, x: number, y: number) {
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2, a = (-el.rot * Math.PI) / 180
  const dx = x - cx, dy = y - cy
  const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a)
  return Math.abs(lx) <= el.w / 2 && Math.abs(ly) <= el.h / 2
}

// Device markers on the design → { room id → devices } and the devices on this floor.
// A marker belongs to the topmost room shape it sits in.
export function designDevices(sheet: PanelSheet, devById: Map<string, Device>) {
  const els = sheet.design?.elements ?? []
  const rooms = els.filter(e => !e.hidden && isRoomLike(e))
  const byRoom: Record<string, Device[]> = {}
  rooms.forEach(r => { byRoom[`el-${r.id}`] = [] })
  const onFloor: Device[] = []
  for (const m of els) {
    if (m.kind !== 'device' || !m.deviceId || m.hidden) continue
    const d = devById.get(m.deviceId)
    if (!d) continue
    onFloor.push(d)
    const cx = m.x + m.w / 2, cy = m.y + m.h / 2
    const room = [...rooms].reverse().find(r => inside(r, cx, cy))
    if (room) byRoom[`el-${room.id}`].push(d)
  }
  return { byRoom, onFloor }
}

const EMPTY = new Map<string, Device>()
const Item = memo(function Item({ el, dev }: { el: El; dev?: Device }) {
  return <ElementView el={el} devices={dev ? new Map([[dev.id, dev]]) : EMPTY} />
}, (a, b) => a.el === b.el && a.dev === b.dev)

const DEVICE_SIZE = 44

// The finished layout as drawn in the designer. Device markers (with live
// status) are shown when `showDevices` is on — the panel's Live toggle.
// Network Admins can drag markers to move them, and drop a device from the
// panel's list onto the plan; each change is saved to the design right away.
export function DesignDrawing({ sheet, devById, showDevices, focusRoom, showLinks = true, selectedDevice = null, onSelectDevice }: {
  sheet: PanelSheet
  devById: Map<string, Device>
  showDevices: boolean
  focusRoom: string | null     // room id from the side panel ("el-<element id>")
  showLinks?: boolean
  selectedDevice?: string | null                 // device id shown in the side panel
  onSelectDevice?: (deviceId: string) => void    // a tap on a marker (not a drag)
}) {
  const { can, profile } = useAuth()
  const who = profile?.full_name || profile?.email || 'Network Admin'
  const editable = can('settings.manage') && !!sheet.designId
  const { designs, reload } = useFloorDesigns()

  // Local copy while dragging / saving; the saved design replaces it when it arrives
  const [override, setOverride] = useState<DesignDoc | null>(null)
  useEffect(() => { setOverride(null) }, [sheet.design])
  const doc = override ?? sheet.design!
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')
  const flash = (t: string) => { setNote(t); setTimeout(() => setNote(''), 4000) }

  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean; base: DesignDoc; sx: number; sy: number } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const toSvg = (cx: number, cy: number) => {
    const svg = svgRef.current!, pt = svg.createSVGPoint()
    pt.x = cx; pt.y = cy
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
    return { x: p.x, y: p.y }
  }
  const snap = (v: number) => Math.round(v / (doc.grid || 10)) * (doc.grid || 10)

  async function persist(next: DesignDoc, base: DesignDoc) {
    setOverride(next)
    if (next === base) return
    setSaving(true)
    const latest = designs.find(d => d.id === sheet.designId)
    const r = await saveDesign(sheet.designId!, next, latest?.version ?? sheet.version ?? 1, who)
    setSaving(false)
    if (!r.ok) {
      flash('conflict' in r ? 'This floor was just changed elsewhere — reloaded, please try again.' : `Not saved: ${r.error}`)
      setOverride(null)
    } else flash('Saved')
    reload()
  }

  function onMarkerDown(e: React.PointerEvent, el: El) {
    if (!editable || el.locked || e.button !== 0) return
    e.stopPropagation()
    const p = toSvg(e.clientX, e.clientY)
    drag.current = { id: el.id, dx: p.x - el.x, dy: p.y - el.y, moved: false, base: doc, sx: e.clientX, sy: e.clientY }
    setDragging(el.id)
    svgRef.current?.setPointerCapture(e.pointerId)
  }
  function onMove(e: React.PointerEvent) {
    const d = drag.current; if (!d) return
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) return
    const p = toSvg(e.clientX, e.clientY)
    const x = snap(p.x - d.dx), y = snap(p.y - d.dy)
    d.moved = true
    setOverride(cur => {
      const from = cur ?? d.base
      return { ...from, elements: from.elements.map(x0 => x0.id === d.id ? { ...x0, x, y } : x0) }
    })
  }
  function onUp() {
    const d = drag.current; drag.current = null; setDragging(null)
    if (d?.moved && override) { persist(override, d.base); return }
    // Pressed and released without moving: a tap → show its details
    const el = d && doc.elements.find(x => x.id === d.id)
    if (el?.deviceId) onSelectDevice?.(el.deviceId)
  }

  // A device dropped from the panel's device list
  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    if (!editable) { flash('Only Network Admins can place devices.'); return }
    let id: string | undefined
    try { id = (JSON.parse(e.dataTransfer.getData('application/x-floorplan') || '{}') as { device?: string }).device } catch { /* not ours */ }
    const dev = id ? devById.get(id) : undefined
    if (!dev) return
    const p = toSvg(e.clientX, e.clientY)
    const x = snap(p.x - DEVICE_SIZE / 2), y = snap(p.y - DEVICE_SIZE / 2)
    const base = doc
    const here = base.elements.find(el => el.kind === 'device' && el.deviceId === dev.id)
    if (here) { persist({ ...base, elements: base.elements.map(el => el.id === here.id ? { ...el, x, y, hidden: false } : el) }, base); return }
    // One place per device: take it off any other floor first (after asking)
    const others = designs.filter(f => f.id !== sheet.designId && f.doc.elements.some(el => el.kind === 'device' && el.deviceId === dev.id))
    if (others.length) {
      if (!confirm(`${dev.name} is already placed on ${others.map(f => `${f.building} — ${f.floor_name}`).join(', ')}.\n\nMove it here? It will be removed from there.`)) return
      for (const f of others) {
        const r = await saveDesign(f.id, { ...f.doc, elements: f.doc.elements.filter(el => !(el.kind === 'device' && el.deviceId === dev.id)) }, f.version, who)
        if (!r.ok) { flash(`Could not move it from ${f.building} — ${f.floor_name}. Try again.`); reload(); return }
      }
    }
    persist({ ...base, elements: [...base.elements, {
      id: crypto.randomUUID(), kind: 'device', deviceId: dev.id, x, y, w: DEVICE_SIZE, h: DEVICE_SIZE,
      rot: 0, fill: '#ffffff', stroke: '#3d5a47', strokeW: 2, opacity: 1, fontSize: 11,
    }] }, base)
  }

  const els = drawOrder(doc.elements).filter(e => !e.hidden)
  const markers = new Map(els.filter(e => e.kind === 'device' && e.deviceId).map(e => [e.deviceId!, e]))
  const focus = focusRoom ? els.find(e => `el-${e.id}` === focusRoom) : undefined
  const bg = doc.background
  return (
    <>
      <svg ref={svgRef} viewBox={`0 0 ${doc.width} ${doc.height}`} preserveAspectRatio="xMidYMid meet"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', touchAction: editable ? 'none' : undefined }}
        onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onDragOver={e => { if (editable) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }} onDrop={onDrop}>
        <style>{`
          @keyframes fpd-ring { 0% { opacity: .6 } 100% { opacity: .1 } }
          .fpd-ring { animation: fpd-ring 1.2s ease-in-out infinite alternate; }
          @media (prefers-reduced-motion: reduce) { .fpd-ring { animation: none; } }
        `}</style>
        <rect width={doc.width} height={doc.height} fill="#ffffff" />
        {bg && <image href={bg.url} x={bg.x} y={bg.y} width={bg.w} height={bg.h} opacity={bg.opacity} preserveAspectRatio="none" />}
        {showDevices && showLinks && [...markers].map(([id, m]) => {
          const parent = devById.get(id)?.parent_id
          const pm = parent ? markers.get(parent) : undefined
          return pm ? <line key={`l-${id}`} x1={m.x + m.w / 2} y1={m.y + m.h / 2} x2={pm.x + pm.w / 2} y2={pm.y + pm.h / 2}
            stroke="#0891b2" strokeWidth={2.5} strokeDasharray="8 5" opacity={0.7} /> : null
        })}
        {els.map(e => e.kind === 'device'
          ? (showDevices ? (
            <g key={e.id} onPointerDown={ev => onMarkerDown(ev, e)}
              onClick={() => { if ((!editable || e.locked) && e.deviceId) onSelectDevice?.(e.deviceId) }}
              style={{ cursor: editable && !e.locked ? (dragging === e.id ? 'grabbing' : 'grab') : 'pointer' }}>
              {selectedDevice && e.deviceId === selectedDevice && (
                <circle cx={e.x + e.w / 2} cy={e.y + e.h / 2} r={Math.max(e.w, e.h) / 2 + 9} fill="rgba(124,58,237,.10)"
                  stroke="#7c3aed" strokeWidth={3} strokeDasharray="6 4" style={{ pointerEvents: 'none' }} />
              )}
              <title>{(() => { const d = e.deviceId ? devById.get(e.deviceId) : undefined; return d ? `${d.name} · ${d.ip} · ${statusOf(d).label}${editable ? ' — tap for details, drag to move' : ' — tap for details'}` : 'Device removed' })()}</title>
              <Item el={e} dev={e.deviceId ? devById.get(e.deviceId) : undefined} />
              {/* easy to grab, including the name under the icon */}
              <rect x={e.x - 4} y={e.y - 4} width={e.w + 8} height={e.h + 30} fill="transparent" />
            </g>
          ) : null)
          : <Item key={e.id} el={e} />)}
        {focus && (
          <rect className="fpd-ring" x={focus.x - 6} y={focus.y - 6} width={focus.w + 12} height={focus.h + 12} rx={8}
            fill="none" stroke="#16a34a" strokeWidth={5} style={{ pointerEvents: 'none' }}
            transform={focus.rot ? `rotate(${focus.rot} ${focus.x + focus.w / 2} ${focus.y + focus.h / 2})` : undefined} />
        )}
      </svg>
      {(saving || note) ? (
        <div style={{ position: 'absolute', top: 10, right: 10, padding: '4px 10px', borderRadius: 12, fontSize: 11.5, fontWeight: 600,
          background: 'rgba(255,255,255,.95)', border: '1px solid var(--border)', color: note && note !== 'Saved' ? 'var(--crit)' : 'var(--accent2)' }}>
          {saving ? 'Saving…' : note}
        </div>
      ) : editable && showDevices ? (
        <div style={{ position: 'absolute', top: 10, right: 10, padding: '3px 9px', borderRadius: 12, fontSize: 11, color: 'var(--text3)',
          background: 'rgba(255,255,255,.9)', border: '1px solid var(--border)', pointerEvents: 'none' }}>
          Tap a device for details · drag to move
        </div>
      ) : null}
    </>
  )
}
