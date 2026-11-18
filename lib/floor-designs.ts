'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

// Floor plan designer data (supabase/migration_floor_designs.sql).
// One design per building floor; the drawing is a JSON document.

export type ElKind =
  // basic shapes
  | 'rect' | 'square' | 'circle' | 'ellipse' | 'triangle' | 'polygon' | 'line' | 'arrow'
  // floor plan
  | 'wall' | 'room' | 'door' | 'window' | 'corridor' | 'stairs' | 'elevator' | 'entrance' | 'exit'
  // network / campus symbols (not tied to a device until linked)
  | 'sym'
  // a real device from the inventory (devices.id)
  | 'device'
  // labels and annotations
  | 'text' | 'roomName' | 'roomNumber' | 'floorLabel' | 'buildingName' | 'note' | 'legend'

// Symbol icons (also used for device markers, by device type)
export type IconKey = 'router' | 'switch' | 'ap' | 'server' | 'computer' | 'rack' | 'cctv' | 'printer' | 'firewall' | 'other'

// Every element is a box (x, y = top-left, w × h, in canvas units) rotated
// by `rot` degrees around its centre. Walls, lines and arrows are boxes too:
// length = w, thickness = h.
export interface El {
  id: string
  kind: ElKind
  x: number; y: number; w: number; h: number
  rot: number
  fill: string
  stroke: string
  strokeW: number
  opacity: number          // 0–1
  text?: string            // label / room name / note text
  fontSize?: number
  align?: 'left' | 'center' | 'right'
  textColor?: string
  roomNumber?: string      // rooms
  points?: [number, number][]   // polygon: corners as fractions (0–1) of the box
  icon?: IconKey           // 'sym'
  deviceId?: string        // 'device' → devices.id
  locked?: boolean
  hidden?: boolean         // Layers panel: not drawn (kept in the design)
}

export interface Background {
  url: string              // public image URL (floor-plans bucket)
  path?: string            // object path, when uploaded from the designer
  x: number; y: number; w: number; h: number
  w0?: number; h0?: number // size when added (the Scale slider is relative to it)
  opacity: number
  locked: boolean
}

export interface DesignDoc {
  width: number            // workspace size (canvas units)
  height: number
  grid: number             // grid step
  background: Background | null
  elements: El[]
}

export interface FloorDesign {
  id: string
  building: string
  floor_no: number
  floor_name: string
  doc: DesignDoc
  version: number
  updated_by: string | null
  updated_at: string
}

// Drawing order: shapes, rooms and labels in their layer order, then every
// device marker on top — a room can never cover a device
export function drawOrder(elements: El[]): El[] {
  return [...elements.filter(e => e.kind !== 'device'), ...elements.filter(e => e.kind === 'device')]
}

export const EMPTY_DOC: DesignDoc = { width: 2000, height: 1200, grid: 20, background: null, elements: [] }

// A stored doc with any missing fields filled in (older or partial saves)
export function normalizeDoc(d: Partial<DesignDoc> | null | undefined): DesignDoc {
  return {
    width: Number(d?.width) > 0 ? Number(d!.width) : EMPTY_DOC.width,
    height: Number(d?.height) > 0 ? Number(d!.height) : EMPTY_DOC.height,
    grid: Number(d?.grid) > 0 ? Number(d!.grid) : EMPTY_DOC.grid,
    background: d?.background ?? null,
    elements: Array.isArray(d?.elements) ? d!.elements : [],
  }
}

export const floorName = (n: number) =>
  n === 0 ? 'Ground Floor' : n < 0 ? `Basement ${-n}`
    : `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'} Floor`

// All designs (small: one row per floor), kept current. `ready` = the table exists.
export function useFloorDesigns() {
  const [designs, setDesigns] = useState<FloorDesign[]>([])
  const [ready, setReady] = useState<boolean | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('floor_designs')
      .select('id, building, floor_no, floor_name, doc, version, updated_by, updated_at')
      .order('building').order('floor_no')
    if (error) { setReady(false); setDesigns([]); return }
    setReady(true)
    setDesigns(((data ?? []) as FloorDesign[]).map(r => ({ ...r, doc: normalizeDoc(r.doc) })))
  }, [])

  useEffect(() => {
    load()
    const ch = supabase.channel(`floor-designs-rt-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'floor_designs' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  return { designs, ready, reload: load }
}

export async function createFloor(building: string, floor_no: number, floor_name: string, by: string) {
  return supabase.from('floor_designs')
    .insert({ building, floor_no, floor_name, doc: EMPTY_DOC, updated_by: by })
    .select('id, building, floor_no, floor_name, doc, version, updated_by, updated_at').single()
}

export async function renameFloor(id: string, floor_name: string) {
  return supabase.from('floor_designs').update({ floor_name }).eq('id', id)
}

export async function deleteFloor(id: string) {
  return supabase.from('floor_designs').delete().eq('id', id)
}

// Save only if nobody saved in between (version check).
// → { ok, version } or { ok: false, conflict: true } / { ok: false, error }
export async function saveDesign(id: string, doc: DesignDoc, version: number, by: string) {
  const { data, error } = await supabase.from('floor_designs')
    .update({ doc, version: version + 1, updated_by: by, updated_at: new Date().toISOString() })
    .eq('id', id).eq('version', version)
    .select('version')
  if (error) return { ok: false as const, error: error.message }
  if (!data?.length) return { ok: false as const, conflict: true }
  return { ok: true as const, version: (data[0] as { version: number }).version }
}

// Background images go to the existing floor-plans bucket (PNG / JPG / WebP, ≤ 10 MB)
export async function uploadBackground(file: File) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return { error: 'Use a PNG, JPG or WebP image.' }
  if (file.size > 10 * 1024 * 1024) return { error: 'The image is larger than 10 MB.' }
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
  const path = `designs/${crypto.randomUUID()}.${ext}`
  const up = await supabase.storage.from('floor-plans').upload(path, file, { contentType: file.type, upsert: false })
  if (up.error) return { error: `Upload failed: ${up.error.message}` }
  return { path, url: supabase.storage.from('floor-plans').getPublicUrl(path).data.publicUrl }
}

export async function removeBackgroundFile(path: string) {
  await supabase.storage.from('floor-plans').remove([path]).then(() => {}, () => {})
}
