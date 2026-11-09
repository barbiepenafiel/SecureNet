'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import Image from 'next/image'
import type { Device, ScanResult } from '@/lib/database.types'
import { supabase } from '@/lib/supabase'
import TopologyCanvas from './TopologyCanvas'

type ViewMode = 'buildings' | 'tree' | 'floormap' | 'realtime'

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

// ─── Floor plan style ─────────────────────────────────────────────────────────

type RoomDef = {
  id: string
  label: string
  // bounding box in SVG coords (for dot/badge placement)
  cx: number
  cy: number
  badgeX: number
  badgeY: number
}

// 1st floor rooms in the SVG viewBox="0 0 920 520"
const ROOMS_1ST: RoomDef[] = [
  { id: 'faculty1',   label: 'Faculty 1',          cx: 187, cy: 120, badgeX: 60,  badgeY: 48 },
  { id: 'accred',     label: 'Accreditation Room',  cx: 477, cy: 110, badgeX: 477, badgeY: 48 },
  { id: 'netlab',     label: 'Netlab',              cx: 750, cy: 120, badgeX: 858, badgeY: 48 },
  { id: 'faculty2',   label: 'Faculty 2',           cx: 165, cy: 370, badgeX: 60,  badgeY: 302 },
  { id: 'comlab1',    label: 'Comlab 1',            cx: 595, cy: 370, badgeX: 595, badgeY: 302 },
]

// 2nd floor rooms in viewBox="0 0 1020 520"
const ROOMS_2ND: RoomDef[] = [
  { id: 'maclab',     label: 'MacLab',     cx: 195, cy: 120, badgeX: 60,  badgeY: 48 },
  { id: 'aes',        label: 'AES',        cx: 475, cy: 120, badgeX: 475, badgeY: 48 },
  { id: 'gda',        label: 'GDA',        cx: 690, cy: 120, badgeX: 690, badgeY: 48 },
  { id: 'faculty3',   label: 'Faculty 3',  cx: 905, cy: 250, badgeX: 940, badgeY: 48 },
  { id: 'serverroom', label: 'Server Room', cx: 150, cy: 370, badgeX: 60,  badgeY: 302 },
  { id: 'comlab2',    label: 'Comlab 2',   cx: 530, cy: 370, badgeX: 530, badgeY: 302 },
]

function matchRoom(device: Device, roomLabel: string): boolean {
  const n = device.name.toLowerCase()
  const r = roomLabel.toLowerCase()
  if (r === 'faculty 1')          return n.includes('fac') && (n.includes('f1') || n.includes(' 1') || n.endsWith('faculty'))
  if (r === 'faculty 2')          return n.includes('fac') && (n.includes('f2') || n.includes(' 2'))
  if (r === 'faculty 3')          return n.includes('fac') && (n.includes('f3') || n.includes(' 3'))
  if (r === 'accreditation room') return n.includes('accred') || n.includes('acc')
  if (r === 'netlab')             return n.includes('net') || n.includes('lab') || n.includes('netlab')
  if (r === 'comlab 1')           return n.includes('comlab') && (n.includes('1') || !n.includes('2'))
  if (r === 'comlab 2')           return n.includes('comlab') && n.includes('2')
  if (r === 'maclab')             return n.includes('mac') || n.includes('maclab')
  if (r === 'aes')                return n.includes('aes')
  if (r === 'gda')                return n.includes('gda')
  if (r === 'server room')        return n.includes('server') || n.includes('srv')
  return false
}

// ─── Floor plan overlays ──────────────────────────────────────────────────────

