'use client'

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import type { Device } from '@/lib/database.types'
import { useAuth } from '@/components/AuthProvider'
import { useBuildings } from '@/lib/buildings'
import { useFloorPlans, planImageUrl, floorLabel } from '@/lib/floor-rooms'
import {
  useFloorDesigns, createFloor, renameFloor, deleteFloor, saveDesign, uploadBackground, removeBackgroundFile,
  normalizeDoc, floorName, drawOrder, EMPTY_DOC, type DesignDoc, type El, type Background, type FloorDesign, type IconKey,
} from '@/lib/floor-designs'
import {
  LIBRARY, CATEGORIES, ElementView, Icon, ICON_PATHS, iconForType, statusOf, STATUS_COLOR, isLinear, hasText, KIND_LABEL, isRoomLike,
  type LibItem,
} from './elements'
import s from './designer.module.css'

// Settings → Manage → Floor plans → Designer.
// A grid canvas to draw a building floor (rooms, walls, doors, labels,
// shapes) and place the real devices from the inventory on it. Saved per
// building floor in floor_designs; device markers keep only the device id,
// so name, IP and live status always come from the devices table.

type Pt = { x: number; y: number }
type Tool = 'select' | 'pan' | 'room' | 'poly' | 'wall' | 'text'
type View = { zoom: number; x: number; y: number }
type Drag =
  | { t: 'move'; start: Pt; orig: Map<string, El>; before: DesignDoc }
  | { t: 'resize'; id: string; hx: number; hy: number; el0: El; before: DesignDoc; keepRatio: boolean }
  | { t: 'rotate'; id: string; el0: El; before: DesignDoc }
  | { t: 'marquee'; start: Pt; cur: Pt; add: boolean }
  | { t: 'pan'; sx: number; sy: number; v0: View }
  | { t: 'room'; start: Pt; cur: Pt }
  | { t: 'bg'; start: Pt; bg0: Background; before: DesignDoc }

