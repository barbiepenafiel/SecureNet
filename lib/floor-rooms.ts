'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import type { Device } from '@/lib/database.types'

// Floor plan rooms (managed in Settings → Manage). Falls back to the original
// built-in rooms until supabase/migration_floor_rooms.sql has been run.

export interface FloorRoom {
  id: string
  building: string
  floor: 1 | 2
  label: string
  x: number          // position of the room name on the floor drawing
  y: number
  vertical: boolean
}

export const FLOOR_VIEWBOX: Record<1 | 2, [number, number]> = { 1: [920, 520], 2: [1020, 520] }

// Which device locations are shown on the IC Building floor plans
export const FLOORPLAN_BUILDING = /ic.?build|building.?a/i

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
    const ch = supabase.channel('floor-rooms-rt')
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