function FloorOverlay({ rooms, devices, scaleX, scaleY }: {
  rooms: RoomDef[]
  devices: Device[]
  scaleX: number
  scaleY: number
}) {
  const byRoom = useMemo(() => {
    const matched = new Set<string>()
    const map: Record<string, Device[]> = {}
    rooms.forEach(r => {
      map[r.id] = devices.filter(d => { if (matchRoom(d, r.label)) { matched.add(String(d.id)); return true } return false })
    })
    // Leftover → distribute to first room
    const leftover = devices.filter(d => !matched.has(String(d.id)))
    if (rooms.length > 0 && leftover.length > 0) map[rooms[0].id] = [...map[rooms[0].id], ...leftover]
    return map
  }, [rooms, devices])

  return (
    <>
      {rooms.map(r => {
        const devs = byRoom[r.id] ?? []
        if (!devs.length) return null
        const online = devs.filter(d => d.status === 'up').length
        const bg = online === devs.length ? '#22c55e' : online === 0 ? '#ef4444' : '#f59e0b'
        const bx = r.badgeX * scaleX
        const by = r.badgeY * scaleY
        const cx = r.cx * scaleX
        const cy = r.cy * scaleY
        return (
          <div key={r.id} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            {/* Badge */}
            <div style={{
              position: 'absolute', left: bx - 20, top: by - 12,
              background: bg, color: '#fff', borderRadius: 20,
              padding: '2px 8px', fontSize: 11, fontWeight: 700,
              boxShadow: '0 2px 6px rgba(0,0,0,.2)',
            }}>
              {online}/{devs.length}
            </div>
            {/* Device dots */}
            {devs.slice(0, 4).map((d, i) => (
              <div key={d.id} style={{
                position: 'absolute',
                left: cx - 12 + i * 18,
                top: cy - 6,
                width: 12, height: 12,
                borderRadius: '50%',
                background: sc(d.status),
                boxShadow: `0 0 6px ${sc(d.status)}88`,
              }}/>
            ))}
          </div>
        )
      })}
    </>
  )
}

// ─── IC Building Floor Plan ───────────────────────────────────────────────────

const FLOOR_1_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 920 520">
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

const FLOOR_2_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1020 520">
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

// ─── IC Floor Plan component ──────────────────────────────────────────────────

