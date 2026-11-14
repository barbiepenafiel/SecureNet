'use client'

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import type { Device, ScanResult } from '@/lib/database.types'
import { supabase } from '@/lib/supabase'
import TopologyCanvas from './TopologyCanvas'
import TopologyLinks from './TopologyLinks'
import { useFloorRooms, roomOfDevice, stripRoomLabels, FLOOR_VIEWBOX, type FloorRoom } from '@/lib/floor-rooms'

type ViewMode = 'buildings' | 'tree' | 'links' | 'floormap' | 'realtime'

type BldgGroup = {
  name: string
  total: number
  online: number
  warn: number
  devices: Device[]
  hasFloorPlan: boolean
  imageUrl: string
}

function sc(s: string) {
  return s === 'up' ? '#22c55e' : s === 'warn' ? '#f59e0b' : s === 'down' ? '#ef4444' : '#94a3b8'
}

function bldgBorder(g: BldgGroup) {
  if (g.online === g.total && g.total > 0) return '#22c55e'
  if (g.online === 0 && g.total > 0) return '#ef4444'
  return '#f59e0b'
}

function getBldgImage(name: string) {
  if (/ic.?build/i.test(name)) return '/images/ic-building.png'
  return '/images/unknown.png'
}

// ─── Floor plan rooms + overlay ───────────────────────────────────────────────
// Rooms come from Settings → Manage (lib/floor-rooms.ts). Room names and the
// device markers are drawn in the floor drawing's own coordinates, so they
// stay in place at any size.

const FP_STATUS: Record<string, { color: string; label: string }> = {
  up:          { color: '#16a34a', label: 'Online' },
  warn:        { color: '#d97706', label: 'Warning' },
  unreachable: { color: '#f59e0b', label: 'Unreachable' },
  down:        { color: '#dc2626', label: 'Offline' },
  unknown:     { color: '#94a3b8', label: 'Unknown' },
  maint:       { color: '#7c3aed', label: 'Maintenance' },
}
const fpSt = (s: string) => FP_STATUS[s] ?? FP_STATUS.unknown
const isLive = (d: Device) => d.status === 'up' || d.status === 'warn'

function roomHealth(devs: Device[]) {
  const live = devs.filter(isLive).length
  if (!devs.length) return '#94a3b8'
  if (live === devs.length && !devs.some(d => d.status === 'warn')) return '#16a34a'
  if (live === 0) return '#dc2626'
  return '#d97706'
}

function devicesByRoom(rooms: FloorRoom[], devices: Device[]) {
  const map: Record<string, Device[]> = {}
  rooms.forEach(r => { map[r.id] = [] })
  for (const d of devices) {
    const r = roomOfDevice(d, rooms)
    if (r && map[r.id]) map[r.id].push(d)
  }
  return map
}

// Room name, split onto two lines when long (e.g. "Accreditation / Room")
export function RoomLabel({ room, color = '#111' }: { room: FloorRoom; color?: string }) {
  const text = room.label.toUpperCase()
  const words = text.split(' ')
  const lines = text.length > 12 && words.length > 1
    ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')]
    : [text]
  const size = lines.length > 1 ? 14 : 16
  return (
    <text x={room.x} y={room.y - (lines.length - 1) * 9} textAnchor="middle" dominantBaseline="middle"
      fontFamily="Arial,Helvetica,sans-serif" fontSize={size} fontWeight="bold" fill={color}
      transform={room.vertical ? `rotate(-90,${room.x},${room.y})` : undefined} style={{ pointerEvents: 'none' }}>
      {lines.map((l, i) => <tspan key={i} x={room.x} dy={i ? 18 : 0}>{l}</tspan>)}
    </text>
  )
}

