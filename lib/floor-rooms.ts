'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import type { Device } from '@/lib/database.types'

// Floor plan rooms (managed in Settings → Manage). Falls back to the original
// built-in rooms until supabase/migration_floor_rooms.sql has been run.

export interface FloorRoom {
  id: string
  building: string
  floor: number
  label: string
  x: number          // position of the room name on the floor drawing
  y: number
  vertical: boolean
  plan_id?: string | null   // uploaded floor plan it's on; empty = IC Building's built-in drawing
}

// An uploaded floor plan (supabase/migration_floor_plans.sql)
export interface FloorPlan {
  id: string
  building: string          // matches devices.location
  floor: number
  image_path: string        // object in the floor-plans storage bucket
  width: number             // image size in pixels — room positions are in these units
  height: number
  created_at?: string
}

// One floor that can be drawn: a built-in IC Building drawing or an uploaded plan
export interface FloorSheet {
  key: string
  building: string
  floor: number
  planId: string | null
  builtin: 1 | 2 | null     // which built-in drawing (IC Building)
  imageUrl: string | null   // uploaded drawing
  vbW: number
  vbH: number
}

export const FLOOR_VIEWBOX: Record<1 | 2, [number, number]> = { 1: [920, 520], 2: [1020, 520] }

// Which device locations are shown on the IC Building floor plans
export const FLOORPLAN_BUILDING = /ic.?build|building.?a/i
export const IC_BUILDING = 'IC Building'

export const floorLabel = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'} Floor`

const sameBuilding = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

export const planImageUrl = (path: string) =>
  supabase.storage.from('floor-plans').getPublicUrl(path).data.publicUrl

const BUILTIN_SHEETS: FloorSheet[] = ([1, 2] as const).map(f => ({
  key: `builtin-${f}`, building: IC_BUILDING, floor: f, planId: null, builtin: f, imageUrl: null,
  vbW: FLOOR_VIEWBOX[f][0], vbH: FLOOR_VIEWBOX[f][1],
}))

export function planSheet(p: FloorPlan): FloorSheet {
  return { key: p.id, building: p.building, floor: p.floor, planId: p.id, builtin: null, imageUrl: planImageUrl(p.image_path), vbW: p.width, vbH: p.height }
}

// Every floor that can be drawn: IC Building's built-in floors, then uploaded plans by building and floor
export function allSheets(plans: FloorPlan[]): FloorSheet[] {
  const up = [...plans].sort((a, b) => a.building.localeCompare(b.building) || a.floor - b.floor).map(planSheet)
  return [...BUILTIN_SHEETS, ...up]
}

// Floors of the building a device location refers to
export function sheetsForLocation(location: string | null | undefined, plans: FloorPlan[]): FloorSheet[] {
  if (!location) return []
  const builtins = FLOORPLAN_BUILDING.test(location) ? BUILTIN_SHEETS : []
  const up = plans.filter(p => sameBuilding(p.building, location)).sort((a, b) => a.floor - b.floor).map(planSheet)
  // An uploaded plan for a built-in floor of the IC Building replaces that drawing
  return [...builtins.filter(b => !up.some(u => u.floor === b.floor && FLOORPLAN_BUILDING.test(u.building))), ...up]
}

export function roomsOfSheet(rooms: FloorRoom[], sheet: FloorSheet): FloorRoom[] {
  return rooms.filter(r => sheet.planId ? r.plan_id === sheet.planId : (!r.plan_id && r.floor === sheet.floor))
}

// Rooms of the building a device location refers to
export function roomsForLocation(location: string | null | undefined, rooms: FloorRoom[], plans: FloorPlan[]): FloorRoom[] {
  return sheetsForLocation(location, plans).flatMap(s => roomsOfSheet(rooms, s))
}

// Loads uploaded floor plans and keeps them current. `managed` = the table exists.
export function useFloorPlans() {
  const [plans, setPlans] = useState<FloorPlan[]>([])
  const [managed, setManaged] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('floor_plans').select('*').order('building').order('floor')
    if (error) { setPlans([]); setManaged(false); return }
    setPlans((data ?? []) as FloorPlan[])
    setManaged(true)
  }, [])

  useEffect(() => {
    load()
    // A unique name per use: several components can use this hook at once
    const ch = supabase.channel(`floor-plans-rt-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'floor_plans' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  return { plans, plansManaged: managed, reloadPlans: load }
}

export const DEFAULT_ROOMS: FloorRoom[] = [
  { id: 'faculty1',   building: 'IC Building', floor: 1, label: 'Faculty 1',          x: 187, y: 122, vertical: false },
  { id: 'accred',     building: 'IC Building', floor: 1, label: 'Accreditation Room', x: 477, y: 123, vertical: false },
  { id: 'netlab',     building: 'IC Building', floor: 1, label: 'Netlab',             x: 750, y: 122, vertical: false },
  { id: 'faculty2',   building: 'IC Building', floor: 1, label: 'Faculty 2',          x: 165, y: 372, vertical: false },
  { id: 'comlab1',    building: 'IC Building', floor: 1, label: 'Comlab 1',           x: 595, y: 372, vertical: false },
  { id: 'maclab',     building: 'IC Building', floor: 2, label: 'MacLab',             x: 195, y: 122, vertical: false },
  { id: 'aes',        building: 'IC Building', floor: 2, label: 'AES',                x: 475, y: 122, vertical: false },
  { id: 'gda',        building: 'IC Building', floor: 2, label: 'GDA',                x: 690, y: 122, vertical: false },
  { id: 'faculty3',   building: 'IC Building', floor: 2, label: 'Faculty 3',          x: 890, y: 250, vertical: true  },
  { id: 'serverroom', building: 'IC Building', floor: 2, label: 'Server Room',        x: 150, y: 371, vertical: false },
  { id: 'comlab2',    building: 'IC Building', floor: 2, label: 'Comlab 2',           x: 530, y: 372, vertical: false },
]

// Loads rooms and keeps them current. `managed` = rooms come from the database.
export function useFloorRooms() {
  const [rooms, setRooms] = useState<FloorRoom[]>(DEFAULT_ROOMS)
  const [managed, setManaged] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('floor_rooms').select('*').order('floor').order('label')
    if (error) { setRooms(DEFAULT_ROOMS); setManaged(false); return }
    setRooms((data ?? []) as FloorRoom[])
    setManaged(true)
  }, [])

  useEffect(() => {
    load()
    // A unique name per use: several components can use this hook at once
    const ch = supabase.channel(`floor-rooms-rt-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'floor_rooms' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  return { rooms, managed, reload: load }
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

// The room a device is in: its assigned room first; otherwise a device whose
// name contains the room name (e.g. "NETLAB-AP1", "Comlab 1 PC-05").
export function roomOfDevice(d: Device, rooms: FloorRoom[]): FloorRoom | null {
  const rid = (d as Device & { room_id?: string | null }).room_id
  if (rid) return rooms.find(r => r.id === rid) ?? null
  const name = compact(d.name)
  // Longest room names first so "Comlab 1" doesn't grab "Comlab 12"-style names wrongly
  const byLen = [...rooms].sort((a, b) => compact(b.label).length - compact(a.label).length)
  return byLen.find(r => compact(r.label).length >= 3 && name.includes(compact(r.label))) ?? null
}

// Room names are drawn from the database, so remove the ones baked into the drawings
export function stripRoomLabels(svg: string) {
  return svg.replace(/<text[^>]*dominant-baseline="middle" fill="#111"[^>]*>[^<]*<\/text>/g, '')
}