function ICFloorPlan({ devices, onBack, live = false, onViewRealtime }: { devices: Device[]; onBack: () => void; live?: boolean; onViewRealtime?: () => void }) {
  const [floor, setFloor] = useState<'1' | '2'>('1')
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null)
  const [liveDevices, setLiveDevices] = useState<Device[]>(devices)
  const [showLive, setShowLive] = useState(live)

  useEffect(() => { setLiveDevices(devices) }, [devices])
  useEffect(() => { setShowLive(live) }, [live])

  // Real-time subscription — only active in live mode
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

  const svgContent = floor === '1' ? FLOOR_1_SVG : FLOOR_2_SVG
  const rooms      = floor === '1' ? ROOMS_1ST : ROOMS_2ND
  const [vbW, vbH] = floor === '1' ? [920, 520] : [1020, 520]

  const containerW = containerRef?.offsetWidth ?? 800
  const scale      = containerW / vbW

  return (
    <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)' }}>
      {/* Header bar */}
      <div style={{ background: '#1e3a5f', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px' }}>
        <button onClick={onBack} style={{
          padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
          border: '1px solid rgba(255,255,255,.3)', background: 'rgba(255,255,255,.1)',
          color: '#fff', cursor: 'pointer',
        }}>← Back</button>

        <strong style={{ fontSize: 14, color: '#fff', marginRight: 4 }}>IC Building</strong>

        {onViewRealtime && (
          <button onClick={onViewRealtime} style={{
            padding: '4px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
            border: 'none', cursor: 'pointer',
            background: '#2563eb', color: '#fff',
            display: 'flex', alignItems: 'center', gap: 5,
          }}>
            <span style={{ fontSize: 11 }}>📡</span> Real-time Map →
          </button>
        )}

        {(['1','2'] as const).map(f => (
          <button key={f} onClick={() => setFloor(f)} style={{
            padding: '4px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
            border: 'none', cursor: 'pointer',
            background: floor === f ? '#fff' : 'rgba(255,255,255,.15)',
            color: floor === f ? '#1e3a5f' : '#fff',
          }}>
            {f}{f === '1' ? 'st' : 'nd'} Floor
          </button>
        ))}

        {/* Live Devices toggle */}
        <button onClick={() => setShowLive(v => !v)} style={{
          marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7,
          padding: '4px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
          border: '1px solid rgba(255,255,255,.3)',
          background: showLive ? '#16a34a' : 'rgba(255,255,255,.12)',
          color: '#fff', cursor: 'pointer',
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: showLive ? '#4ade80' : '#94a3b8',
            boxShadow: showLive ? '0 0 6px #4ade80' : 'none',
            display: 'inline-block',
            animation: showLive ? 'pulse 1.8s ease-in-out infinite' : 'none',
          }}/>
          Live Devices
        </button>
      </div>

      {/* Floor plan */}
      <div ref={setContainerRef} style={{ position: 'relative', background: '#f1f5f9', cursor: onViewRealtime ? 'pointer' : 'default' }}
        onClick={onViewRealtime ? onViewRealtime : undefined}
        title={onViewRealtime ? 'Tap to open Real-time Map' : undefined}>
        <div dangerouslySetInnerHTML={{ __html: svgContent.replace(/<svg /, '<svg style="width:100%;height:auto;display:block" ') }}
          style={{ lineHeight: 0 }}/>
        {showLive && (
          <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: `${vbH * scale}px`, pointerEvents: 'none' }}>
            <FloorOverlay rooms={rooms} devices={liveDevices} scaleX={scale} scaleY={scale}/>
          </div>
        )}
        {onViewRealtime && (
          <div style={{
            position: 'absolute', bottom: 12, right: 12,
            background: 'rgba(37,99,235,.88)', color: '#fff',
            borderRadius: 8, padding: '6px 14px', fontSize: 12, fontWeight: 600,
            pointerEvents: 'none', display: 'flex', alignItems: 'center', gap: 5,
            boxShadow: '0 2px 8px rgba(0,0,0,.2)',
          }}>
            <span>📡</span> Tap to view Real-time Map
          </div>
        )}
      </div>

      {/* Footer bar */}
      <div style={{ background: '#1e3a5f', color: '#fff', textAlign: 'center', padding: '10px', fontWeight: 700, fontSize: 13, letterSpacing: 2 }}>
        {floor === '1' ? '1ST FLOOR' : '2ND FLOOR'}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 20, padding: '8px 14px', fontSize: 12 }}>
        {[['#22c55e','Online'],['#f59e0b','Warning'],['#ef4444','Offline']].map(([c,l]) => (
          <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: c, display: 'inline-block' }}/>
            {l}
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Buildings View ───────────────────────────────────────────────────────────

function BuildingsView({ groups, onSelectBldg }: { groups: BldgGroup[]; onSelectBldg: (name: string) => void }) {
  const [tipIdx, setTipIdx] = useState<number | null>(null)
  const W = 900, H = 280

  const sorted = [...groups].sort((a, b) => b.total - a.total)
  const core = sorted[0]
  const rest = sorted.slice(1)

  const corePos = { x: W / 2, y: 70 }
  const restPos = rest.map((_, i) => ({
    x: rest.length === 1 ? W / 2 : 100 + (i / Math.max(rest.length - 1, 1)) * (W - 200),
    y: 190,
  }))
  const allPos    = [corePos, ...restPos]
  const allGroups = [core, ...rest]

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block', background: '#eef3f8', borderRadius: 8, minHeight: 200 }}>
        {/* Curved arc connections */}
        {rest.map((_, i) => {
          const x1 = corePos.x, y1 = corePos.y + 32
          const x2 = restPos[i].x, y2 = restPos[i].y - 35
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 + 20
          return (
            <path key={i}
              d={`M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`}
              fill="none" stroke="#9ca3af" strokeWidth="2" opacity="0.85"/>
          )
        })}

        {/* Building nodes */}
        {allGroups.map((g, i) => {
          if (!g) return null
          const { x, y } = allPos[i]
          const border = bldgBorder(g)
          const imgSize = 48
          return (
            <g key={g.name} transform={`translate(${x},${y})`}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setTipIdx(i)}
              onMouseLeave={() => setTipIdx(null)}
              onClick={() => onSelectBldg(g.name)}>
              {/* Border frame */}
              <rect x={-imgSize/2 - 3} y={-imgSize/2 - 3} width={imgSize + 6} height={imgSize + 6}
                rx="5" fill="white" stroke={border} strokeWidth="3"/>
              <image href={g.imageUrl} x={-imgSize/2} y={-imgSize/2} width={imgSize} height={imgSize}
                style={{ objectFit: 'cover', borderRadius: 3 }}/>
              <text y={imgSize/2 + 14} textAnchor="middle" fill="#1e293b" fontSize="11" fontWeight="700">{g.name}</text>
              <text y={imgSize/2 + 26} textAnchor="middle" fill="#64748b" fontSize="10">{g.online}/{g.total} online</text>
            </g>
          )
        })}

        {/* Tooltip */}
        {tipIdx !== null && allGroups[tipIdx] && (() => {
          const g = allGroups[tipIdx]
          const { x, y } = allPos[tipIdx]
          const tx = Math.min(x + 50, W - 185)
          const ty = Math.max(y - 100, 10)
          return (
            <g transform={`translate(${tx},${ty})`} style={{ pointerEvents: 'none' }}>
              <rect width="175" height="92" rx="6" fill="white" stroke={bldgBorder(g)} strokeWidth="1.5"
                style={{ filter: 'drop-shadow(0 2px 8px rgba(0,0,0,.12))' }}/>
              <text x="10" y="20" fill="#1e293b" fontSize="12" fontWeight="700">{g.name}</text>
              {[
                ['Total', g.total],
                ['Online', `${g.online} / ${g.total}`],
                ['Warning', g.warn],
                ['Offline', g.total - g.online - g.warn],
              ].map(([k, v], j) => (
                <g key={String(k)} transform={`translate(10,${36 + j * 14})`}>
                  <text fill="#64748b" fontSize="10">{k}</text>
                  <text x="80" fill="#1e293b" fontSize="10" fontWeight="600">{v}</text>
                </g>
              ))}
            </g>
          )
        })()}

        {/* Legend */}
        <g transform="translate(16,262)">
          {[['#22c55e','All online'],['#f59e0b','Partial'],['#ef4444','All offline']].map(([c,l],i) => (
            <g key={l} transform={`translate(${i*130},0)`}>
              <rect width="12" height="12" rx="3" fill={c}/>
              <text x="18" y="10" fill="#64748b" fontSize="11">{l}</text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  )
}

// ─── Floor-based Map ──────────────────────────────────────────────────────────

function FloorBasedMap({ groups, onSelectBldg }: { groups: BldgGroup[]; onSelectBldg: (name: string) => void }) {
  const [liveFilter, setLiveFilter] = useState<'active' | 'inactive'>('inactive')

  return (
    <div>
      {/* Header row with toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Select a Building to view its floor plan</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 0, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--accent)' }}>
          {(['active','inactive'] as const).map(f => (
            <button key={f} onClick={() => setLiveFilter(f)} style={{
              padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
              background: liveFilter === f ? 'var(--accent)' : 'transparent',
              color: liveFilter === f ? '#fff' : 'var(--accent)',
              transition: 'background .15s',
            }}>
              {f === 'active' ? '● Active' : '○ Inactive'}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 16 }}>
        {groups.map(g => {
          const shown = liveFilter === 'active'
            ? g.devices.filter(d => d.status === 'up')
            : g.devices.filter(d => d.status !== 'up')

          return (
            <div key={g.name} style={{
              background: 'white', borderRadius: 10, overflow: 'hidden',
              border: '1px solid var(--border)', boxShadow: '0 1px 4px rgba(0,0,0,.06)',
            }}>
              <div style={{ background: '#eef3f8', display: 'flex', justifyContent: 'center', padding: '20px 0 12px' }}>
                <Image src={g.imageUrl} alt={g.name} width={100} height={100}
                  style={{ objectFit: 'contain', borderRadius: 6 }}/>
              </div>
              <div style={{ padding: '12px 14px' }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{g.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>
                  {g.total} device{g.total !== 1 ? 's' : ''} · {g.online} online
                </div>

                {/* Device list filtered by toggle */}
                {shown.length > 0 ? (
                  <div style={{ marginBottom: 10 }}>
                    {shown.slice(0, 4).map(d => (
                      <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 3 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                          background: d.status === 'up' ? '#22c55e' : d.status === 'warn' ? '#f59e0b' : '#ef4444' }}/>
                        <span style={{ color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {d.name}
                        </span>
                      </div>
                    ))}
                    {shown.length > 4 && (
                      <div style={{ fontSize: 11, color: 'var(--text3)' }}>+{shown.length - 4} more</div>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10 }}>
                    No {liveFilter} devices
                  </div>
                )}

                {g.hasFloorPlan ? (
                  <button className="btn btn-sm" style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}
                    onClick={() => onSelectBldg(g.name)}>
                    View Floor Plan →
                  </button>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--text3)' }}>No floor plan available</span>
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

const FB: React.CSSProperties = {
  background: 'linear-gradient(180deg,#1a5c2a 0%,#124018 100%)',
  display: 'flex', alignItems: 'stretch',
  borderRadius: '10px 10px 0 0', borderBottom: '1px solid #0a2e14',
}
const FI: React.CSSProperties = {
  flex: 1, padding: '10px 16px',
  borderRight: '1px solid rgba(255,255,255,.1)',
  display: 'flex', flexDirection: 'column', gap: 4,
}
const FL: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,.55)',
  letterSpacing: '.1em', textTransform: 'uppercase',
  display: 'flex', alignItems: 'center', gap: 5,
}
const FS: React.CSSProperties = {
  background: 'rgba(0,0,0,.2)', border: '1px solid rgba(255,255,255,.15)',
  borderRadius: 6, color: '#fff', fontSize: 12, fontWeight: 500,
  padding: '5px 10px', cursor: 'pointer', outline: 'none', width: '100%',
}

// ─── Main Hub ─────────────────────────────────────────────────────────────────

export default function TopologyHub({ devs, clientCounts = {} }: {
  devs: Device[]
  clientCounts?: Record<string, number>
}) {
  const [viewMode,     setViewMode]     = useState<ViewMode>('buildings')
  const [bldgFilter,   setBldgFilter]   = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter,   setTypeFilter]   = useState('all')
  const [floorBldg,    setFloorBldg]    = useState<string | null>(null)

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

  const VIEW_OPTIONS = [
    { value: 'buildings' as ViewMode, label: 'Buildings View',  icon: '🏢' },
    { value: 'tree'      as ViewMode, label: 'Topology Tree',   icon: '🌐' },
    { value: 'floormap'  as ViewMode, label: 'Floor-based Map', icon: '🗺' },
    { value: 'realtime'  as ViewMode, label: 'Real-time Map',   icon: '📡' },
  ]

  // Floor plan detail overlay
  if (floorBldg) {
    const bldgDevices = devs.filter(d => d.location === floorBldg)
    return (
      <div>
        <FilterBar viewMode={viewMode} setViewMode={setViewMode} bldgFilter={bldgFilter}
          setBldgFilter={setBldgFilter} statusFilter={statusFilter} setStatusFilter={setStatusFilter}
          typeFilter={typeFilter} setTypeFilter={setTypeFilter}
          bldgGroups={bldgGroups} devs={devs} deviceTypes={deviceTypes} viewOptions={VIEW_OPTIONS}/>
        <div style={{ marginTop: 2 }}>
          <ICFloorPlan devices={bldgDevices} onBack={() => { setFloorBldg(null); setViewMode('buildings') }} live={viewMode === 'realtime'}
            onViewRealtime={viewMode !== 'realtime' ? () => setViewMode('realtime') : undefined}/>
        </div>
      </div>
    )
  }

  return (
    <div>
      <FilterBar viewMode={viewMode} setViewMode={setViewMode} bldgFilter={bldgFilter}
        setBldgFilter={setBldgFilter} statusFilter={statusFilter} setStatusFilter={setStatusFilter}
        typeFilter={typeFilter} setTypeFilter={setTypeFilter}
        bldgGroups={bldgGroups} devs={devs} deviceTypes={deviceTypes} viewOptions={VIEW_OPTIONS}/>

      <div className="card" style={{ borderRadius: '0 0 10px 10px', borderTop: 'none' }}>
        <div className="card-body" style={{ padding: viewMode === 'tree' ? 0 : 20 }}>

          {viewMode === 'buildings' && <BuildingsView groups={filteredGroups} onSelectBldg={name => { setFloorBldg(name); setViewMode('floormap') }}/>}

          {viewMode === 'tree' && (() => {
            if (scanLoading) return (
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--text3)' }}>
                <div style={{ fontSize: 28, marginBottom: 10 }}>📡</div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Scanning network…</div>
                <div style={{ fontSize: 12 }}>Running ICMP + ARP on {scanSubnet}.0/24</div>
              </div>
            )
            if (!scanDevs?.length) return (
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--text3)' }}>
                <div style={{ fontSize: 28, marginBottom: 10 }}>🔍</div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>No scan results yet</div>
                <div style={{ fontSize: 12, marginBottom: 16 }}>Run a discovery scan to see live topology</div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input className="form-input" style={{ width: 130, fontSize: 12 }}
                    value={scanSubnet}
                    onChange={e => { setScanSubnet(e.target.value); localStorage.setItem('nms_scan_subnet', e.target.value) }}
                    placeholder="192.168.1"/>
                  <button className="btn btn-sm btn-primary" onClick={() => fetchScan()}>Scan Now</button>
                </div>
              </div>
            )
            const treeDevs = scanDevs.filter(d =>
              (statusFilter === 'all' || d.status === statusFilter) &&
              (typeFilter   === 'all' || d.type   === typeFilter)
            )
            return (
              <div>
                {/* Tree toolbar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: '#f8fafc', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                  <span style={{ color: 'var(--text3)' }}>
                    {scanDevs.length} devices discovered · {scanDevs.filter(d => d.status === 'up').length} online
                  </span>
                  <span style={{ flex: 1 }}/>
                  <input className="form-input" style={{ width: 120, fontSize: 11 }}
                    value={scanSubnet}
                    onChange={e => { setScanSubnet(e.target.value); localStorage.setItem('nms_scan_subnet', e.target.value) }}
                    placeholder="192.168.1"/>
                  <button className="btn btn-sm" onClick={() => { setScanDevs(null); fetchScan(scanSubnet) }} disabled={scanLoading}>
                    {scanLoading ? 'Scanning…' : '↺ Rescan'}
                  </button>
                </div>
                <TopologyCanvas devs={treeDevs} clientCounts={clientCounts}/>
              </div>
            )
          })()}

          {viewMode === 'floormap' && (
            <FloorBasedMap
              groups={filteredGroups}
              onSelectBldg={name => { setFloorBldg(name); setViewMode('realtime') }}/>
          )}

          {viewMode === 'realtime' && (
            filteredGroups.some(g => g.hasFloorPlan) ? (
              filteredGroups.filter(g => g.hasFloorPlan).map(g => (
                <ICFloorPlan key={g.name} devices={g.devices} onBack={() => setViewMode('floormap')} live/>
              ))
            ) : (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)' }}>
                <div style={{ fontSize: 32, marginBottom: 10 }}>🗺</div>
                <div style={{ fontWeight: 600 }}>No floor plan for selected building</div>
                <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => setViewMode('floormap')}>
                  ← Select a Building
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
        <div style={FL}><span>⊞</span> VIEW MODE</div>
        <select style={FS} value={viewMode} onChange={e => setViewMode(e.target.value as ViewMode)}>
          {viewOptions.map(o => <option key={o.value} value={o.value}>{o.icon} {o.label}</option>)}
        </select>
      </div>
      <div style={FI}>
        <div style={FL}><span>🏗</span> BUILDING ZONE</div>
        <select style={FS} value={bldgFilter} onChange={e => setBldgFilter(e.target.value)}>
          <option value="all">All Buildings ({bldgGroups.reduce((s,g)=>s+g.total,0)})</option>
          {bldgGroups.map(g => <option key={g.name} value={g.name}>{g.name} ({g.total})</option>)}
        </select>
      </div>
      <div style={FI}>
        <div style={FL}><span>📶</span> OPERATIONAL STATUS</div>
        <select style={FS} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="all">All Statuses ({devs.length})</option>
          <option value="up">Online ({devs.filter(d=>d.status==='up').length})</option>
          <option value="warn">Warning ({devs.filter(d=>d.status==='warn').length})</option>
          <option value="down">Offline ({devs.filter(d=>d.status==='down').length})</option>
        </select>
      </div>
      <div style={{ ...FI, borderRight: 'none' }}>
        <div style={FL}><span>⚙</span> DEVICE TYPE</div>
        <select style={FS} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="all">All Devices ({devs.length})</option>
          {deviceTypes.map(t => <option key={t} value={t}>{t} ({devs.filter(d=>d.type===t).length})</option>)}
        </select>
      </div>
    </div>
  )
}