function FloorOverlay({ rooms, byRoom, vbW, vbH, focus, showDevices, onHover }: {
  rooms: FloorRoom[]
  byRoom: Record<string, Device[]>
  vbW: number; vbH: number
  focus: string | null
  showDevices: boolean
  onHover: (room: FloorRoom | null, e?: React.MouseEvent) => void
}) {
  return (
    <svg viewBox={`0 0 ${vbW} ${vbH}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
      <style>{`
        @keyframes fp-ring { 0% { opacity: .55; transform: scale(1); } 100% { opacity: 0; transform: scale(1.35); } }
        .fp-ring { transform-box: fill-box; transform-origin: center; animation: fp-ring 1.4s ease-out infinite; }
        @media (prefers-reduced-motion: reduce) { .fp-ring { animation: none; } }
      `}</style>
      {rooms.map(r => <RoomLabel key={`label-${r.id}`} room={r}/>)}
      {showDevices && rooms.map(r => {
        const devs = byRoom[r.id] ?? []
        if (!devs.length) return null
        const color = roomHealth(devs)
        const shown = devs.slice(0, 6)
        const dotsW = shown.length * 13
        const text = `${devs.filter(isLive).length}/${devs.length}`
        const w = 18 + dotsW + text.length * 7 + 8
        const x = r.x - w / 2, y = r.y + (r.vertical ? 60 : 30)
        const focused = focus === r.id
        return (
          <g key={r.id} style={{ cursor: 'pointer' }}
            onMouseMove={e => onHover(r, e)} onMouseLeave={() => onHover(null)}>
            {focused && <rect className="fp-ring" x={x - 4} y={y - 4} width={w + 8} height={30} rx="15" fill="none" stroke={color} strokeWidth="3"/>}
            <rect x={x} y={y} width={w} height="22" rx="11" fill="white" stroke={color} strokeWidth={focused ? 2.5 : 1.5}
              style={{ filter: 'drop-shadow(0 2px 4px rgba(15,23,42,.18))' }}/>
            {shown.map((d, i) => (
              <circle key={d.id} cx={x + 14 + i * 13} cy={y + 11} r="4.5" fill={fpSt(d.status).color}/>
            ))}
            <text x={x + 14 + dotsW + 2} y={y + 15.5} fontSize="12" fontWeight="700" fill={color}>{text}</text>
          </g>
        )
      })}
    </svg>
  )
}

// ─── IC Building Floor Plan ───────────────────────────────────────────────────

export const FLOOR_1_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 920 520">
  <rect width="920" height="520" fill="#c8c8c8"/>
  <rect x="30" y="30" width="860" height="440" fill="white"/>
  <rect x="30" y="215" width="860" height="60" fill="#efefef"/>
  <rect x="300" y="275" width="90" height="195" fill="#e2e2e2"/>
  <rect x="800" y="275" width="90" height="195" fill="#e2e2e2"/>
  <line x1="30"  y1="215" x2="890" y2="215" stroke="#111" stroke-width="5"/>
  <line x1="30"  y1="275" x2="890" y2="275" stroke="#111" stroke-width="5"/>
  <line x1="345" y1="30"  x2="345" y2="215" stroke="#111" stroke-width="5"/>
  <line x1="610" y1="30"  x2="610" y2="215" stroke="#111" stroke-width="5"/>
  <line x1="300" y1="275" x2="300" y2="470" stroke="#111" stroke-width="5"/>
  <line x1="390" y1="275" x2="390" y2="470" stroke="#111" stroke-width="5"/>
  <line x1="800" y1="275" x2="800" y2="470" stroke="#111" stroke-width="5"/>
  <rect x="30" y="30" width="860" height="440" fill="none" stroke="#111" stroke-width="11"/>
  <rect x="300" y="212" width="40" height="6" fill="white"/>
  <rect x="337" y="175" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 300 215 A 40 40 0 0 1 340 175" fill="none" stroke="#111" stroke-width="1.5"/>
  <rect x="350" y="212" width="40" height="6" fill="white"/>
  <rect x="350" y="175" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 390 215 A 40 40 0 0 0 350 175" fill="none" stroke="#111" stroke-width="1.5"/>
  <rect x="540" y="212" width="40" height="6" fill="white"/>
  <rect x="540" y="175" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 580 215 A 40 40 0 0 0 540 175" fill="none" stroke="#111" stroke-width="1.5"/>
  <rect x="795" y="212" width="40" height="6" fill="white"/>
  <rect x="795" y="175" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 835 215 A 40 40 0 0 0 795 175" fill="none" stroke="#111" stroke-width="1.5"/>
  <rect x="215" y="272" width="40" height="6" fill="white"/>
  <rect x="215" y="275" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 255 275 A 40 40 0 0 1 215 315" fill="none" stroke="#111" stroke-width="1.5"/>
  <rect x="405" y="272" width="40" height="6" fill="white"/>
  <rect x="405" y="275" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 445 275 A 40 40 0 0 1 405 315" fill="none" stroke="#111" stroke-width="1.5"/>
  <rect x="755" y="272" width="40" height="6" fill="white"/>
  <rect x="755" y="275" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 795 275 A 40 40 0 0 1 755 315" fill="none" stroke="#111" stroke-width="1.5"/>
  <line x1="315" y1="278" x2="315" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="330" y1="278" x2="330" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="345" y1="278" x2="345" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="360" y1="278" x2="360" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="375" y1="278" x2="375" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <polygon points="345,330 340,342 350,342" fill="#888"/>
  <line x1="345" y1="342" x2="345" y2="400" stroke="#888" stroke-width="1.5"/>
  <polygon points="345,410 340,398 350,398" fill="#888"/>
  <line x1="815" y1="278" x2="815" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="830" y1="278" x2="830" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="845" y1="278" x2="845" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="860" y1="278" x2="860" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="875" y1="278" x2="875" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <polygon points="845,330 840,342 850,342" fill="#888"/>
  <line x1="845" y1="342" x2="845" y2="400" stroke="#888" stroke-width="1.5"/>
  <polygon points="845,410 840,398 850,398" fill="#888"/>
  <text x="460" y="245" font-family="Arial,Helvetica,sans-serif" font-size="13" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#888">Hallway</text>
  <text x="187" y="122" font-family="Arial,Helvetica,sans-serif" font-size="16" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#111">FACULTY 1</text>
  <text x="477" y="114" font-family="Arial,Helvetica,sans-serif" font-size="14" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#111">ACCREDITATION</text>
  <text x="477" y="132" font-family="Arial,Helvetica,sans-serif" font-size="14" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#111">ROOM</text>
  <text x="750" y="122" font-family="Arial,Helvetica,sans-serif" font-size="16" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#111">NETLAB</text>
  <text x="165" y="372" font-family="Arial,Helvetica,sans-serif" font-size="16" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#111">FACULTY 2</text>
  <text x="345" y="372" font-family="Arial,Helvetica,sans-serif" font-size="11" text-anchor="middle" dominant-baseline="middle" fill="#555" transform="rotate(-90,345,372)">S T A I R S</text>
  <text x="595" y="372" font-family="Arial,Helvetica,sans-serif" font-size="16" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#111">COMLAB 1</text>
  <text x="845" y="372" font-family="Arial,Helvetica,sans-serif" font-size="11" text-anchor="middle" dominant-baseline="middle" fill="#555" transform="rotate(-90,845,372)">S T A I R S</text>
  <text x="460" y="488" font-family="Arial,Helvetica,sans-serif" font-size="17" font-weight="bold" text-anchor="middle" fill="#111">GROUND FLOOR PLAN</text>
  <text x="460" y="508" font-family="Arial,Helvetica,sans-serif" font-size="12" text-anchor="middle" fill="#555">IC BUILDING — DNSC</text>
</svg>`

export const FLOOR_2_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1020 520">
  <rect width="1020" height="520" fill="#c8c8c8"/>
  <rect x="30" y="30" width="960" height="440" fill="white"/>
  <rect x="30" y="215" width="760" height="60" fill="#efefef"/>
  <rect x="270" y="275" width="90" height="195" fill="#e2e2e2"/>
  <rect x="700" y="275" width="90" height="195" fill="#e2e2e2"/>
  <line x1="790" y1="30"  x2="790" y2="470" stroke="#111" stroke-width="5"/>
  <line x1="360" y1="30"  x2="360" y2="215" stroke="#111" stroke-width="5"/>
  <line x1="590" y1="30"  x2="590" y2="215" stroke="#111" stroke-width="5"/>
  <line x1="30"  y1="215" x2="790" y2="215" stroke="#111" stroke-width="5"/>
  <line x1="30"  y1="275" x2="790" y2="275" stroke="#111" stroke-width="5"/>
  <line x1="270" y1="275" x2="270" y2="470" stroke="#111" stroke-width="5"/>
  <line x1="360" y1="275" x2="360" y2="470" stroke="#111" stroke-width="5"/>
  <line x1="700" y1="275" x2="700" y2="470" stroke="#111" stroke-width="5"/>
  <rect x="30" y="30" width="960" height="440" fill="none" stroke="#111" stroke-width="11"/>
  <rect x="65" y="212" width="40" height="6" fill="white"/>
  <rect x="65" y="175" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 105 215 A 40 40 0 0 0 65 175" fill="none" stroke="#111" stroke-width="1.5"/>
  <rect x="315" y="212" width="40" height="6" fill="white"/>
  <rect x="352" y="175" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 315 215 A 40 40 0 0 1 355 175" fill="none" stroke="#111" stroke-width="1.5"/>
  <rect x="368" y="212" width="40" height="6" fill="white"/>
  <rect x="368" y="175" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 408 215 A 40 40 0 0 0 368 175" fill="none" stroke="#111" stroke-width="1.5"/>
  <rect x="545" y="212" width="40" height="6" fill="white"/>
  <rect x="545" y="175" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 585 215 A 40 40 0 0 0 545 175" fill="none" stroke="#111" stroke-width="1.5"/>
  <rect x="598" y="212" width="40" height="6" fill="white"/>
  <rect x="598" y="175" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 638 215 A 40 40 0 0 0 598 175" fill="none" stroke="#111" stroke-width="1.5"/>
  <rect x="738" y="212" width="40" height="6" fill="white"/>
  <rect x="738" y="175" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 778 215 A 40 40 0 0 0 738 175" fill="none" stroke="#111" stroke-width="1.5"/>
  <rect x="787" y="232" width="6" height="40" fill="white"/>
  <rect x="790" y="232" width="40" height="3" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 790 272 A 40 40 0 0 0 830 232" fill="none" stroke="#111" stroke-width="1.5"/>
  <rect x="190" y="272" width="40" height="6" fill="white"/>
  <rect x="190" y="275" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 230 275 A 40 40 0 0 1 190 315" fill="none" stroke="#111" stroke-width="1.5"/>
  <rect x="385" y="272" width="40" height="6" fill="white"/>
  <rect x="385" y="275" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 425 275 A 40 40 0 0 1 385 315" fill="none" stroke="#111" stroke-width="1.5"/>
  <rect x="655" y="272" width="40" height="6" fill="white"/>
  <rect x="655" y="275" width="3" height="40" fill="white" stroke="#111" stroke-width="1"/>
  <path d="M 695 275 A 40 40 0 0 1 655 315" fill="none" stroke="#111" stroke-width="1.5"/>
  <line x1="285" y1="278" x2="285" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="300" y1="278" x2="300" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="315" y1="278" x2="315" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="330" y1="278" x2="330" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="345" y1="278" x2="345" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <polygon points="315,330 310,342 320,342" fill="#888"/>
  <line x1="315" y1="342" x2="315" y2="400" stroke="#888" stroke-width="1.5"/>
  <polygon points="315,410 310,398 320,398" fill="#888"/>
  <line x1="715" y1="278" x2="715" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="730" y1="278" x2="730" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="745" y1="278" x2="745" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="760" y1="278" x2="760" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <line x1="775" y1="278" x2="775" y2="467" stroke="#aaa" stroke-width="1.5"/>
  <polygon points="745,330 740,342 750,342" fill="#888"/>
  <line x1="745" y1="342" x2="745" y2="400" stroke="#888" stroke-width="1.5"/>
  <polygon points="745,410 740,398 750,398" fill="#888"/>
  <text x="410" y="245" font-family="Arial,Helvetica,sans-serif" font-size="13" text-anchor="middle" dominant-baseline="middle" fill="#888">C O R R I D O R</text>
  <text x="195" y="122" font-family="Arial,Helvetica,sans-serif" font-size="16" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#111">MACLAB</text>
  <text x="475" y="122" font-family="Arial,Helvetica,sans-serif" font-size="16" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#111">AES</text>
  <text x="690" y="122" font-family="Arial,Helvetica,sans-serif" font-size="16" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#111">GDA</text>
  <text x="890" y="250" font-family="Arial,Helvetica,sans-serif" font-size="16" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#111" transform="rotate(-90,890,250)">FACULTY 3</text>
  <text x="150" y="362" font-family="Arial,Helvetica,sans-serif" font-size="15" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#111">SERVER</text>
  <text x="150" y="380" font-family="Arial,Helvetica,sans-serif" font-size="15" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#111">ROOM</text>
  <text x="315" y="372" font-family="Arial,Helvetica,sans-serif" font-size="11" text-anchor="middle" dominant-baseline="middle" fill="#555" transform="rotate(-90,315,372)">S T A I R S</text>
  <text x="530" y="372" font-family="Arial,Helvetica,sans-serif" font-size="16" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#111">COMLAB 2</text>
  <text x="745" y="372" font-family="Arial,Helvetica,sans-serif" font-size="11" text-anchor="middle" dominant-baseline="middle" fill="#555" transform="rotate(-90,745,372)">S T A I R S</text>
  <text x="510" y="488" font-family="Arial,Helvetica,sans-serif" font-size="17" font-weight="bold" text-anchor="middle" fill="#111">2ND FLOOR PLAN</text>
  <text x="510" y="508" font-family="Arial,Helvetica,sans-serif" font-size="12" text-anchor="middle" fill="#555">IC BUILDING — DNSC</text>
</svg>`

// ─── IC Floor Plan panel ──────────────────────────────────────────────────────

function ICFloorPlan({ devices, onBack, live = false, onLiveChange }: {
  devices: Device[]; onBack: () => void; live?: boolean
  onLiveChange?: (on: boolean) => void   // keeps the View dropdown in step with the Live toggle
}) {
  const [floor, setFloor] = useState<'1' | '2'>('1')
  const [liveDevices, setLiveDevices] = useState<Device[]>(devices)
  const [showLive, setShowLive] = useState(live)
  const [focus, setFocus] = useState<string | null>(null)                 // room id highlighted from the side panel
  const [tip, setTip] = useState<{ room: FloorRoom; x: number; y: number } | null>(null)
  const { rooms: allRooms } = useFloorRooms()

  // Fit the plan to the space left on screen (no page scrolling)
  const planRef = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState({ w: 800, h: 460 })
  useEffect(() => {
    const el = planRef.current
    if (!el) return
    const measure = () => {
      const top = el.getBoundingClientRect().top
      const BELOW = 100  // legend + panel/card/page padding under the plan
      setArea({ w: el.clientWidth, h: Math.max(260, Math.floor(window.innerHeight - top - BELOW)) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  useEffect(() => { setLiveDevices(devices) }, [devices])
  useEffect(() => { setShowLive(live) }, [live])

  // Real-time device changes (the page also refreshes every few seconds)
  useEffect(() => {
    if (!showLive) return
    const location = devices[0]?.location ?? ''
    const ch = supabase
      .channel('floor-plan-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, async () => {
        const q = supabase.from('devices').select('*').order('name')
        const { data } = location ? await q.eq('location', location) : await q
        if (data) setLiveDevices(data as Device[])
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [devices, showLive])

  const svgContent = useMemo(() => stripRoomLabels(floor === '1' ? FLOOR_1_SVG : FLOOR_2_SVG), [floor])
  const rooms      = useMemo(() => allRooms.filter(r => String(r.floor) === floor), [allRooms, floor])
  const [vbW, vbH] = FLOOR_VIEWBOX[floor === '1' ? 1 : 2]

  const byRoom = useMemo(() => devicesByRoom(rooms, liveDevices), [rooms, liveDevices])
  // Devices in no room on either floor — listed, not guessed onto the map
  const unplaced = useMemo(() => liveDevices.filter(d => !roomOfDevice(d, allRooms)), [liveDevices, allRooms])
  const onFloor = rooms.flatMap(r => byRoom[r.id] ?? [])

  const count = (list: Device[], s: string) => list.filter(d => d.status === s).length
  const chips: [string, number, string][] = [
    ['Online', count(onFloor, 'up'), '#16a34a'],
    ['Warning', count(onFloor, 'warn'), '#d97706'],
    ['Offline', count(onFloor, 'down') + count(onFloor, 'unreachable'), '#dc2626'],
  ]

  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: '5px 14px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: 'none',
    background: active ? 'var(--surface)' : 'transparent', color: active ? 'var(--accent2)' : 'var(--text2)',
    boxShadow: active ? '0 1px 3px rgba(15,23,42,.12)' : 'none',
  })

  return (
    <div className="card" style={{ borderTop: '3px solid var(--accent)' }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <button suppressHydrationWarning className="btn btn-sm" onClick={onBack}>← Back</button>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>IC Building</div>
          <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>{onFloor.length} device{onFloor.length === 1 ? '' : 's'} placed on this floor</div>
        </div>
        <div style={{ display: 'flex', gap: 2, padding: 3, background: 'var(--surface3)', borderRadius: 8, marginLeft: 8 }}>
          {(['1', '2'] as const).map(f => (
            <button suppressHydrationWarning key={f} style={tabBtn(floor === f)} onClick={() => { setFloor(f); setFocus(null) }}>
              {f === '1' ? '1st' : '2nd'} Floor
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }}/>
        {showLive && chips.map(([l, n, c]) => (
          <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: c, background: `${c}12`, border: `1px solid ${c}33`, padding: '2px 9px', borderRadius: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: c }}/>{n} {l}
          </span>
        ))}
        <button suppressHydrationWarning onClick={() => { const on = !showLive; setShowLive(on); onLiveChange?.(on) }} className="btn btn-sm"
          style={showLive ? { background: 'var(--accent)', borderColor: 'var(--accent2)', color: '#fff' } : undefined}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
            background: showLive ? '#bbf7d0' : 'var(--text3)',
            animation: showLive ? 'pulse 1.8s ease-in-out infinite' : 'none',
          }}/>
          Live devices {showLive ? 'on' : 'off'}
        </button>
      </div>

      {/* ── Plan + side panel ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 560px', minWidth: 0, padding: 14, background: 'var(--surface2)' }}>
          {/* The plan keeps its proportions and is as large as fits both width and height */}
          <div ref={planRef} style={{ display: 'flex', justifyContent: 'center' }}>
          <div style={{
            position: 'relative', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', background: '#fff',
            width: Math.min(area.w, area.h * (vbW / vbH)), height: Math.min(area.w, area.h * (vbW / vbH)) / (vbW / vbH),
          }}
            onMouseLeave={() => setTip(null)}>
            <div dangerouslySetInnerHTML={{ __html: svgContent.replace(/<svg /, '<svg style="width:100%;height:100%;display:block" preserveAspectRatio="xMidYMid meet" ') }}
              style={{ lineHeight: 0, width: '100%', height: '100%' }}/>
            {/* Room names always; device markers only when Live is on */}
            <FloorOverlay rooms={rooms} byRoom={byRoom} vbW={vbW} vbH={vbH} focus={focus} showDevices={showLive}
              onHover={(room, e) => setTip(room && e ? { room, x: e.clientX, y: e.clientY } : null)}/>
            <div style={{ position: 'absolute', left: 12, bottom: 10, fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: '#64748b', background: 'rgba(255,255,255,.85)', padding: '3px 9px', borderRadius: 6 }}>
              {floor === '1' ? '1ST FLOOR' : '2ND FLOOR'}
            </div>
          </div>
          </div>
          {/* Legend */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '10px 2px 0', fontSize: 12, color: 'var(--text2)' }}>
            {(['up', 'warn', 'unreachable', 'down'] as const).map(k => (
              <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: FP_STATUS[k].color }}/>{FP_STATUS[k].label}
              </span>
            ))}
            <span style={{ marginLeft: 'auto', color: 'var(--text3)' }}>Hover a room marker for its devices</span>
          </div>
        </div>

        {/* Side panel */}
        <div style={{ flex: '0 0 300px', maxWidth: '100%', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '12px 14px 6px', fontSize: 11, fontWeight: 700, color: 'var(--text3)', letterSpacing: '.06em' }}>ROOMS</div>
          <div style={{ overflowY: 'auto', maxHeight: area.h + 10 }}>
            {rooms.map(r => {
              const devs = byRoom[r.id] ?? []
              const color = devs.length ? roomHealth(devs) : '#cbd5e1'
              const active = focus === r.id
              return (
                <div key={r.id}
                  onClick={() => setFocus(f => f === r.id ? null : r.id)}
                  style={{ padding: '8px 14px', cursor: 'pointer', borderLeft: `3px solid ${active ? color : 'transparent'}`, background: active ? 'var(--surface2)' : undefined }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0 }}/>
                    <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{r.label}</span>
                    <span style={{ fontSize: 12, color: devs.length ? color : 'var(--text3)', fontWeight: 600 }}>
                      {devs.length ? `${devs.filter(isLive).length}/${devs.length} online` : 'No devices'}
                    </span>
                  </div>
                  {(active || devs.some(d => !isLive(d))) && devs.length > 0 && (
                    <div style={{ marginTop: 4, paddingLeft: 17 }}>
                      {(active ? devs : devs.filter(d => !isLive(d))).map(d => (
                        <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '2px 0' }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: fpSt(d.status).color }}/>
                          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                          <span style={{ color: fpSt(d.status).color, fontSize: 11 }}>{fpSt(d.status).label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}

            {unplaced.length > 0 && (
              <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, padding: '10px 14px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', letterSpacing: '.06em', marginBottom: 4 }}>
                  NOT IN A ROOM ({unplaced.length})
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 6 }}>
                  Assign a room in <a href="/settings?tab=manage" style={{ color: 'var(--accent)' }}>Settings → Manage</a> to place them on the map.
                </div>
                {unplaced.map(d => (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 0' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: fpSt(d.status).color }}/>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{d.ip}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Hover: room devices */}
      {tip && (() => {
        const devs = byRoom[tip.room.id] ?? []
        const left = tip.x + 260 > window.innerWidth ? tip.x - 256 : tip.x + 14
        const top = tip.y + 40 + devs.length * 22 > window.innerHeight ? tip.y - 40 - devs.length * 22 : tip.y + 14
        return (
          <div style={{ position: 'fixed', left, top, width: 240, zIndex: 50, pointerEvents: 'none', background: '#fff', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 10px 30px rgba(15,23,42,.18)', fontSize: 12, overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', fontWeight: 700, borderBottom: '1px solid var(--border)', display: 'flex' }}>
              <span style={{ flex: 1 }}>{tip.room.label}</span>
              <span style={{ color: roomHealth(devs) }}>{devs.filter(isLive).length}/{devs.length} online</span>
            </div>
            <div style={{ padding: '6px 12px' }}>
              {devs.map(d => (
                <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: fpSt(d.status).color }}/>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                  <span className="mono" style={{ color: 'var(--text3)', fontSize: 11 }}>{d.ip}</span>
                </div>
              ))}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// ─── Buildings View ───────────────────────────────────────────────────────────

// One card per location: health, status breakdown, devices, floor plan link.
const B_STATUS: { key: string; label: string; color: string }[] = [
  { key: 'up',          label: 'Online',      color: '#16a34a' },
  { key: 'warn',        label: 'Warning',     color: '#d97706' },
  { key: 'unreachable', label: 'Unreachable', color: '#f59e0b' },
  { key: 'down',        label: 'Offline',     color: '#dc2626' },
  { key: 'unknown',     label: 'Unknown',     color: '#94a3b8' },
]
const bColor = (s: string) => B_STATUS.find(x => x.key === s)?.color ?? '#94a3b8'

function bldgHealth(g: BldgGroup) {
  const live = g.devices.filter(d => d.status === 'up' || d.status === 'warn').length
  const down = g.devices.filter(d => d.status === 'down').length
  if (!g.total) return { label: 'No devices', color: '#94a3b8', bg: '#f8fafc' }
  if (down === 0 && live === g.total && !g.devices.some(d => d.status === 'warn')) return { label: 'Healthy', color: '#16a34a', bg: '#f0fdf4' }
  if (live === 0) return { label: 'Down', color: '#dc2626', bg: '#fef2f2' }
  return { label: 'Degraded', color: '#d97706', bg: '#fffbeb' }
}

function BuildingsView({ groups, onSelectBldg }: { groups: BldgGroup[]; onSelectBldg: (name: string) => void }) {
  const isUnassigned = (n: string) => !n || n === 'Unassigned'
  // Real buildings first (most devices first), "Unassigned" last
  const sorted = [...groups].sort((a, b) =>
    Number(isUnassigned(a.name)) - Number(isUnassigned(b.name)) || b.total - a.total || a.name.localeCompare(b.name))

  const all = groups.flatMap(g => g.devices)
  const liveAll = all.filter(d => d.status === 'up' || d.status === 'warn').length
  const pct = all.length ? Math.round((liveAll / all.length) * 100) : 0

  if (!groups.length) return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)' }}>No devices match the current filters.</div>
  )

  return (
    <div>
      {/* Summary */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16, fontSize: 13 }}>
        <strong>{groups.filter(g => !isUnassigned(g.name)).length} location{groups.filter(g => !isUnassigned(g.name)).length === 1 ? '' : 's'}</strong>
        <span style={{ color: 'var(--text3)' }}>{all.length} devices · {pct}% online</span>
        <span style={{ flex: 1 }}/>
        {[['#16a34a', 'Healthy'], ['#d97706', 'Degraded'], ['#dc2626', 'Down']].map(([c, l]) => (
          <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)' }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: c }}/>{l}
          </span>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${sorted.length <= 2 ? 380 : 300}px, 1fr))`, gap: 16 }}>
        {sorted.map(g => {
          const h = bldgHealth(g)
          const unassigned = isUnassigned(g.name)
          const counts = B_STATUS.map(s => ({ ...s, n: g.devices.filter(d => (d.status === s.key) || (s.key === 'unknown' && !B_STATUS.some(x => x.key === d.status))).length }))
          const devList = [...g.devices].sort((a, b) =>
            ['down', 'unreachable', 'warn', 'unknown', 'up'].indexOf(a.status) - ['down', 'unreachable', 'warn', 'unknown', 'up'].indexOf(b.status) || a.name.localeCompare(b.name))
          return (
            <div key={g.name} className="card" style={{
              display: 'flex', flexDirection: 'column', borderTop: `3px solid ${h.color}`,
              borderStyle: unassigned ? 'dashed' : undefined, borderTopStyle: 'solid',
            }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px 10px' }}>
                <div style={{ width: 52, height: 52, borderRadius: 12, background: h.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Image src={g.imageUrl} alt="" width={38} height={38} style={{ objectFit: 'contain', opacity: unassigned ? .6 : 1 }}/>
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {unassigned ? 'Unassigned' : g.name}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                    {g.total} device{g.total === 1 ? '' : 's'} · {g.devices.filter(d => d.status === 'up' || d.status === 'warn').length} online
                  </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: h.color, background: h.bg, border: `1px solid ${h.color}44`, padding: '3px 10px', borderRadius: 12, flexShrink: 0 }}>
                  {h.label}
                </span>
              </div>

              {/* Status bar */}
              <div style={{ padding: '0 16px' }}>
                <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: '#eef2f6' }}>
                  {counts.filter(c => c.n).map(c => (
                    <div key={c.key} title={`${c.n} ${c.label}`} style={{ width: `${(c.n / Math.max(g.total, 1)) * 100}%`, background: c.color }}/>
                  ))}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 8, fontSize: 11.5, color: 'var(--text2)' }}>
                  {counts.filter(c => c.n).map(c => (
                    <span key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: c.color }}/>{c.n} {c.label}
                    </span>
                  ))}
                </div>
              </div>

              {/* Devices (problems first) */}
              <div style={{ padding: '10px 16px 4px', flex: 1 }}>
                {devList.slice(0, 5).map(d => (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid var(--border)', fontSize: 12.5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: bColor(d.status), flexShrink: 0 }}/>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{d.ip}</span>
                  </div>
                ))}
                {devList.length > 5 && (
                  <div style={{ fontSize: 11.5, color: 'var(--text3)', padding: '5px 0', borderTop: '1px solid var(--border)' }}>
                    +{devList.length - 5} more
                  </div>
                )}
              </div>

              {/* Footer */}
              <div style={{ padding: '10px 16px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
                {g.hasFloorPlan ? (
                  <button suppressHydrationWarning className="btn btn-sm btn-primary" onClick={() => onSelectBldg(g.name)}>
                    View floor plan →
                  </button>
                ) : unassigned ? (
                  <span style={{ fontSize: 12, color: 'var(--text3)' }}>
                    Set a location for these devices on the <a href="/devices" style={{ color: 'var(--accent)' }}>Devices</a> page
                  </span>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--text3)' }}>No floor plan for this building</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Filter bar styles ────────────────────────────────────────────────────────

// Clean, light filter bar in the app's card style (white surface, thin
// border, green accent) — sits flush on top of the card below it.
const FB: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderTop: '3px solid var(--accent)',
  borderRadius: '10px 10px 0 0',
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(140px, 100%), 1fr))',
  gap: 12, padding: '12px 16px',
}
const FI: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }
const FL: React.CSSProperties = { fontSize: 11.5, fontWeight: 600, color: 'var(--text3)' }
const FS: React.CSSProperties = { cursor: 'pointer', fontWeight: 500 }