const uid = () => crypto.randomUUID()
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const rad = (deg: number) => (deg * Math.PI) / 180
const MIN_ZOOM = 0.1, MAX_ZOOM = 4
const DEVICE_SIZE = 44
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
const toHex = (c: string | undefined, fallback: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback)
const ago = (iso?: string | null) => {
  if (!iso) return '—'
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return sec < 60 ? 'just now' : sec < 3600 ? `${Math.round(sec / 60)} min ago` : sec < 86400 ? `${Math.round(sec / 3600)} h ago` : `${Math.round(sec / 86400)} d ago`
}
const fmtMin = (m: number) => { const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60; return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m` }

// Point inside an element's (rotated) box?
function contains(el: El, p: Pt) {
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2
  const a = rad(-el.rot)
  const dx = p.x - cx, dy = p.y - cy
  const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a)
  return Math.abs(lx) <= el.w / 2 && Math.abs(ly) <= el.h / 2
}

// Re-render an element only when it (or its device) changes — keeps large plans fast
const MemoElement = memo(function MemoElement({ el, dev }: { el: El; dev?: Device }) {
  return <ElementView el={el} devices={dev ? new Map([[dev.id, dev]]) : EMPTY_DEVICES} />
}, (a, b) => a.el === b.el && a.dev === b.dev)
const EMPTY_DEVICES = new Map<string, Device>()

// Thumbnail of a library item
function Thumb({ item }: { item: LibItem }) {
  const base = item.make()
  const el: El = { ...base, id: 't', x: 0, y: 0 }
  const pad = 6
  const vb = `${-pad} ${-pad - (base.kind === 'sym' ? 0 : 0)} ${base.w + pad * 2} ${base.h + pad * 2}`
  return (
    <svg className={s.thumb} viewBox={vb} preserveAspectRatio="xMidYMid meet" aria-hidden>
      <ElementView el={{ ...el, text: el.kind === 'sym' ? undefined : el.text }} devices={EMPTY_DEVICES} />
    </svg>
  )
}

export default function FloorplanDesigner() {
  const { can, profile } = useAuth()
  const canEdit = can('settings.manage')
  const who = profile?.full_name || profile?.email || 'Network Admin'
  const { designs, ready, reload } = useFloorDesigns()
  const { buildings, names: buildingNames, managed: buildingsManaged, reload: reloadBuildings } = useBuildings()
  const { plans } = useFloorPlans()
  const gridId = useId().replace(/:/g, '')

  // ── Building and floor ─────────────────────────────────────────────────────
  const [extraBuildings, setExtraBuildings] = useState<string[]>([])
  const allBuildings = useMemo(() => [...new Set([...buildingNames, ...designs.map(d => d.building), ...extraBuildings])]
    .sort((a, b) => a.localeCompare(b)), [buildingNames, designs, extraBuildings])
  const [building, setBuilding] = useState('')
  const floors = useMemo(() => designs.filter(d => d.building === building).sort((a, b) => a.floor_no - b.floor_no), [designs, building])
  const [floorId, setFloorId] = useState<string | null>(null)
  const current: FloorDesign | null = designs.find(d => d.id === floorId) ?? null

  useEffect(() => {
    if (building && allBuildings.includes(building)) return
    const same = building && allBuildings.find(b => b.toLowerCase() === building.toLowerCase())
    if (same) { setBuilding(same); return }
    const withPlan = designs[0]?.building
    if (withPlan || allBuildings[0]) setBuilding(withPlan ?? allBuildings[0])
  }, [allBuildings, designs, building])
  useEffect(() => {
    if (floorId && floors.some(f => f.id === floorId)) return
    setFloorId(floors[0]?.id ?? null)
  }, [floors, floorId])

  // ── Working document, undo / redo ─────────────────────────────────────────
  const [doc, setDocState] = useState<DesignDoc>(EMPTY_DOC)
  const docRef = useRef(doc)
  const setDoc = useCallback((d: DesignDoc) => { docRef.current = d; setDocState(d) }, [])
  const versionRef = useRef(0)
  const loadedId = useRef<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const past = useRef<DesignDoc[]>([])
  const future = useRef<DesignDoc[]>([])
  const lastKey = useRef<{ key: string; at: number } | null>(null)
  const [, bump] = useState(0)
  const [sel, setSel] = useState<string[]>([])

  const commit = useCallback((next: DesignDoc, opts: { before?: DesignDoc; key?: string } = {}) => {
    const before = opts.before ?? docRef.current
    const now = Date.now()
    // Typing in a field: one undo step per field, not per keystroke
    const merge = opts.key && lastKey.current?.key === opts.key && now - lastKey.current.at < 1500
    if (!merge) {
      past.current.push(before)
      if (past.current.length > 150) past.current.shift()
      future.current = []
    }
    lastKey.current = opts.key ? { key: opts.key, at: now } : null
    setDoc(next)
    setDirty(true)
    bump(n => n + 1)
  }, [setDoc])

  const undo = useCallback(() => {
    const p = past.current.pop(); if (!p) return
    future.current.push(docRef.current); lastKey.current = null
    setDoc(p); setDirty(true); bump(n => n + 1)
    setSel(ids => ids.filter(id => p.elements.some(e => e.id === id)))
  }, [setDoc])
  const redo = useCallback(() => {
    const f = future.current.pop(); if (!f) return
    past.current.push(docRef.current); lastKey.current = null
    setDoc(f); setDirty(true); bump(n => n + 1)
    setSel(ids => ids.filter(id => f.elements.some(e => e.id === id)))
  }, [setDoc])

  // Load the chosen floor; take another admin's newer save when nothing is unsaved here
  useEffect(() => {
    if (!current) { loadedId.current = null; setDoc(EMPTY_DOC); return }
    if (loadedId.current !== current.id) {
      loadedId.current = current.id
      versionRef.current = current.version
      past.current = []; future.current = []; lastKey.current = null
      setDoc(normalizeDoc(current.doc)); setDirty(false); setSel([]); setSaveState('idle')
      requestAnimationFrame(() => fitRef.current())
    } else if (current.version > versionRef.current && !dirtyRef.current) {
      versionRef.current = current.version
      setDoc(normalizeDoc(current.doc))
    }
  }, [current, setDoc])

  // ── Saving (button + autosave) ────────────────────────────────────────────
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>('idle')
  const [saveErr, setSaveErr] = useState('')
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const saving = useRef(false)
  const save = useCallback(async () => {
    if (!current || !canEdit || saving.current) return false
    saving.current = true
    setSaveState('saving')
    const snapshot = docRef.current
    const r = await saveDesign(current.id, snapshot, versionRef.current, who)
    saving.current = false
    if (r.ok) {
      versionRef.current = r.version
      if (docRef.current === snapshot) setDirty(false)
      setSaveState('saved'); setSavedAt(Date.now())
      return true
    }
    if ('conflict' in r) { setSaveState('conflict'); return false }
    setSaveState('error'); setSaveErr(r.error)
    return false
  }, [current, canEdit, who])

  const [mode, setMode] = useState<'edit' | 'view'>('edit')
  // editMode: the admin is in Edit mode (buildings and floors can be managed)
  // editing: … and a floor is open (drawing tools)
  const editMode = mode === 'edit' && canEdit
  const editing = editMode && !!current
  // (non-admins can't edit: editMode above also requires canEdit)

  useEffect(() => {
    if (!dirty || !editing || saveState === 'conflict' || saveState === 'saving') return
    const t = setTimeout(() => { save() }, 2500)
    return () => clearTimeout(t)
  }, [doc, dirty, editing, saveState, save])

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  async function switchFloor(id: string | null, b = building) {
    if (dirtyRef.current && current) await save()
    setBuilding(b); setFloorId(id); setPopup(null)
  }

  function resolveConflict(keepMine: boolean) {
    if (!current) return
    versionRef.current = current.version
    if (keepMine) { setSaveState('idle'); save() }
    else { setDoc(normalizeDoc(current.doc)); setDirty(false); setSaveState('idle'); past.current = []; future.current = []; bump(n => n + 1) }
  }

  // ── Devices (live) ─────────────────────────────────────────────────────────
  const [devices, setDevices] = useState<Device[]>([])
  const loadDevices = useCallback(async () => {
    const { data } = await supabase.from('devices').select('*').order('name')
    setDevices((data ?? []) as Device[])
  }, [])
  useEffect(() => {
    loadDevices()
    let t: ReturnType<typeof setTimeout> | null = null
    const ch = supabase.channel(`fp-devices-${uid()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, () => { if (t) clearTimeout(t); t = setTimeout(loadDevices, 800) })
      .subscribe()
    const poll = setInterval(() => { if (document.visibilityState === 'visible') loadDevices() }, 20_000)
    return () => { supabase.removeChannel(ch); clearInterval(poll); if (t) clearTimeout(t) }
  }, [loadDevices])
  const devMap = useMemo(() => new Map(devices.map(d => [d.id, d])), [devices])
  // Where each device is placed (any floor)
  const placedOn = useMemo(() => {
    const m = new Map<string, FloorDesign[]>()
    for (const f of designs) for (const e of (f.id === current?.id ? doc.elements : f.doc.elements)) {
      if (e.kind === 'device' && e.deviceId) m.set(e.deviceId, [...(m.get(e.deviceId) ?? []), f])
    }
    return m
  }, [designs, doc, current])

  // ── View: zoom and pan ─────────────────────────────────────────────────────
  const wrapRef = useRef<HTMLDivElement>(null)
  const [view, setViewState] = useState<View>({ zoom: 0.5, x: 24, y: 24 })
  const viewRef = useRef(view)
  const setView = useCallback((v: View) => { viewRef.current = v; setViewState(v) }, [])
  const toWorld = useCallback((clientX: number, clientY: number): Pt => {
    const r = wrapRef.current!.getBoundingClientRect(), v = viewRef.current
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom }
  }, [])
  const fit = useCallback(() => {
    const r = wrapRef.current?.getBoundingClientRect(); if (!r) return
    const d = docRef.current
    const zoom = clamp(Math.min((r.width - 48) / d.width, (r.height - 48) / d.height), MIN_ZOOM, MAX_ZOOM)
    setView({ zoom, x: (r.width - d.width * zoom) / 2, y: (r.height - d.height * zoom) / 2 })
  }, [setView])
  const fitRef = useRef(fit); fitRef.current = fit
  const zoomAt = useCallback((factor: number, sx?: number, sy?: number) => {
    const r = wrapRef.current?.getBoundingClientRect(); if (!r) return
    const v = viewRef.current
    const px = sx ?? r.width / 2, py = sy ?? r.height / 2
    const zoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM)
    setView({ zoom, x: px - ((px - v.x) / v.zoom) * zoom, y: py - ((py - v.y) / v.zoom) * zoom })
  }, [setView])
  useEffect(() => {
    const w = wrapRef.current; if (!w) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = w.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top)
      else { const v = viewRef.current; setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }) }
    }
    w.addEventListener('wheel', onWheel, { passive: false })
    return () => w.removeEventListener('wheel', onWheel)
  }, [zoomAt, setView, current])
  const viewCenter = (): Pt => {
    const r = wrapRef.current?.getBoundingClientRect()
    return r ? toWorld(r.left + r.width / 2, r.top + r.height / 2) : { x: doc.width / 2, y: doc.height / 2 }
  }

  // ── Tools and snapping ─────────────────────────────────────────────────────
  const [tool, setTool] = useState<Tool>('select')
  const [snap, setSnap] = useState(true)
  const [showLinks, setShowLinks] = useState(true)
  const g = doc.grid
  const sn = useCallback((v: number) => (snap ? Math.round(v / docRef.current.grid) * docRef.current.grid : Math.round(v)), [snap])
  const snapPt = (p: Pt): Pt => ({ x: sn(p.x), y: sn(p.y) })
  const [wallStart, setWallStart] = useState<Pt | null>(null)
  const [wallThick, setWallThick] = useState(12)
  const [polyPts, setPolyPts] = useState<Pt[]>([])
  const [cursor, setCursor] = useState<Pt | null>(null)
  const drag = useRef<Drag | null>(null)
  const [dragView, setDragView] = useState<Drag | null>(null)   // for marquee / room previews
  const textInput = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  const focusText = () => setTimeout(() => { textInput.current?.focus(); textInput.current?.select() }, 30)

  useEffect(() => { if (tool !== 'wall') setWallStart(null); if (tool !== 'poly') setPolyPts([]) }, [tool])

  // ── Element helpers ────────────────────────────────────────────────────────
  const selected = doc.elements.filter(e => sel.includes(e.id))
  const one = selected.length === 1 ? selected[0] : null
  const patchEls = (ids: string[], fn: (e: El) => El, key?: string) =>
    commit({ ...docRef.current, elements: docRef.current.elements.map(e => (ids.includes(e.id) ? fn(e) : e)) }, { key })
  const addEl = (el: El) => { commit({ ...docRef.current, elements: [...docRef.current.elements, el] }); setSel([el.id]) }

  function addFromLib(item: LibItem, at?: Pt) {
    if (!editing) return
    const base = item.make()
    const p = at ?? viewCenter()
    const el: El = { ...base, id: uid(), x: sn(p.x - base.w / 2), y: sn(p.y - base.h / 2) }
    if (el.kind === 'room') el.text = `Room ${docRef.current.elements.filter(e => e.kind === 'room' || (e.kind === 'polygon' && e.roomNumber !== undefined)).length + 1}`
    if (el.kind === 'sym') el.text = item.label
    addEl(el); setTool('select')
    if (hasText(el.kind)) focusText()
  }
  // Other floors (any building) this device is already placed on
  const placedElsewhere = (id: string) => (placedOn.get(id) ?? []).filter(f => f.id !== current?.id)
  const whereText = (fs: FloorDesign[]) => fs.map(f => `${f.building} — ${f.floor_name}`).join(', ')

  // A device has one physical place: if it is on another floor, it is moved
  // from there (that floor is saved at once) — never placed twice.
  async function takeFromOtherFloors(d: Device): Promise<boolean> {
    const others = placedElsewhere(d.id)
    if (!others.length) return true
    if (!confirm(`${d.name} is already placed on ${whereText(others)}.\n\nMove it to ${building} — ${current?.floor_name}? It will be removed from there.`)) return false
    for (const f of others) {
      const doc2 = { ...f.doc, elements: f.doc.elements.filter(e => !(e.kind === 'device' && e.deviceId === d.id)) }
      const r = await saveDesign(f.id, doc2, f.version, who)
      if (!r.ok) {
        alert(`Could not remove ${d.name} from ${f.building} — ${f.floor_name}: ${'conflict' in r ? 'that floor was just changed by someone else. Try again.' : r.error}`)
        reload()
        return false
      }
    }
    reload()
    return true
  }

  async function addDevice(d: Device, at?: Pt) {
    const existing = docRef.current.elements.find(e => e.kind === 'device' && e.deviceId === d.id)
    if (existing) { setSel([existing.id]); centerOn(existing); return }
    if (!editing) return
    if (!(await takeFromOtherFloors(d))) return
    if (docRef.current.elements.some(e => e.kind === 'device' && e.deviceId === d.id)) return
    const p = at ?? viewCenter()
    addEl({ id: uid(), kind: 'device', deviceId: d.id, x: sn(p.x - DEVICE_SIZE / 2), y: sn(p.y - DEVICE_SIZE / 2), w: DEVICE_SIZE, h: DEVICE_SIZE,
      rot: 0, fill: '#ffffff', stroke: '#3d5a47', strokeW: 2, opacity: 1, fontSize: 11 })
    setTool('select')
  }
  function centerOn(el: El) {
    const r = wrapRef.current?.getBoundingClientRect(); if (!r) return
    const v = viewRef.current
    setView({ ...v, x: r.width / 2 - (el.x + el.w / 2) * v.zoom, y: r.height / 2 - (el.y + el.h / 2) * v.zoom })
  }
  const removeSel = () => {
    if (!sel.length) return
    commit({ ...docRef.current, elements: docRef.current.elements.filter(e => !sel.includes(e.id) || e.locked) })
    setSel([])
  }
  const duplicateSel = () => {
    if (!selected.length) return
    const copies = selected.filter(e => e.kind !== 'device').map(e => ({ ...e, id: uid(), x: e.x + g, y: e.y + g, locked: false }))
    if (!copies.length) return
    commit({ ...docRef.current, elements: [...docRef.current.elements, ...copies] })
    setSel(copies.map(c => c.id))
  }
  const reorder = (front: boolean, ids: string[] = sel) => {
    const els = docRef.current.elements
    const picked = els.filter(e => ids.includes(e.id)), rest = els.filter(e => !ids.includes(e.id))
    commit({ ...docRef.current, elements: front ? [...rest, ...picked] : [...picked, ...rest] })
  }
  // One layer up (toward the front) or down, among elements of the same group
  // (shapes / rooms / labels, or devices — devices are always above the rest)
  const stepLayer = (id: string, up: boolean) => {
    const els = [...docRef.current.elements]
    const i = els.findIndex(e => e.id === id); if (i < 0) return
    const group = (e: El) => e.kind === 'device'
    let j = i
    do { j += up ? 1 : -1 } while (j >= 0 && j < els.length && group(els[j]) !== group(els[i]))
    if (j < 0 || j >= els.length) return
    ;[els[i], els[j]] = [els[j], els[i]]
    commit({ ...docRef.current, elements: els })
  }
  const toggleFlag = (id: string, flag: 'hidden' | 'locked') =>
    patchEls([id], e => ({ ...e, [flag]: !e[flag] }))
  function clearCanvas() {
    if (!docRef.current.elements.length) return
    if (!confirm(`Remove all ${docRef.current.elements.length} element(s) from this floor? Devices stay in the inventory. You can undo this.`)) return
    commit({ ...docRef.current, elements: [] }); setSel([])
  }

  // ── Pointer interaction ────────────────────────────────────────────────────
  const [popup, setPopup] = useState<{ id: string; x: number; y: number } | null>(null)
  const spaceDown = useRef(false)

  function onPointerDown(e: React.PointerEvent) {
    wrapRef.current?.focus({ preventScroll: true })
    if (e.button === 2) return
    const target = e.target as Element
    const hitId = target.closest('[data-id]')?.getAttribute('data-id') ?? null
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle') ?? null
    const p = toWorld(e.clientX, e.clientY)
    const capture = () => (e.currentTarget as Element).setPointerCapture(e.pointerId)
    const startPan = () => { drag.current = { t: 'pan', sx: e.clientX, sy: e.clientY, v0: viewRef.current }; capture() }

    if (!editing) {
      const el = hitId ? docRef.current.elements.find(x => x.id === hitId) : null
      if (el?.kind === 'device' && el.deviceId) {
        const r = wrapRef.current!.getBoundingClientRect()
        setPopup({ id: el.deviceId, x: e.clientX - r.left, y: e.clientY - r.top })
        return
      }
      setPopup(null); startPan(); return
    }
    if (e.button === 1 || tool === 'pan' || spaceDown.current) { startPan(); return }

    if (tool === 'room') { const sp = snapPt(p); drag.current = { t: 'room', start: sp, cur: sp }; setDragView(drag.current); capture(); return }
    if (tool === 'text') {
      const base = LIBRARY.find(i => i.key === 'text')!.make()
      addEl({ ...base, id: uid(), x: sn(p.x - base.w / 2), y: sn(p.y - base.h / 2) })
      setTool('select'); focusText(); return
    }
    if (tool === 'wall') {
      let q = snapPt(p)
      if (wallStart && e.shiftKey) q = constrain(wallStart, q)
      if (wallStart && Math.hypot(q.x - wallStart.x, q.y - wallStart.y) > 4) {
        const len = Math.hypot(q.x - wallStart.x, q.y - wallStart.y)
        const ang = (Math.atan2(q.y - wallStart.y, q.x - wallStart.x) * 180) / Math.PI
        const cx = (wallStart.x + q.x) / 2, cy = (wallStart.y + q.y) / 2
        const base = LIBRARY.find(i => i.key === 'wall')!.make()
        commit({ ...docRef.current, elements: [...docRef.current.elements, {
          ...base, id: uid(), w: len + wallThick, h: wallThick, x: cx - (len + wallThick) / 2, y: cy - wallThick / 2, rot: Math.round(ang * 100) / 100,
        }] })
      }
      setWallStart(q); return
    }
    if (tool === 'poly') { setPolyPts(pts => [...pts, snapPt(p)]); return }

    // Select tool
    if (handle && one && !one.locked) {
      if (handle === 'rot') drag.current = { t: 'rotate', id: one.id, el0: one, before: docRef.current }
      else {
        const [hx, hy] = handle.split(',').map(Number)
        drag.current = { t: 'resize', id: one.id, hx, hy, el0: one, before: docRef.current, keepRatio: one.kind === 'square' || one.kind === 'circle' || one.kind === 'device' || one.kind === 'sym' }
      }
      capture(); return
    }
    if (hitId) {
      const el = docRef.current.elements.find(x => x.id === hitId)
      if (!el) return
      if (e.shiftKey) { setSel(ids => ids.includes(hitId) ? ids.filter(i => i !== hitId) : [...ids, hitId]); return }
      const ids = sel.includes(hitId) ? sel : [hitId]
      if (!sel.includes(hitId)) setSel(ids)
      const movable = docRef.current.elements.filter(x => ids.includes(x.id) && !x.locked)
      if (movable.length) { drag.current = { t: 'move', start: p, orig: new Map(movable.map(m => [m.id, m])), before: docRef.current }; capture() }
      return
    }
    if (target.closest('[data-bg]') && docRef.current.background && !docRef.current.background.locked) {
      drag.current = { t: 'bg', start: p, bg0: docRef.current.background, before: docRef.current }; capture(); return
    }
    if (!e.shiftKey) setSel([])
    drag.current = { t: 'marquee', start: p, cur: p, add: e.shiftKey }; setDragView(drag.current); capture()
  }

  function constrain(a: Pt, b: Pt): Pt {
    const ang = Math.atan2(b.y - a.y, b.x - a.x), step = Math.PI / 4
    const snapped = Math.round(ang / step) * step, len = Math.hypot(b.x - a.x, b.y - a.y)
    return { x: sn(a.x + Math.cos(snapped) * len), y: sn(a.y + Math.sin(snapped) * len) }
  }

  function onPointerMove(e: React.PointerEvent) {
    const p = toWorld(e.clientX, e.clientY)
    if (tool === 'wall' || tool === 'poly') setCursor(wallStart && e.shiftKey && tool === 'wall' ? constrain(wallStart, snapPt(p)) : snapPt(p))
    const d = drag.current; if (!d) return
    const cur = docRef.current
    switch (d.t) {
      case 'pan': setView({ ...d.v0, x: d.v0.x + e.clientX - d.sx, y: d.v0.y + e.clientY - d.sy }); break
      case 'move': {
        const first = d.orig.values().next().value as El
        const dx = sn(first.x + p.x - d.start.x) - first.x, dy = sn(first.y + p.y - d.start.y) - first.y
        setDoc({ ...cur, elements: cur.elements.map(el => { const o = d.orig.get(el.id); return o ? { ...el, x: o.x + dx, y: o.y + dy } : el }) })
        break
      }
      case 'resize': {
        const o = d.el0, a = rad(o.rot)
        const c0 = { x: o.x + o.w / 2, y: o.y + o.h / 2 }
        const dx = p.x - c0.x, dy = p.y - c0.y
        const lx = dx * Math.cos(-a) - dy * Math.sin(-a), ly = dx * Math.sin(-a) + dy * Math.cos(-a)
        const ax = -d.hx * o.w / 2, ay = -d.hy * o.h / 2
        const min = Math.max(4, isLinear(o.kind) ? 4 : g / 2)
        let w = d.hx ? Math.max(min, d.hx * (lx - ax)) : o.w
        let h = d.hy ? Math.max(min, d.hy * (ly - ay)) : o.h
        if (snap && o.rot % 90 === 0) { if (d.hx) w = Math.max(min, sn(w)); if (d.hy) h = Math.max(min, sn(h)) }
        if (d.keepRatio || e.shiftKey) { const r = o.w / o.h; if (d.hx && d.hy) h = w / r; else if (d.hx) h = w / r; else w = h * r }
        const lcx = d.hx ? ax + d.hx * w / 2 : 0, lcy = d.hy ? ay + d.hy * h / 2 : 0
        const cx = c0.x + lcx * Math.cos(a) - lcy * Math.sin(a), cy = c0.y + lcx * Math.sin(a) + lcy * Math.cos(a)
        setDoc({ ...cur, elements: cur.elements.map(el => el.id === d.id ? { ...el, w, h, x: cx - w / 2, y: cy - h / 2 } : el) })
        break
      }
      case 'rotate': {
        const o = d.el0, cx = o.x + o.w / 2, cy = o.y + o.h / 2
        let ang = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90
        if (snap || e.shiftKey) ang = Math.round(ang / 15) * 15
        ang = ((Math.round(ang) % 360) + 360) % 360
        setDoc({ ...cur, elements: cur.elements.map(el => el.id === d.id ? { ...el, rot: ang } : el) })
        break
      }
      case 'bg': {
        const bg = { ...d.bg0, x: Math.round(d.bg0.x + p.x - d.start.x), y: Math.round(d.bg0.y + p.y - d.start.y) }
        setDoc({ ...cur, background: bg }); break
      }
      case 'marquee': d.cur = p; setDragView({ ...d }); break
      case 'room': d.cur = snapPt(p); setDragView({ ...d }); break
    }
  }

  function onPointerUp() {
    const d = drag.current; drag.current = null; setDragView(null)
    if (!d) return
    if (d.t === 'move' || d.t === 'resize' || d.t === 'rotate' || d.t === 'bg') {
      if (docRef.current !== d.before) { past.current.push(d.before); future.current = []; lastKey.current = null; setDirty(true); bump(n => n + 1) }
    } else if (d.t === 'marquee') {
      const x1 = Math.min(d.start.x, d.cur.x), x2 = Math.max(d.start.x, d.cur.x), y1 = Math.min(d.start.y, d.cur.y), y2 = Math.max(d.start.y, d.cur.y)
      if (x2 - x1 < 3 && y2 - y1 < 3) return
      const hit = docRef.current.elements.filter(el => el.x < x2 && el.x + el.w > x1 && el.y < y2 && el.y + el.h > y1).map(el => el.id)
      setSel(ids => d.add ? [...new Set([...ids, ...hit])] : hit)
    } else if (d.t === 'room') {
      const x = Math.min(d.start.x, d.cur.x), y = Math.min(d.start.y, d.cur.y), w = Math.abs(d.cur.x - d.start.x), h = Math.abs(d.cur.y - d.start.y)
      if (w < 10 || h < 10) return
      const base = LIBRARY.find(i => i.key === 'room')!.make()
      addEl({ ...base, id: uid(), x, y, w, h, text: `Room ${docRef.current.elements.filter(el => el.kind === 'room').length + 1}` })
      setTool('select'); focusText()
    }
  }

  function finishPolygon() {
    const pts = polyPts
    setPolyPts([])
    if (pts.length < 3) return
    const xs = pts.map(q => q.x), ys = pts.map(q => q.y)
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y
    if (w < 10 || h < 10) return
    const base = LIBRARY.find(i => i.key === 'room')!.make()
    addEl({ ...base, kind: 'polygon', id: uid(), x, y, w, h, points: pts.map(q => [(q.x - x) / w, (q.y - y) / h] as [number, number]),
      text: `Room ${docRef.current.elements.filter(el => el.kind === 'room' || el.kind === 'polygon').length + 1}`, roomNumber: '' })
    setTool('select'); focusText()
  }

  function onDoubleClick(e: React.MouseEvent) {
    if (!editing) return
    if (tool === 'wall') { setWallStart(null); return }
    if (tool === 'poly') { finishPolygon(); return }
    const hitId = (e.target as Element).closest('[data-id]')?.getAttribute('data-id')
    const el = hitId ? docRef.current.elements.find(x => x.id === hitId) : null
    if (el && hasText(el.kind)) { setSel([el.id]); focusText() }
  }

  // Drop from the sidebar
  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    const raw = e.dataTransfer.getData('application/x-floorplan'); if (!raw) return
    const p = toWorld(e.clientX, e.clientY)
    const data = JSON.parse(raw) as { lib?: string; device?: string }
    if (data.lib) { const item = LIBRARY.find(i => i.key === data.lib); if (item) addFromLib(item, p) }
    if (data.device) { const d = devMap.get(data.device); if (d) addDevice(d, p) }
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typing(e.target)) return
      if (e.key === ' ') { spaceDown.current = true; if (wrapRef.current?.contains(document.activeElement)) e.preventDefault() }
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return }
      if (!wrapRef.current?.contains(document.activeElement)) return
      if (e.key === 'Escape') { setWallStart(null); setPolyPts([]); setSel([]); setPopup(null); setTool('select'); return }
      if (!editing) return
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSel(); return }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSel(docRef.current.elements.map(x => x.id)); return }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSel(); return }
      if (e.key === 'Enter' && tool === 'poly') { finishPolygon(); return }
      const step = e.altKey ? 1 : snap ? docRef.current.grid : 5
      const mv: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
      if (mv[e.key] && sel.length) { e.preventDefault(); const [dx, dy] = mv[e.key]; patchEls(sel, el => el.locked ? el : { ...el, x: el.x + dx, y: el.y + dy }, `nudge:${sel.join()}`); return }
      if (mod) return
      const tools: Record<string, Tool> = { v: 'select', h: 'pan', r: 'room', p: 'poly', w: 'wall', t: 'text' }
      if (tools[e.key.toLowerCase()]) setTool(tools[e.key.toLowerCase()])
    }
    const up = (e: KeyboardEvent) => { if (e.key === ' ') spaceDown.current = false }
    document.addEventListener('keydown', down)
    document.addEventListener('keyup', up)
    return () => { document.removeEventListener('keydown', down); document.removeEventListener('keyup', up) }
  })

  // ── Background image ───────────────────────────────────────────────────────
  const [bgBusy, setBgBusy] = useState(false)
  const [bgErr, setBgErr] = useState('')
  function setBackground(url: string, natW: number, natH: number, path?: string) {
    const d = docRef.current
    const scale = Math.min(d.width / natW, d.height / natH, 1) || 1
    const w = Math.round(natW * scale), h = Math.round(natH * scale)
    commit({ ...d, background: { url, path, x: 0, y: 0, w, h, w0: w, h0: h, opacity: 0.6, locked: true } })
  }
  async function uploadBg(file: File | null) {
    if (!file) return
    setBgErr(''); setBgBusy(true)
    const r = await uploadBackground(file)
    if ('error' in r) { setBgErr(r.error ?? 'Upload failed'); setBgBusy(false); return }
    const img = new window.Image()
    img.onload = () => { setBackground(r.url, img.naturalWidth, img.naturalHeight, r.path); setBgBusy(false) }
    img.onerror = () => { setBgErr('The uploaded image could not be read.'); setBgBusy(false) }
    img.src = r.url
  }
  function removeBg() {
    const bg = docRef.current.background; if (!bg) return
    if (!confirm('Remove the background image from this floor?')) return
    commit({ ...docRef.current, background: null })
    if (bg.path) removeBackgroundFile(bg.path)
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  const contentRef = useRef<SVGGElement>(null)
  const linksRef = useRef<SVGGElement>(null)
  const [exportMsg, setExportMsg] = useState('')
  async function buildSvg(): Promise<string> {
    const d = docRef.current
    let bg = ''
    if (d.background) {
      try {
        const blob = await (await fetch(d.background.url)).blob()
        const dataUrl = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(blob) })
        bg = `<image href="${dataUrl}" x="${d.background.x}" y="${d.background.y}" width="${d.background.w}" height="${d.background.h}" opacity="${d.background.opacity}" preserveAspectRatio="none"/>`
      } catch { setExportMsg('The background image could not be included.') }
    }
    const links = showLinks ? linksRef.current?.innerHTML ?? '' : ''
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}">`
      + `<rect width="${d.width}" height="${d.height}" fill="#ffffff"/>${bg}${links}${contentRef.current?.innerHTML ?? ''}</svg>`
  }
  const fileBase = () => `floorplan-${building}-${current?.floor_name ?? 'floor'}`.replace(/[^\w-]+/g, '_')
  function download(href: string, name: string) { const a = document.createElement('a'); a.href = href; a.download = name; a.click() }
  async function exportAs(kind: 'png' | 'svg' | 'pdf') {
    setExportMsg('')
    const svg = await buildSvg()
    if (kind === 'svg') { const u = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); download(u, `${fileBase()}.svg`); setTimeout(() => URL.revokeObjectURL(u), 2000); return }
    if (kind === 'pdf') {
      const w = window.open('', '_blank'); if (!w) { setExportMsg('Allow pop-ups to print / save as PDF.'); return }
      w.document.write(`<!doctype html><title>${fileBase()}</title><style>@page{size:landscape;margin:10mm}body{margin:0}svg{width:100%;height:auto}</style>${svg}`)
      w.document.close(); w.focus(); setTimeout(() => w.print(), 300); return
    }
    const d = docRef.current
    const scale = Math.min(2, 8000 / Math.max(d.width, d.height))
    const img = new window.Image()
    const u = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = Math.round(d.width * scale); c.height = Math.round(d.height * scale)
      const ctx = c.getContext('2d')!; ctx.scale(scale, scale); ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(u)
      c.toBlob(b => { if (!b) { setExportMsg('PNG export failed.'); return } const bu = URL.createObjectURL(b); download(bu, `${fileBase()}.png`); setTimeout(() => URL.revokeObjectURL(bu), 2000) }, 'image/png')
    }
    img.onerror = () => { URL.revokeObjectURL(u); setExportMsg('PNG export failed.') }
    img.src = u
  }
  const [exportOpen, setExportOpen] = useState(false)

  // ── Buildings and floors ───────────────────────────────────────────────────
  const [floorForm, setFloorForm] = useState<{ no: string; name: string } | null>(null)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const flash = (text: string, ok: boolean) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 5000) }

  async function addBuilding() {
    const name = prompt('New building name')?.replace(/\s+/g, ' ').trim()
    if (!name) return
    if (allBuildings.some(b => b.toLowerCase() === name.toLowerCase())) { await switchFloor(null, allBuildings.find(b => b.toLowerCase() === name.toLowerCase())!); return }
    if (buildingsManaged) {
      const res = await fetch('/api/buildings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { flash(d.error ?? 'Could not add the building', false); return }
      reloadBuildings()
    } else setExtraBuildings(x => [...x, name])
    await switchFloor(null, name)
    setFloorForm({ no: '0', name: floorName(0) })
  }
  async function removeBuilding() {
    if (!building) return
    const fl = floors.length
    if (!confirm(`Delete the floor plans of "${building}"?${fl ? ` Its ${fl} floor design(s) are deleted.` : ''} Devices stay in the inventory.`)) return
    for (const f of floors) { const { error } = await deleteFloor(f.id); if (error) { flash(error.message, false); return } }
    const row = buildings.find(b => b.name === building)
    if (row && confirm(`Also remove "${building}" from the Buildings list? Its devices then show as Unassigned.`)) {
      const res = await fetch(`/api/buildings?id=${encodeURIComponent(row.id)}`, { method: 'DELETE' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) flash(d.error ?? 'Could not delete the building', false); else reloadBuildings()
    }
    setExtraBuildings(x => x.filter(b => b !== building))
    setBuilding(''); setFloorId(null); setDirty(false); reload()
  }
  async function addFloor() {
    if (!floorForm || !building) return
    const no = Math.round(Number(floorForm.no))
    if (!Number.isFinite(no) || no < -10 || no > 200) { flash('Floor number must be between -10 and 200', false); return }
    if (floors.some(f => f.floor_no === no)) { flash(`${building} already has floor ${no}`, false); return }
    const name = floorForm.name.trim() || floorName(no)
    if (dirtyRef.current) await save()
    const { data, error } = await createFloor(building, no, name, who)
    if (error) { flash(error.message, false); return }
    setFloorForm(null); await reload(); setFloorId((data as FloorDesign).id)
  }
  async function renameCurrent(f: FloorDesign) {
    const name = prompt('Floor name', f.floor_name)?.trim()
    if (!name || name === f.floor_name) return
    const { error } = await renameFloor(f.id, name)
    if (error) flash(error.message, false); else reload()
  }
  async function removeFloor(f: FloorDesign) {
    if (!confirm(`Delete "${f.floor_name}" of ${building}? Its drawing and device placements are removed (devices stay in the inventory).`)) return
    const { error } = await deleteFloor(f.id)
    if (error) { flash(error.message, false); return }
    if (f.doc.background?.path) removeBackgroundFile(f.doc.background.path)
    if (f.id === floorId) { setFloorId(null); setDirty(false) }
    reload()
  }

  // ── Sidebar ────────────────────────────────────────────────────────────────
  const [sideTab, setSideTab] = useState<'elements' | 'devices' | 'layers'>('elements')
  const [q, setQ] = useState('')
  const [closedCats, setClosedCats] = useState<string[]>([])
  const [sideOpen, setSideOpen] = useState(false)
  const [propsOpen, setPropsOpen] = useState(false)
  const lib = LIBRARY.filter(i => !q || `${i.label} ${i.keywords ?? ''} ${i.category}`.toLowerCase().includes(q.toLowerCase()))
  const devList = devices.filter(d => !q || [d.name, d.ip, d.type, d.location, d.mac].filter(Boolean).join(' ').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(b.location === building) - Number(a.location === building) || a.name.localeCompare(b.name))

  // ── Device details (popup / properties) ────────────────────────────────────
  const [avail, setAvail] = useState<{ at: number; devices: Record<string, { upMin: number; downMin: number; uptimePct: number | null }> } | null>(null)
  const detailId = popup?.id ?? (one?.kind === 'device' ? one.deviceId : undefined)
  useEffect(() => {
    if (!detailId || (avail && Date.now() - avail.at < 60_000)) return
    fetch('/api/reports/availability?period=24h').then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.devices) setAvail({ at: Date.now(), devices: d.devices }) }).catch(() => {})
  }, [detailId, avail])
  const roomOf = (el: El) => {
    const c = { x: el.x + el.w / 2, y: el.y + el.h / 2 }
    const r = [...doc.elements].reverse().find(x => isRoomLike(x) && !x.hidden && x.id !== el.id && contains(x, c))
    return r ? [r.text, r.roomNumber].filter(Boolean).join(' · ') || 'Unnamed room' : null
  }
  const [devMsg, setDevMsg] = useState('')
  async function setDeviceBuilding(d: Device) {
    if (!confirm(`Set the building of "${d.name}" to "${building}"? (Its Building / Location in the inventory changes.)`)) return
    const { error } = await supabase.from('devices').update({ location: building }).eq('id', d.id)
    setDevMsg(error ? error.message : `Building set to ${building}`); loadDevices()
    setTimeout(() => setDevMsg(''), 4000)
  }

  function deviceDetails(d: Device | undefined, el?: El) {
    if (!d) return <div className={s.note}>This device is no longer in the inventory. Remove the marker, or link the symbol to another device.</div>
    const st = statusOf(d)
    const a = avail?.devices[d.id]
    const room = el ? roomOf(el) : null
    const rows: [string, React.ReactNode][] = [
      ['IP address', <span key="ip" className="mono">{d.ip}</span>],
      ['MAC', d.mac ? <span key="mac" className="mono">{d.mac}</span> : '—'],
      ['Category', d.type],
      ['Status', <span key="st" style={{ color: st.color, fontWeight: 600 }}>● {st.label}</span>],
      ['Building', d.location || 'Unassigned'],
      ['Room', room ?? '—'],
      ['Last seen', d.last_seen ? `${new Date(d.last_seen).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${ago(d.last_seen)})` : '—'],
      ['Last 24 h', a ? (a.uptimePct == null ? 'not measured' : `up ${fmtMin(a.upMin)} · down ${fmtMin(a.downMin)} (${a.uptimePct}%)`) : '…'],
    ]
    return (
      <dl className={s.popupBody}>
        {rows.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
    )
  }

  // ── Rendering helpers ──────────────────────────────────────────────────────
  const z = view.zoom
  // Drawing order: shapes and rooms by layer, device markers always on top; hidden layers skipped
  const elsOnFloor = useMemo(() => drawOrder(doc.elements).filter(e => !e.hidden), [doc.elements])
  const deviceEls = useMemo(() => new Map(elsOnFloor.filter(e => e.kind === 'device' && e.deviceId).map(e => [e.deviceId!, e])), [elsOnFloor])
  const links = useMemo(() => {
    const out: { id: string; a: El; b: El }[] = []
    for (const [devId, el] of deviceEls) {
      const parent = devMap.get(devId)?.parent_id
      const pel = parent ? deviceEls.get(parent) : undefined
      if (pel) out.push({ id: `${devId}-${parent}`, a: el, b: pel })
    }
    return out
  }, [deviceEls, devMap])
  const statusCounts = useMemo(() => {
    const c = { online: 0, warning: 0, offline: 0, other: 0 }
    for (const id of deviceEls.keys()) {
      const l = statusOf(devMap.get(id)).label
      if (l === 'Online') c.online++; else if (l === 'Warning') c.warning++; else if (l === 'Offline') c.offline++; else c.other++
    }
    return c
  }, [deviceEls, devMap])

  const hint = !editing ? (current ? 'View mode — drag to pan, Ctrl + scroll to zoom, click a device for details' : '')
    : tool === 'room' ? 'Drag to draw a room'
    : tool === 'poly' ? `Click to add corners${polyPts.length ? ` (${polyPts.length})` : ''} — double-click or Enter to finish, Esc to cancel`
    : tool === 'wall' ? (wallStart ? 'Click to end this wall and start the next — double-click or Esc to stop · Shift: 45° steps' : 'Click where the wall starts')
    : tool === 'text' ? 'Click where the text goes'
    : tool === 'pan' ? 'Drag to move around the floor'
    : ''

  // ── UI ─────────────────────────────────────────────────────────────────────
  if (ready === false) {
    return (
      <div className="card"><div className="card-body" style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>
        The floor plan designer needs its table. Run <span className="mono">supabase/migration_floor_designs.sql</span> in the Supabase SQL Editor, then reload this page.
        Uploaded floor plans and rooms keep working in <strong>Uploaded plans &amp; rooms</strong>.
      </div></div>
    )
  }

  const toolBtn = (t: Tool, label: string, keyHint: string, icon: React.ReactNode) => (
    <button key={t} type="button" className={`${s.tool} ${tool === t ? s.toolOn : ''}`} onClick={() => setTool(t)} title={`${label} (${keyHint})`} aria-pressed={tool === t} disabled={!editing}>
      {icon}<span className={s.toolLabel}>{label}</span>
    </button>
  )
  const I = (d: string) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>

  const saveLabel = !current ? '' : !canEdit ? 'View only'
    : saveState === 'saving' ? 'Saving…'
    : saveState === 'conflict' ? 'Not saved — changed elsewhere'
    : saveState === 'error' ? 'Not saved'
    : dirty ? 'Unsaved changes'
    : savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'All changes saved'
  const saveColor = saveState === 'error' || saveState === 'conflict' ? 'var(--crit)' : dirty || saveState === 'saving' ? 'var(--warn)' : 'var(--ok)'

  return (
    <div className={s.wrap}>
      {/* ── Top toolbar ── */}
      <div className={s.toolbar}>
        <button type="button" className={`${s.tool} ${s.panelToggle}`} onClick={() => { setSideOpen(o => !o); setPropsOpen(false) }} aria-expanded={sideOpen}>☰<span className={s.toolLabel}> Library</span></button>
        {editing && <>
          <div className={s.group}>
            {toolBtn('select', 'Select', 'V', I('M4 3l7 17 2-7 7-2z'))}
            {toolBtn('pan', 'Move', 'H, or Space + drag', I('M12 2v20 M2 12h20 M12 2l-3 3 M12 2l3 3 M12 22l-3-3 M12 22l3-3 M2 12l3-3 M2 12l3 3 M22 12l-3-3 M22 12l-3 3'))}
            {toolBtn('room', 'Room', 'R', I('M3 3h18v18H3z M3 9h7 M14 9h7'))}
            {toolBtn('poly', 'Shape room', 'P', I('M5 4l14 2 2 12-9 3-9-6z'))}
            {toolBtn('wall', 'Wall', 'W', I('M3 12h18 M3 9h18 M3 15h18'))}
            {toolBtn('text', 'Text', 'T', I('M4 6V4h16v2 M12 4v16 M9 20h6'))}
            <button type="button" className={`${s.tool} ${sideTab === 'devices' ? s.toolOn : ''}`} onClick={() => { setSideTab('devices'); setSideOpen(true) }} title="Add a device from the inventory">
              {I('M4 6h16v10H4z M8 20h8 M12 16v4')}<span className={s.toolLabel}>Device</span>
            </button>
          </div>
          <div className={s.group}>
            <button type="button" className={s.tool} onClick={undo} disabled={!past.current.length} title="Undo (Ctrl+Z)">{I('M9 14L4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-3')}</button>
            <button type="button" className={s.tool} onClick={redo} disabled={!future.current.length} title="Redo (Ctrl+Y)">{I('M15 14l5-5-5-5 M20 9H9a5 5 0 0 0 0 10h3')}</button>
          </div>
        </>}
        <div className={s.group}>
          <button type="button" className={s.tool} onClick={() => zoomAt(1 / 1.2)} title="Zoom out">{I('M5 12h14')}</button>
          <span className={s.zoomText}>{Math.round(z * 100)}%</span>
          <button type="button" className={s.tool} onClick={() => zoomAt(1.2)} title="Zoom in">{I('M12 5v14 M5 12h14')}</button>
          <button type="button" className={s.tool} onClick={fit} title="Fit to canvas">{I('M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5')}<span className={s.toolLabel}>Fit</span></button>
        </div>
        {editing && (
          <label className={s.status} style={{ cursor: 'pointer' }} title="Snap positions and sizes to the grid">
            <input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)} /> Snap
          </label>
        )}
        <label className={s.status} style={{ cursor: 'pointer' }} title="Lines between devices that the topology records as connected">
          <input type="checkbox" checked={showLinks} onChange={e => setShowLinks(e.target.checked)} /> Connections
        </label>
        <div className={s.spacer} />
        {current && <span className={s.status} title={saveState === 'error' ? saveErr : undefined}><span className={s.statusDot} style={{ background: saveColor }} />{saveLabel}</span>}
        {editing && <button type="button" className="btn btn-sm btn-primary" onClick={() => save()} disabled={!dirty || saveState === 'saving'}>Save</button>}
        <div style={{ position: 'relative' }}>
          <button type="button" className="btn btn-sm" onClick={() => setExportOpen(o => !o)} disabled={!current} aria-expanded={exportOpen}>Export ▾</button>
          {exportOpen && (
            <div className="card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 20, minWidth: 170, padding: 4 }} onMouseLeave={() => setExportOpen(false)}>
              {([['png', 'PNG image'], ['svg', 'SVG drawing'], ['pdf', 'Print / save as PDF']] as const).map(([k, l]) => (
                <button key={k} type="button" className={s.tool} style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => { setExportOpen(false); exportAs(k) }}>{l}</button>
              ))}
            </div>
          )}
        </div>
        {canEdit && (
          <div className={s.modeSwitch} role="group" aria-label="Mode">
            {(['edit', 'view'] as const).map(m => (
              <button key={m} type="button" className={`${s.modeBtn} ${mode === m ? s.modeBtnOn : ''}`} onClick={() => { setMode(m); setSel([]); setTool('select'); setPopup(null) }}>
                {m === 'edit' ? 'Edit' : 'View'}
              </button>
            ))}
          </div>
        )}
        {editing && <button type="button" className={`${s.tool} ${s.panelToggle}`} onClick={() => { setPropsOpen(o => !o); setSideOpen(false) }} aria-expanded={propsOpen}>⚙<span className={s.toolLabel}> Properties</span></button>}
      </div>

      {saveState === 'conflict' && (
        <div className={s.banner}>
          <strong style={{ color: 'var(--warn)' }}>Someone else saved this floor while you were editing.</strong>
          <button type="button" className="btn btn-sm" onClick={() => resolveConflict(false)}>Load their version</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => resolveConflict(true)}>Keep mine and save</button>
        </div>
      )}
      {exportMsg && <div className={s.banner}>{exportMsg}</div>}

      <div className={`${s.body} ${editing ? '' : s.bodyView}`}>
        {/* ── Left sidebar ── */}
        <aside className={`${s.side} ${sideOpen ? s.sideOpen : ''}`} aria-label="Buildings, elements and devices">
          <div className={s.sideSection}>
            <div className={s.sideTitle}>
              Building
              {editMode && <button type="button" className={s.mini} onClick={addBuilding} title="Add a building" style={{ color: 'var(--accent2)', fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>+ Add</button>}
              {editMode && building && <button type="button" className={s.mini} onClick={removeBuilding} title="Delete this building's floor plans">🗑</button>}
            </div>
            <select className={s.search} value={building} onChange={e => switchFloor(null, e.target.value)} aria-label="Building">
              {!allBuildings.length && <option value="">No buildings yet</option>}
              {allBuildings.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
            <div className={s.sideTitle} style={{ marginTop: 10 }}>
              Floors
              {editMode && building && <button type="button" className={s.mini} onClick={() => setFloorForm({ no: String(floors.length ? Math.max(...floors.map(f => f.floor_no)) + 1 : 0), name: '' })} title="Add a floor" style={{ color: 'var(--accent2)', fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>+ Add floor</button>}
            </div>
            {floors.map(f => (
              <div key={f.id} className={`${s.floorRow} ${f.id === floorId ? s.floorRowOn : ''}`} onClick={() => f.id !== floorId && switchFloor(f.id)} role="button" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter') switchFloor(f.id) }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.floor_name}</span>
                <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>{f.doc.elements.filter(e => e.kind === 'device').length || ''}</span>
                {editMode && <button type="button" className={s.mini} onClick={ev => { ev.stopPropagation(); renameCurrent(f) }} title="Rename">✎</button>}
                {editMode && <button type="button" className={s.mini} onClick={ev => { ev.stopPropagation(); removeFloor(f) }} title="Delete floor">🗑</button>}
              </div>
            ))}
            {!floors.length && building && <div style={{ fontSize: 12, color: 'var(--text3)', padding: '2px 0' }}>No floors yet{editMode ? ' — press “+ Add floor”.' : '.'}</div>}
            {floorForm && (
              <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 6, marginTop: 6 }}>
                <input className={s.search} type="number" min={-10} max={200} value={floorForm.no} aria-label="Floor number" title="0 = ground floor, -1 = basement"
                  onChange={e => setFloorForm({ ...floorForm, no: e.target.value })} />
                <input className={s.search} placeholder={floorName(Number(floorForm.no) || 0)} value={floorForm.name} aria-label="Floor name" autoFocus
                  onChange={e => setFloorForm({ ...floorForm, name: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') addFloor(); if (e.key === 'Escape') setFloorForm(null) }} />
                <button type="button" className="btn btn-sm" onClick={() => setFloorForm(null)}>Cancel</button>
                <button type="button" className="btn btn-sm btn-primary" onClick={addFloor}>Add floor</button>
              </div>
            )}
            {msg && <div style={{ fontSize: 12, marginTop: 6, color: msg.ok ? 'var(--ok)' : 'var(--crit)' }}>{msg.text}</div>}
          </div>

          <div className={s.tabs} role="tablist">
            {editing && <button type="button" role="tab" aria-selected={sideTab === 'elements'} className={`${s.tab} ${sideTab === 'elements' ? s.tabOn : ''}`} onClick={() => setSideTab('elements')}>Elements</button>}
            <button type="button" role="tab" aria-selected={sideTab === 'devices' || !editing} className={`${s.tab} ${sideTab === 'devices' || !editing ? s.tabOn : ''}`} onClick={() => setSideTab('devices')}>Devices</button>
            {editing && <button type="button" role="tab" aria-selected={sideTab === 'layers'} className={`${s.tab} ${sideTab === 'layers' ? s.tabOn : ''}`} onClick={() => setSideTab('layers')}>Layers</button>}
          </div>
          <div className={s.sideSection} style={{ borderBottom: 0, paddingBottom: 6 }}>
            <input className={s.search} placeholder={!editing || sideTab === 'devices' ? 'Search devices…' : sideTab === 'layers' ? 'Search layers…' : 'Search shapes and elements…'} value={q} onChange={e => setQ(e.target.value)} aria-label="Search" />
          </div>
          <div className={s.scroll}>
            {editing && sideTab === 'layers' ? renderLayers() : editing && sideTab === 'elements' ? CATEGORIES.map(cat => {
              const items = lib.filter(i => i.category === cat)
              if (!items.length) return null
              const closed = closedCats.includes(cat) && !q
              return (
                <div key={cat} className={s.cat}>
                  <button type="button" className={s.catHead} aria-expanded={!closed} onClick={() => setClosedCats(c => c.includes(cat) ? c.filter(x => x !== cat) : [...c, cat])}>
                    {cat}<span>{closed ? '▸' : '▾'}</span>
                  </button>
                  {!closed && (
                    <div className={s.grid}>
                      {items.map(item => (
                        <div key={item.key} className={s.item} draggable={!!current} title={`Drag onto the floor, or click to add “${item.label}”`}
                          onDragStart={e => { e.dataTransfer.setData('application/x-floorplan', JSON.stringify({ lib: item.key })); e.dataTransfer.effectAllowed = 'copy' }}
                          onClick={() => { if (current) { addFromLib(item); setSideOpen(false) } }}>
                          <Thumb item={item} />{item.label}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            }) : (
              <>
                {editing && <div className={s.note}>Drag a device onto the floor (or click it). Markers point to the device in the inventory — nothing is copied.</div>}
                {devList.map(d => {
                  const st = statusOf(d)
                  const here = deviceEls.has(d.id)
                  const elsewhere = (placedOn.get(d.id) ?? []).filter(f => f.id !== current?.id)
                  return (
                    <div key={d.id} className={s.devRow} draggable={editing && !here}
                      onDragStart={e => { e.dataTransfer.setData('application/x-floorplan', JSON.stringify({ device: d.id })); e.dataTransfer.effectAllowed = 'copy' }}
                      onClick={() => { if (here) { const el = deviceEls.get(d.id)!; setSel([el.id]); centerOn(el) } else if (editing && current) addDevice(d); setSideOpen(false) }}
                      title={here ? 'On this floor — click to find it' : elsewhere.length ? `Placed on ${elsewhere.map(f => `${f.building} ${f.floor_name}`).join(', ')}` : undefined}>
                      <span className={s.devDot} style={{ background: st.color }} title={st.label} />
                      <span style={{ color: 'var(--text2)', display: 'inline-flex' }}><Icon k={iconForType(d.type)} size={16} /></span>
                      <span style={{ minWidth: 0 }}>
                        <div className={s.devName}>{d.name}</div>
                        <div className={s.devMeta}>{d.ip} · {d.type}{d.location && d.location !== 'Unassigned' ? ` · ${d.location}` : ''}</div>
                      </span>
                      {here ? <span className={s.badge}>On this floor</span>
                        : elsewhere.length ? <span className={s.badge} style={{ color: 'var(--warn)', background: 'rgba(217,119,6,.10)' }} title={`Placed on ${whereText(elsewhere)} — dropping it here moves it`}>
                          {elsewhere.length > 1 ? `On ${elsewhere.length} floors` : `${elsewhere[0].building === building ? elsewhere[0].floor_name : elsewhere[0].building}`}
                        </span> : null}
                    </div>
                  )
                })}
                {!devList.length && <div className={s.note}>No devices match.</div>}
              </>
            )}
          </div>
        </aside>

        {/* ── Canvas ── */}
        <div ref={wrapRef} className={s.canvasWrap} tabIndex={0} aria-label="Floor plan canvas"
          onPointerDown={current ? onPointerDown : undefined} onPointerMove={current ? onPointerMove : undefined} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick} onDragOver={e => { if (editing) e.preventDefault() }} onDrop={editing ? onDrop : undefined}
          onContextMenu={e => { if (tool === 'wall' || tool === 'poly') { e.preventDefault(); setWallStart(null); if (tool === 'poly') finishPolygon() } }}
          style={{ cursor: !current ? 'default' : drag.current?.t === 'pan' ? 'grabbing' : !editing || tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair' }}>
          {current ? (
            <svg className={s.svg}>
              <defs>
                <pattern id={`g${gridId}`} width={g} height={g} patternUnits="userSpaceOnUse">
                  <path d={`M ${g} 0 L 0 0 0 ${g}`} fill="none" stroke="#e3ece6" strokeWidth={1 / z} />
                </pattern>
                <pattern id={`G${gridId}`} width={g * 5} height={g * 5} patternUnits="userSpaceOnUse">
                  <rect width={g * 5} height={g * 5} fill={`url(#g${gridId})`} />
                  <path d={`M ${g * 5} 0 L 0 0 0 ${g * 5}`} fill="none" stroke="#cfded4" strokeWidth={1.2 / z} />
                </pattern>
              </defs>
              <g transform={`translate(${view.x} ${view.y}) scale(${z})`}>
                <rect width={doc.width} height={doc.height} fill="#ffffff" stroke="#b8d4c4" strokeWidth={1 / z} />
                {doc.background && (
                  // eslint-disable-next-line jsx-a11y/alt-text
                  <image href={doc.background.url} x={doc.background.x} y={doc.background.y} width={doc.background.w} height={doc.background.h}
                    opacity={doc.background.opacity} preserveAspectRatio="none" data-bg="1"
                    style={{ pointerEvents: editing && tool === 'select' && !doc.background.locked ? 'all' : 'none', cursor: editing && !doc.background.locked ? 'move' : undefined }} />
                )}
                {editing && <rect width={doc.width} height={doc.height} fill={`url(#G${gridId})`} style={{ pointerEvents: 'none' }} />}

                <g ref={linksRef} style={{ pointerEvents: 'none' }}>
                  {showLinks && links.map(l => (
                    <line key={l.id} x1={l.a.x + l.a.w / 2} y1={l.a.y + l.a.h / 2} x2={l.b.x + l.b.w / 2} y2={l.b.y + l.b.h / 2}
                      stroke="#0891b2" strokeWidth={2.5} strokeDasharray="8 5" strokeLinecap="round" opacity={0.75} />
                  ))}
                </g>

                <g ref={contentRef} style={{ pointerEvents: 'none' }}>
                  {elsOnFloor.map(el => <MemoElement key={el.id} el={el} dev={el.deviceId ? devMap.get(el.deviceId) : undefined} />)}
                </g>

                {/* Hit areas (also make thin lines easy to grab) */}
                <g style={{ pointerEvents: editing ? (tool === 'select' ? 'auto' : 'none') : 'auto' }}>
                  {elsOnFloor.map(el => {
                    if (!editing && el.kind !== 'device') return null
                    const pad = isLinear(el.kind) ? Math.max(0, 10 / z - el.h) / 2 : 0
                    const extra = el.kind === 'device' || el.kind === 'sym' ? 26 : 0
                    return (
                      <g key={el.id} data-id={el.id} transform={el.rot ? `rotate(${el.rot} ${el.x + el.w / 2} ${el.y + el.h / 2})` : undefined}
                        style={{ cursor: !editing ? 'pointer' : el.locked ? 'default' : 'move' }}>
                        <rect x={el.x} y={el.y - pad} width={el.w} height={el.h + pad * 2 + extra} fill="transparent" />
                      </g>
                    )
                  })}
                </g>

                {/* Selection */}
                {editing && selected.map(el => (
                  <g key={el.id} transform={el.rot ? `rotate(${el.rot} ${el.x + el.w / 2} ${el.y + el.h / 2})` : undefined} style={{ pointerEvents: 'none' }}>
                    <rect x={el.x} y={el.y} width={el.w} height={el.h} fill="none" stroke={el.locked ? '#8a9a90' : '#16a34a'} strokeWidth={1.5 / z} strokeDasharray={`${5 / z} ${3 / z}`} />
                  </g>
                ))}
                {editing && one && !one.locked && tool === 'select' && (() => {
                  const hs = 9 / z, el = one
                  const cx = el.x + el.w / 2, cy = el.y + el.h / 2
                  const pts: [number, number][] = isLinear(el.kind) ? [[-1, 0], [1, 0]]
                    : [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]
                  const cursorOf = (hx: number, hy: number) => {
                    const ang = ((Math.atan2(hy, hx) * 180) / Math.PI + el.rot + 360) % 180
                    return ang < 22.5 || ang >= 157.5 ? 'ew-resize' : ang < 67.5 ? 'nwse-resize' : ang < 112.5 ? 'ns-resize' : 'nesw-resize'
                  }
                  return (
                    <g transform={el.rot ? `rotate(${el.rot} ${cx} ${cy})` : undefined}>
                      {!isLinear(el.kind) && <line x1={cx} y1={el.y} x2={cx} y2={el.y - 26 / z} stroke="#16a34a" strokeWidth={1.5 / z} style={{ pointerEvents: 'none' }} />}
                      <circle data-handle="rot" cx={isLinear(el.kind) ? cx : cx} cy={isLinear(el.kind) ? el.y - 18 / z : el.y - 26 / z} r={6 / z}
                        fill="#ffffff" stroke="#16a34a" strokeWidth={1.5 / z} style={{ cursor: 'grab' }} />
                      {pts.map(([hx, hy]) => (
                        <rect key={`${hx},${hy}`} data-handle={`${hx},${hy}`} x={cx + hx * el.w / 2 - hs / 2} y={cy + hy * el.h / 2 - hs / 2} width={hs} height={hs}
                          rx={2 / z} fill="#ffffff" stroke="#16a34a" strokeWidth={1.5 / z} style={{ cursor: cursorOf(hx, hy) }} />
                      ))}
                    </g>
                  )
                })()}

                {/* Drawing previews */}
                {dragView?.t === 'marquee' && (
                  <rect x={Math.min(dragView.start.x, dragView.cur.x)} y={Math.min(dragView.start.y, dragView.cur.y)}
                    width={Math.abs(dragView.cur.x - dragView.start.x)} height={Math.abs(dragView.cur.y - dragView.start.y)}
                    fill="rgba(22,163,74,.08)" stroke="#16a34a" strokeWidth={1 / z} strokeDasharray={`${4 / z} ${3 / z}`} />
                )}
                {dragView?.t === 'room' && (
                  <rect x={Math.min(dragView.start.x, dragView.cur.x)} y={Math.min(dragView.start.y, dragView.cur.y)}
                    width={Math.abs(dragView.cur.x - dragView.start.x)} height={Math.abs(dragView.cur.y - dragView.start.y)}
                    fill="rgba(22,163,74,.08)" stroke="#3d5a47" strokeWidth={3} />
                )}
                {tool === 'wall' && wallStart && cursor && (
                  <line x1={wallStart.x} y1={wallStart.y} x2={cursor.x} y2={cursor.y} stroke="#3d4a42" strokeOpacity={0.6} strokeWidth={wallThick} strokeLinecap="square" />
                )}
                {tool === 'wall' && wallStart && cursor && (
                  <text x={(wallStart.x + cursor.x) / 2} y={(wallStart.y + cursor.y) / 2 - wallThick} textAnchor="middle" fontSize={12 / z} fill="#15803d" fontFamily="Inter, sans-serif">
                    {Math.round(Math.hypot(cursor.x - wallStart.x, cursor.y - wallStart.y))}
                  </text>
                )}
                {tool === 'poly' && polyPts.length > 0 && (
                  <>
                    <polyline points={[...polyPts, ...(cursor ? [cursor] : [])].map(q => `${q.x},${q.y}`).join(' ')} fill="rgba(22,163,74,.08)" stroke="#3d5a47" strokeWidth={2 / z} />
                    {polyPts.map((q, i) => <circle key={i} cx={q.x} cy={q.y} r={4 / z} fill="#16a34a" />)}
                  </>
                )}
              </g>
            </svg>
          ) : (
            <div className={s.empty}>
              {!building ? 'Add a building to start drawing floor plans.'
                : `${building} has no floors yet.${editMode ? ' Press “+ Add floor” on the left to add one (e.g. Ground Floor).' : ''}`}
            </div>
          )}
          {hint && current && <div className={s.hint}>{hint}</div>}

          {current && (
            <div className={s.legend} aria-label="Device status legend">
              <span><i style={{ background: STATUS_COLOR.online }} />Online {statusCounts.online || ''}</span>
              <span><i style={{ background: STATUS_COLOR.warning }} />Warning {statusCounts.warning || ''}</span>
              <span><i style={{ background: STATUS_COLOR.offline }} />Offline {statusCounts.offline || ''}</span>
              <span><i style={{ background: STATUS_COLOR.other }} />Not checked {statusCounts.other || ''}</span>
              {showLinks && links.length > 0 && <span><i style={{ background: '#0891b2', borderRadius: 2, height: 3, width: 14 }} />Connection</span>}
            </div>
          )}

          {popup && (() => {
            const d = devMap.get(popup.id)
            const el = deviceEls.get(popup.id)
            const r = wrapRef.current?.getBoundingClientRect()
            const left = clamp(popup.x + 14, 8, (r?.width ?? 400) - 290)
            const top = clamp(popup.y - 20, 8, Math.max(8, (r?.height ?? 400) - 330))
            return (
              <div className={s.popup} style={{ left, top }} onPointerDown={e => e.stopPropagation()} role="dialog" aria-label="Device details">
                <div className={s.popupHead}>
                  <span style={{ color: 'var(--text2)', display: 'inline-flex' }}><Icon k={iconForType(d?.type)} /></span>
                  <strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d?.name ?? 'Device removed'}</strong>
                  <button type="button" className={s.mini} onClick={() => setPopup(null)} aria-label="Close">✕</button>
                </div>
                {deviceDetails(d, el)}
                <div className={s.popupFoot}>
                  <Link href="/devices" className="btn btn-sm">Devices</Link>
                  <Link href="/reports" className="btn btn-sm">Uptime report</Link>
                </div>
              </div>
            )
          })()}
        </div>

        {/* ── Right properties panel ── */}
        {editing && (
          <aside className={`${s.props} ${propsOpen ? s.propsOpen : ''}`} aria-label="Properties">
            {one ? (
              renderElementProps(one)
            ) : selected.length > 1 ? (
              <>
                <div className={s.propHead}>{selected.length} elements selected</div>
                <div className={s.propBtns}>
                  <button type="button" className="btn btn-sm" onClick={duplicateSel}>Duplicate</button>
                  <button type="button" className="btn btn-sm" onClick={() => reorder(true)}>Bring to front</button>
                  <button type="button" className="btn btn-sm" onClick={() => reorder(false)}>Send to back</button>
                  <button type="button" className="btn btn-sm" onClick={() => patchEls(sel, e => ({ ...e, locked: !selected.every(x => x.locked) }))}>
                    {selected.every(x => x.locked) ? 'Unlock' : 'Lock'}
                  </button>
                  <button type="button" className="btn btn-sm" style={{ color: 'var(--crit)' }} onClick={removeSel}>Delete</button>
                </div>
                <div className={s.note}>Drag any of them to move them together. Shift + click adds or removes one.</div>
              </>
            ) : (
              renderCanvasProps()
            )}
          </aside>
        )}
      </div>
    </div>
  )

  // ── Properties: one element ────────────────────────────────────────────────
  function renderElementProps(el: El) {
    const set = (patch: Partial<El>, field: string) => patchEls([el.id], e => ({ ...e, ...patch }), `${el.id}:${field}`)
    const num = (v: string, fallback: number) => { const n = Number(v); return Number.isFinite(n) ? n : fallback }
    const linear = isLinear(el.kind)
    const d = el.deviceId ? devMap.get(el.deviceId) : undefined
    const isRoom = el.kind === 'room' || (el.kind === 'polygon' && el.roomNumber !== undefined)
    return (
      <>
        <div className={s.propHead}>
          {KIND_LABEL[el.kind]}
          {el.kind === 'device' && d && <span className={s.propSub}>{d.name}</span>}
        </div>

        {el.kind === 'device' && (
          <div className={s.propGroup}>
            {deviceDetails(d, el)}
            {d && building && d.location !== building && (
              <div className={s.warnNote}>
                In the inventory this device&apos;s building is <strong>{d.location || 'Unassigned'}</strong>.
                <div style={{ marginTop: 6 }}><button type="button" className="btn btn-sm" onClick={() => setDeviceBuilding(d)}>Set building to {building}</button></div>
              </div>
            )}
            {devMsg && <div className={s.note} style={{ color: 'var(--ok)' }}>{devMsg}</div>}
            <div className={s.note}>The room comes from the room shape the marker sits in. Removing the marker does not delete the device.</div>
          </div>
        )}

        {el.kind === 'sym' && (
          <div className={s.propGroup}>
            <div className={s.propGroupTitle}>Device</div>
            <div className={s.field}><span>Icon</span>
              <select className={s.input} value={el.icon ?? 'other'} onChange={e => set({ icon: e.target.value as IconKey }, 'icon')}>
                {Object.keys(ICON_PATHS).map(k => <option key={k} value={k}>{k === 'ap' ? 'access point' : k === 'cctv' ? 'CCTV' : k}</option>)}
              </select>
            </div>
            <div className={s.field}><span>Link to</span>
              <select className={s.input} value="" onChange={e => {
                const dev = devMap.get(e.target.value); if (!dev) return
                if (deviceEls.has(dev.id) || placedElsewhere(dev.id).length) { alert(`${dev.name} is already placed — drag it from the Devices list to move it here.`); return }
                const size = Math.max(DEVICE_SIZE, Math.min(el.w, el.h))
                patchEls([el.id], x => ({ ...x, kind: 'device', deviceId: dev.id, icon: undefined, text: undefined, w: size, h: size, x: x.x + x.w / 2 - size / 2, y: x.y + x.h / 2 - size / 2, rot: 0 }))
              }}>
                <option value="">Choose a device from the inventory…</option>
                {devices.filter(x => !deviceEls.has(x.id) && !placedElsewhere(x.id).length).map(x => <option key={x.id} value={x.id}>{x.name} ({x.ip})</option>)}
              </select>
            </div>
            <div className={s.note}>Linked symbols show the device&apos;s name, IP and live status.</div>
          </div>
        )}

        {(hasText(el.kind) || isRoom) && (
          <div className={s.propGroup}>
            <div className={s.propGroupTitle}>{isRoom ? 'Room' : 'Text'}</div>
            <div className={s.field}><span>{isRoom ? 'Room name' : el.kind === 'sym' ? 'Label' : 'Text'}</span>
              {el.kind === 'note' || el.kind === 'text'
                ? <textarea ref={r => { textInput.current = r }} className={s.input} rows={3} value={el.text ?? ''} onChange={e => set({ text: e.target.value }, 'text')} />
                : <input ref={r => { textInput.current = r }} className={s.input} value={el.text ?? ''} onChange={e => set({ text: e.target.value }, 'text')} />}
            </div>
            {isRoom && (
              <div className={s.field}><span>Room no.</span>
                <input className={s.input} value={el.roomNumber ?? ''} placeholder="e.g. 101" onChange={e => set({ roomNumber: e.target.value }, 'roomNumber')} />
              </div>
            )}
            <div className={s.field}><span>Font size</span>
              <input className={s.input} type="number" min={6} max={120} value={el.fontSize ?? 14} onChange={e => set({ fontSize: clamp(num(e.target.value, 14), 6, 120) }, 'fontSize')} />
            </div>
            {!isRoom && el.kind !== 'sym' && (
              <div className={s.field}><span>Align</span>
                <select className={s.input} value={el.align ?? 'center'} onChange={e => set({ align: e.target.value as El['align'] }, 'align')}>
                  <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
                </select>
              </div>
            )}
            <div className={s.field}><span>Text color</span>
              <input className={s.color} type="color" value={toHex(el.textColor, '#0f2318')} onChange={e => set({ textColor: e.target.value }, 'textColor')} />
            </div>
          </div>
        )}

        <div className={s.propGroup}>
          <div className={s.propGroupTitle}>Position and size</div>
          <div className={s.field2}><span>X / Y</span>
            <input className={s.input} type="number" value={Math.round(el.x)} onChange={e => set({ x: num(e.target.value, el.x) }, 'x')} aria-label="X" />
            <input className={s.input} type="number" value={Math.round(el.y)} onChange={e => set({ y: num(e.target.value, el.y) }, 'y')} aria-label="Y" />
          </div>
          <div className={s.field2}><span>{linear ? 'Length / thick' : 'W / H'}</span>
            <input className={s.input} type="number" min={4} value={Math.round(el.w)} onChange={e => { const w = Math.max(4, num(e.target.value, el.w)); set({ w, x: el.x + (el.w - w) / 2 }, 'w') }} aria-label="Width" />
            <input className={s.input} type="number" min={2} value={Math.round(el.h)} onChange={e => { const h = Math.max(2, num(e.target.value, el.h)); set({ h, y: el.y + (el.h - h) / 2 }, 'h') }} aria-label="Height" />
          </div>
          <div className={s.field}><span>Rotation</span>
            <input className={s.input} type="number" min={-360} max={360} value={Math.round(el.rot)} onChange={e => set({ rot: ((num(e.target.value, 0) % 360) + 360) % 360 }, 'rot')} />
          </div>
        </div>

        {el.kind !== 'device' && (
          <div className={s.propGroup}>
            <div className={s.propGroupTitle}>Style</div>
            {!['line', 'arrow', 'door'].includes(el.kind) && (
              <div className={s.field}><span>Fill</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input className={s.color} type="color" value={toHex(el.fill, '#e8f3ec')} onChange={e => set({ fill: e.target.value }, 'fill')} disabled={el.fill === 'transparent'} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap', fontSize: 11 }}>
                    <input type="checkbox" checked={el.fill === 'transparent'} onChange={e => set({ fill: e.target.checked ? 'transparent' : '#e8f3ec' }, 'fillNone')} />None
                  </label>
                </div>
              </div>
            )}
            {el.kind !== 'wall' || el.stroke !== 'transparent' ? (
              <div className={s.field}><span>{['line', 'arrow'].includes(el.kind) ? 'Color' : 'Border'}</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input className={s.color} type="color" value={toHex(el.stroke, '#3d5a47')} onChange={e => set({ stroke: e.target.value }, 'stroke')} disabled={el.stroke === 'transparent'} />
                  {!['line', 'arrow'].includes(el.kind) && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap', fontSize: 11 }}>
                      <input type="checkbox" checked={el.stroke === 'transparent'} onChange={e => set({ stroke: e.target.checked ? 'transparent' : '#3d5a47', strokeW: e.target.checked ? 0 : Math.max(1, el.strokeW) }, 'strokeNone')} />None
                    </label>
                  )}
                </div>
              </div>
            ) : null}
            <div className={s.field}><span>{['line', 'arrow'].includes(el.kind) ? 'Thickness' : 'Border px'}</span>
              <input className={s.input} type="number" min={0} max={40} step={0.5} value={el.strokeW} onChange={e => set({ strokeW: clamp(num(e.target.value, 1), 0, 40) }, 'strokeW')} />
            </div>
            <div className={s.field}><span>Opacity</span>
              <input type="range" min={0.1} max={1} step={0.05} value={el.opacity} onChange={e => set({ opacity: Number(e.target.value) }, 'opacity')} aria-label="Opacity" />
            </div>
          </div>
        )}

        <div className={s.propBtns}>
          <label className={s.status} style={{ cursor: 'pointer', width: '100%' }}>
            <input type="checkbox" checked={!!el.locked} onChange={e => patchEls([el.id], x => ({ ...x, locked: e.target.checked }))} /> Lock (can&apos;t be moved or deleted)
          </label>
          {el.kind !== 'device' && <button type="button" className="btn btn-sm" onClick={duplicateSel}>Duplicate</button>}
          <button type="button" className="btn btn-sm" onClick={() => reorder(true)} title="To the front of its layer group">Front</button>
          <button type="button" className="btn btn-sm" onClick={() => stepLayer(el.id, true)} title="One layer forward">Forward</button>
          <button type="button" className="btn btn-sm" onClick={() => stepLayer(el.id, false)} title="One layer backward">Backward</button>
          <button type="button" className="btn btn-sm" onClick={() => reorder(false)} title="To the back of its layer group">Back</button>
          <button type="button" className="btn btn-sm" style={{ color: 'var(--crit)' }} disabled={el.locked} onClick={removeSel}>
            {el.kind === 'device' ? 'Remove marker' : 'Delete'}
          </button>
        </div>
      </>
    )
  }

  // ── Layers: front at the top. Devices always sit above shapes and rooms. ────
  function renderLayers() {
    const nameOf = (e: El) => e.kind === 'device'
      ? (e.deviceId && devMap.get(e.deviceId)?.name) || 'Device removed'
      : [e.text, e.roomNumber].filter(Boolean).join(' · ') || KIND_LABEL[e.kind]
    const match = (e: El) => !q || `${nameOf(e)} ${KIND_LABEL[e.kind]}`.toLowerCase().includes(q.toLowerCase())
    const front = [...drawOrder(doc.elements)].reverse()
    const groups: [string, El[]][] = [
      ['Devices — always in front', front.filter(e => e.kind === 'device' && match(e))],
      ['Rooms, shapes and labels', front.filter(e => e.kind !== 'device' && match(e))],
    ]
    const iconBtn = (label: string, on: boolean, onClick: () => void, glyph: string) => (
      <button type="button" className={s.mini} title={label} aria-label={label} aria-pressed={on}
        onClick={ev => { ev.stopPropagation(); onClick() }} style={{ opacity: 1, color: on ? 'var(--accent2)' : 'var(--text3)' }}>{glyph}</button>
    )
    return (
      <>
        <div className={s.note}>Top of the list = in front. Click to select (Shift + click for several).</div>
        {groups.map(([title, list]) => (
          <div key={title} className={s.cat}>
            <div className={s.catHead} style={{ cursor: 'default' }}>{title}<span>{list.length}</span></div>
            {list.map((e, i) => {
              const d = e.kind === 'device' && e.deviceId ? devMap.get(e.deviceId) : undefined
              const on = sel.includes(e.id)
              return (
                <div key={e.id} className={`${s.floorRow} ${on ? s.floorRowOn : ''}`} style={{ margin: '1px 6px', opacity: e.hidden ? .5 : 1 }}
                  onClick={ev => {
                    if (ev.shiftKey) setSel(ids => ids.includes(e.id) ? ids.filter(x => x !== e.id) : [...ids, e.id])
                    else { setSel([e.id]); if (!e.hidden) centerOn(e) }
                  }}>
                  {d ? <span className={s.devDot} style={{ background: statusOf(d).color }} /> : <span style={{ width: 9 }} />}
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={nameOf(e)}>
                    {nameOf(e)}<span style={{ color: 'var(--text3)', fontSize: 10.5 }}> · {KIND_LABEL[e.kind]}</span>
                  </span>
                  <button type="button" className={s.mini} style={{ opacity: 1 }} title="Forward" aria-label="Move forward" disabled={i === 0}
                    onClick={ev => { ev.stopPropagation(); stepLayer(e.id, true) }}>▲</button>
                  <button type="button" className={s.mini} style={{ opacity: 1 }} title="Backward" aria-label="Move backward" disabled={i === list.length - 1}
                    onClick={ev => { ev.stopPropagation(); stepLayer(e.id, false) }}>▼</button>
                  {iconBtn(e.hidden ? 'Show' : 'Hide', !e.hidden, () => { toggleFlag(e.id, 'hidden'); if (!e.hidden) setSel(ids => ids.filter(x => x !== e.id)) }, e.hidden ? '◌' : '◉')}
                  {iconBtn(e.locked ? 'Unlock' : 'Lock', !!e.locked, () => toggleFlag(e.id, 'locked'), e.locked ? '🔒' : '🔓')}
                </div>
              )
            })}
            {!list.length && <div className={s.note}>{q ? 'No match.' : 'None on this floor.'}</div>}
          </div>
        ))}
      </>
    )
  }

  // ── Properties: nothing selected → the floor and canvas ────────────────────
  function renderCanvasProps() {
    if (!current) return <div className={s.note} style={{ padding: 14 }}>Choose or add a floor to start.</div>
    const bg = doc.background
    const setDocKey = (patch: Partial<DesignDoc>, key: string) => commit({ ...docRef.current, ...patch }, { key })
    const setBg = (patch: Partial<Background>, key: string) => bg && commit({ ...docRef.current, background: { ...bg, ...patch } }, { key: `bg:${key}` })
    const buildingPlans = [...plans].sort((a, b) => Number(b.building === building) - Number(a.building === building) || a.building.localeCompare(b.building) || a.floor - b.floor)
    return (
      <>
        <div className={s.propHead}>{current.floor_name}<span className={s.propSub}>{building}</span></div>
        <div className={s.propGroup}>
          <div className={s.propGroupTitle}>Canvas</div>
          <div className={s.field2}><span>W / H</span>
            <input className={s.input} type="number" min={400} max={20000} value={doc.width} onChange={e => setDocKey({ width: clamp(Number(e.target.value) || doc.width, 400, 20000) }, 'cw')} aria-label="Canvas width" />
            <input className={s.input} type="number" min={300} max={20000} value={doc.height} onChange={e => setDocKey({ height: clamp(Number(e.target.value) || doc.height, 300, 20000) }, 'ch')} aria-label="Canvas height" />
          </div>
          <div className={s.field}><span>Grid</span>
            <select className={s.input} value={doc.grid} onChange={e => setDocKey({ grid: Number(e.target.value) }, 'grid')}>
              {[5, 10, 20, 25, 40, 50].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className={s.field}><span>Wall width</span>
            <input className={s.input} type="number" min={2} max={60} value={wallThick} onChange={e => setWallThick(clamp(Number(e.target.value) || 12, 2, 60))} title="Thickness of new walls drawn with the Wall tool" />
          </div>
        </div>

        <div className={s.propGroup}>
          <div className={s.propGroupTitle}>Background image (optional)</div>
          {!bg ? (
            <>
              <div className={s.field}><span>Upload</span>
                <input type="file" accept="image/png,image/jpeg,image/webp" disabled={bgBusy} onChange={e => uploadBg(e.target.files?.[0] ?? null)} style={{ fontSize: 11.5, minWidth: 0 }} />
              </div>
              {buildingPlans.length > 0 && (
                <div className={s.field}><span>Or use</span>
                  <select className={s.input} value="" onChange={e => { const p = plans.find(x => x.id === e.target.value); if (p) setBackground(planImageUrl(p.image_path), p.width, p.height) }}>
                    <option value="">An uploaded floor plan…</option>
                    {buildingPlans.map(p => <option key={p.id} value={p.id}>{p.building} — {floorLabel(p.floor)}</option>)}
                  </select>
                </div>
              )}
              {bgBusy && <div className={s.note}>Uploading…</div>}
              <div className={s.note}>Trace over an existing drawing, or leave empty and draw from scratch.</div>
            </>
          ) : (
            <>
              <div className={s.field2}><span>X / Y</span>
                <input className={s.input} type="number" value={bg.x} disabled={bg.locked} onChange={e => setBg({ x: Number(e.target.value) || 0 }, 'x')} aria-label="Background X" />
                <input className={s.input} type="number" value={bg.y} disabled={bg.locked} onChange={e => setBg({ y: Number(e.target.value) || 0 }, 'y')} aria-label="Background Y" />
              </div>
              <div className={s.field}><span>Scale</span>
                <input type="range" min={10} max={300} step={5} disabled={bg.locked} value={Math.round((bg.w / Math.max(1, bg.w0 ?? bg.w)) * 100)}
                  onChange={e => { const f = Number(e.target.value) / 100, w0 = bg.w0 ?? bg.w, h0 = bg.h0 ?? bg.h; setBg({ w0, h0, w: Math.round(w0 * f), h: Math.round(h0 * f) }, 'scale') }} aria-label="Background scale" />
              </div>
              <div className={s.field}><span>Opacity</span>
                <input type="range" min={0.1} max={1} step={0.05} value={bg.opacity} onChange={e => setBg({ opacity: Number(e.target.value) }, 'op')} aria-label="Background opacity" />
              </div>
              <label className={s.field} style={{ cursor: 'pointer' }}><span>Lock</span>
                <span><input type="checkbox" checked={bg.locked} onChange={e => setBg({ locked: e.target.checked }, 'lock')} /> {bg.locked ? 'Locked — draw over it' : 'Unlocked — drag it on the canvas'}</span>
              </label>
              <div className={s.propBtns}>
                <label className="btn btn-sm" style={{ cursor: 'pointer' }}>Replace…
                  <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => { const old = bg.path; uploadBg(e.target.files?.[0] ?? null); if (old) removeBackgroundFile(old) }} />
                </label>
                <button type="button" className="btn btn-sm" style={{ color: 'var(--crit)' }} onClick={removeBg}>Remove</button>
              </div>
            </>
          )}
          {bgErr && <div className={s.errNote}>{bgErr}</div>}
        </div>

        <div className={s.propGroup}>
          <div className={s.propGroupTitle}>Floor</div>
          <div className={s.note}>
            {doc.elements.length} element{doc.elements.length === 1 ? '' : 's'} · {deviceEls.size} device{deviceEls.size === 1 ? '' : 's'}
            {current.updated_by && <><br />Last saved by {current.updated_by}, {new Date(current.updated_at).toLocaleString()}</>}
          </div>
          <div className={s.propBtns}>
            <button type="button" className="btn btn-sm" onClick={() => renameCurrent(current)}>Rename floor</button>
            <button type="button" className="btn btn-sm" onClick={clearCanvas} disabled={!doc.elements.length}>Clear canvas</button>
            <button type="button" className="btn btn-sm" style={{ color: 'var(--crit)' }} onClick={() => removeFloor(current)}>Delete floor</button>
          </div>
        </div>
        <div className={s.note}>
          <strong>Tips:</strong> drag items from the left onto the grid · Shift + click or drag a box to select several · Ctrl + scroll to zoom, scroll or Space + drag to move ·
          Delete removes · Ctrl + Z / Ctrl + Y undo / redo · Ctrl + D duplicates · arrow keys nudge. Changes save automatically.
        </div>
      </>
    )
  }
}