// ─── Main Hub ─────────────────────────────────────────────────────────────────

// mode="topology"  → Topology page: Topology Tree + Buildings View only
// mode="floorplan" → Floor Plan page: Real-time Map (default) + Floor-based Map only
export default function TopologyHub({ devs, clientCounts = {}, mode, initialBldg }: {
  devs: Device[]
  clientCounts?: Record<string, number>
  mode: 'topology' | 'floorplan'
  initialBldg?: string
}) {
  const router = useRouter()
  // Topology opens on the real connection tree once the agent has learned links
  const hasLinks = devs.some(d => !!d.parent_id)
  const [viewMode,     setViewMode]     = useState<ViewMode>(mode === 'topology' ? (hasLinks ? 'links' : 'tree') : 'realtime')
  const [bldgFilter,   setBldgFilter]   = useState(initialBldg ?? 'all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter,   setTypeFilter]   = useState('all')

  // ── Scan-derived devices for Topology Tree ─────────────────────────────────
  const [scanDevs,    setScanDevs]    = useState<Device[] | null>(null)
  const [scanLoading, setScanLoading] = useState(false)
  const [scanSubnet,  setScanSubnet]  = useState(() =>
    typeof window !== 'undefined' ? (localStorage.getItem('nms_scan_subnet') ?? '192.168.1') : '192.168.1'
  )

  function toDeviceType(ip: string, dt: string | null): 'Router' | 'Access Point' | 'Switch' | 'Server' | 'Client' | 'Unknown' | 'Firewall' {
    // Gateway IPs (.1 or .254) are always routers regardless of OUI match
    const lastOct = parseInt(ip.split('.')[3] ?? '0', 10)
    if (lastOct === 1 || lastOct === 254) return 'Router'
    if (dt === 'Router')       return 'Router'
    if (dt === 'Access Point') return 'Access Point'
    if (dt === 'Switch')       return 'Switch'
    if (dt === 'Server')       return 'Server'
    if (dt === 'Client')       return 'Client'
    return 'Client'
  }

  function convertScan(results: ScanResult[]): Device[] {
    const now = new Date().toISOString()
    return results.map((r): Device => ({
      id:         r.ip,
      name:       r.vendor ?? r.ip,
      ip:         r.ip,
      type:       toDeviceType(r.ip, r.device_type),
      status:     r.responded ? 'up' : r.mac ? 'warn' : 'down',
      location:   'Scanned Network',
      uptime:     '—',
      cpu:        r.latency_ms != null ? Math.min(Math.round(r.latency_ms / 2), 100) : 0,
      mem:        0,
      created_at:     now,
      updated_at:     now,
      snmp_community: 'public',
      snmp_port:      161,
    }))
  }

  const fetchScan = useCallback(async (subnet?: string) => {
    setScanLoading(true)
    try {
      // Try cached results first
      let res = await fetch('/api/scan')
      let data = await res.json()
      if (!data.results?.length || subnet) {
        // Trigger a live scan
        res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subnet: subnet ?? scanSubnet }),
        })
        data = await res.json()
      }
      setScanDevs(convertScan(data.results ?? []))
    } catch {
      setScanDevs([])
    } finally {
      setScanLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanSubnet])

  useEffect(() => {
    if (viewMode === 'tree' && scanDevs === null) fetchScan()
  }, [viewMode, scanDevs, fetchScan])

  // Keep the tree current without a manual refresh (quietly, no "Scanning…" screen)
  useEffect(() => {
    if (viewMode !== 'tree') return
    const t = setInterval(async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const data = await (await fetch('/api/scan')).json()
        if (data.results?.length) setScanDevs(convertScan(data.results))
      } catch { /* keep the current tree */ }
    }, 10_000)
    return () => clearInterval(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode])

  const bldgGroups = useMemo<BldgGroup[]>(() => {
    const map = new Map<string, Device[]>()
    devs.forEach(d => {
      if (!map.has(d.location)) map.set(d.location, [])
      map.get(d.location)!.push(d)
    })
    const groups: BldgGroup[] = []
    map.forEach((devices, name) => {
      groups.push({
        name,
        total:        devices.length,
        online:       devices.filter(d => d.status === 'up').length,
        warn:         devices.filter(d => d.status === 'warn').length,
        devices,
        hasFloorPlan: /ic.?build|building.?a/i.test(name),
        imageUrl:     getBldgImage(name),
      })
    })
    return groups.sort((a, b) => b.total - a.total)
  }, [devs])

  const deviceTypes = useMemo(() => [...new Set(devs.map(d => d.type))].sort(), [devs])

  const filteredDevs = devs.filter(d =>
    (statusFilter === 'all' || d.status   === statusFilter) &&
    (typeFilter   === 'all' || d.type     === typeFilter)   &&
    (bldgFilter   === 'all' || d.location === bldgFilter)
  )
  const filteredGroups = bldgFilter === 'all' ? bldgGroups : bldgGroups.filter(g => g.name === bldgFilter)

  const VIEW_OPTIONS = mode === 'topology'
    ? [
        { value: 'links'     as ViewMode, label: 'Connection Tree', icon: '🔗' },
        { value: 'tree'      as ViewMode, label: 'Network Tree (by subnet)', icon: '🌐' },
        { value: 'buildings' as ViewMode, label: 'Buildings View',  icon: '🏢' },
      ]
    : [
        { value: 'realtime'  as ViewMode, label: 'Real-time Map',   icon: '📡' },
        { value: 'floormap'  as ViewMode, label: 'Floor-based Map', icon: '🗺' },
      ]

  return (
    <div>
      <FilterBar viewMode={viewMode} setViewMode={setViewMode} bldgFilter={bldgFilter}
        setBldgFilter={setBldgFilter} statusFilter={statusFilter} setStatusFilter={setStatusFilter}
        typeFilter={typeFilter} setTypeFilter={setTypeFilter}
        bldgGroups={bldgGroups} devs={devs} deviceTypes={deviceTypes} viewOptions={VIEW_OPTIONS}/>

      <div className="card" style={{ borderRadius: '0 0 10px 10px', borderTop: 'none' }}>
        <div className="card-body" style={{ padding: viewMode === 'tree' || viewMode === 'links' ? 0 : 20 }}>

          {viewMode === 'buildings' && (
            <BuildingsView groups={filteredGroups}
              onSelectBldg={name => router.push(`/floorplan?bldg=${encodeURIComponent(name)}`)}/>
          )}

          {viewMode === 'links' && <TopologyLinks devs={filteredDevs}/>}

          {viewMode === 'tree' && (() => {
            if (scanLoading && !devs.length) return (
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--text3)' }}>
                <div style={{ fontSize: 28, marginBottom: 10 }}>📡</div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Scanning network…</div>
                <div style={{ fontSize: 12 }}>Running ICMP + ARP on {scanSubnet}.0/24</div>
              </div>
            )
            // Inventory (real names, MAC, vendor, live status) + scan hosts not registered yet
            const knownIps  = new Set(devs.map(d => d.ip))
            const knownMacs = new Set(devs.map(d => d.mac?.toUpperCase()).filter(Boolean) as string[])
            const unregistered = (scanDevs ?? []).filter(d => !knownIps.has(d.ip) && !(d.mac && knownMacs.has(d.mac.toUpperCase())))
            const allTree = [...devs.filter(d => d.status !== 'maint' || statusFilter === 'maint'), ...unregistered]
            if (!allTree.length) return (
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--text3)' }}>
                <div style={{ fontSize: 28, marginBottom: 10 }}>🔍</div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>No scan results yet</div>
                <div style={{ fontSize: 12, marginBottom: 16 }}>Run a discovery scan to see live topology</div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input suppressHydrationWarning className="form-input" style={{ width: 130, fontSize: 12 }}
                    value={scanSubnet}
                    onChange={e => { setScanSubnet(e.target.value); localStorage.setItem('nms_scan_subnet', e.target.value) }}
                    placeholder="192.168.1"/>
                  <button suppressHydrationWarning className="btn btn-sm btn-primary" onClick={() => fetchScan()}>Scan Now</button>
                </div>
              </div>
            )
            // Only the networks this computer is connected to right now: a
            // network counts when the agent sees a device on it directly
            // (Online / Warning by ICMP or ARP — only possible on a network it
            // is on). All their devices are shown, offline ones included; other
            // networks are hidden and reappear when you connect to them again.
            // Picking a status in the filter still shows every device with it.
            const netOf = (d: Device) => d.ip.split('.').slice(0, 3).join('.')
            const liveNets = new Set(allTree.filter(isLive).map(netOf))
            const treeDevs = allTree.filter(d =>
              (statusFilter === 'all' ? liveNets.has(netOf(d)) : d.status === statusFilter) &&
              (typeFilter   === 'all' || d.type   === typeFilter) &&
              (bldgFilter   === 'all' || d.location === bldgFilter)
            )
            const count = (fn: (d: Device) => boolean) => allTree.filter(fn).length
            const chips: [string, number, string][] = [
              ['Online',      count(d => d.status === 'up'),   '#16a34a'],
              ['Warning',     count(d => d.status === 'warn'), '#d97706'],
              ['Unreachable', count(d => d.status === 'unreachable'), '#f59e0b'],
              ['Offline',     count(d => d.status === 'down'), '#dc2626'],
              ['Unknown',     count(d => d.status === 'unknown'), '#94a3b8'],
            ]
            const networks = new Set(treeDevs.map(d => d.ip.split('.').slice(0, 3).join('.'))).size
            return (
              <div>
                {/* Tree toolbar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: '#f8fafc', borderBottom: '1px solid var(--border)', fontSize: 12, flexWrap: 'wrap' }}>
                  <strong style={{ color: 'var(--text)' }}>{treeDevs.length} devices</strong>
                  <span style={{ color: 'var(--text3)' }}>on {networks} network{networks === 1 ? '' : 's'}</span>
                  <span style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }}/>
                  {chips.filter(([, n]) => n > 0).map(([label, n, color]) => (
                    <span key={label} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px', borderRadius: 12,
                      background: `${color}14`, color, fontWeight: 600, border: `1px solid ${color}33`,
                    }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }}/>{n} {label}
                    </span>
                  ))}
                  {unregistered.length > 0 && (
                    <span style={{ color: 'var(--text3)' }} title="Seen by the scanner but not yet in the device inventory">· {unregistered.length} not registered</span>
                  )}
                  <span style={{ flex: 1 }}/>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--text3)' }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)', animation: 'pulse 1.8s ease-in-out infinite' }}/>
                    Live · updates automatically
                  </span>
                </div>
                <TopologyCanvas devs={treeDevs} clientCounts={clientCounts}/>
              </div>
            )
          })()}

          {/* Floor-based Map = the floor plan with live devices off;
              Real-time Map = the same plan with live devices on.
              The panel's Live toggle switches between the two views. */}
          {(viewMode === 'floormap' || viewMode === 'realtime') && (
            filteredGroups.some(g => g.hasFloorPlan) ? (
              filteredGroups.filter(g => g.hasFloorPlan).map(g => (
                <div key={g.name} style={{ marginBottom: 16 }}>
                  <ICFloorPlan devices={g.devices} live={viewMode === 'realtime'}
                    onLiveChange={on => setViewMode(on ? 'realtime' : 'floormap')}
                    onBack={() => router.push('/topology')}/>
                </div>
              ))
            ) : (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)' }}>
                <div style={{ fontSize: 32, marginBottom: 10 }}>🗺</div>
                <div style={{ fontWeight: 600 }}>No floor plan for the selected building</div>
                <button suppressHydrationWarning className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => setBldgFilter('all')}>
                  Show all buildings
                </button>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Filter bar (extracted) ───────────────────────────────────────────────────

function FilterBar({ viewMode, setViewMode, bldgFilter, setBldgFilter, statusFilter, setStatusFilter,
  typeFilter, setTypeFilter, bldgGroups, devs, deviceTypes, viewOptions }: {
  viewMode: ViewMode; setViewMode: (v: ViewMode) => void
  bldgFilter: string; setBldgFilter: (v: string) => void
  statusFilter: string; setStatusFilter: (v: string) => void
  typeFilter: string; setTypeFilter: (v: string) => void
  bldgGroups: BldgGroup[]; devs: Device[]
  deviceTypes: string[]
  viewOptions: { value: ViewMode; label: string; icon: string }[]
}) {
  return (
    <div style={FB}>
      <div style={FI}>
        <label style={FL}>View</label>
        <select suppressHydrationWarning className="form-select" style={FS} value={viewMode} onChange={e => setViewMode(e.target.value as ViewMode)}>
          {viewOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div style={FI}>
        <label style={FL}>Building</label>
        <select suppressHydrationWarning className="form-select" style={FS} value={bldgFilter} onChange={e => setBldgFilter(e.target.value)}>
          <option value="all">All Buildings ({bldgGroups.reduce((s,g)=>s+g.total,0)})</option>
          {bldgGroups.map(g => <option key={g.name} value={g.name}>{g.name} ({g.total})</option>)}
        </select>
      </div>
      <div style={FI}>
        <label style={FL}>Status</label>
        <select suppressHydrationWarning className="form-select" style={FS} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="all">All Statuses ({devs.length})</option>
          <option value="up">Online ({devs.filter(d=>d.status==='up').length})</option>
          <option value="warn">Warning ({devs.filter(d=>d.status==='warn').length})</option>
          <option value="down">Offline ({devs.filter(d=>d.status==='down').length})</option>
          <option value="unreachable">Unreachable ({devs.filter(d=>d.status==='unreachable').length})</option>
          <option value="unknown">Unknown ({devs.filter(d=>d.status==='unknown').length})</option>
        </select>
      </div>
      <div style={FI}>
        <label style={FL}>Device type</label>
        <select suppressHydrationWarning className="form-select" style={FS} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="all">All Devices ({devs.length})</option>
          {deviceTypes.map(t => <option key={t} value={t}>{t} ({devs.filter(d=>d.type===t).length})</option>)}
        </select>
      </div>
    </div>
  )
}
