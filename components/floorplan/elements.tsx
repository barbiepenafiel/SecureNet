'use client'

import type { Device } from '@/lib/database.types'
import type { El, ElKind, IconKey } from '@/lib/floor-designs'

// ── Element library ──────────────────────────────────────────────────────────

export type Category = 'Basic shapes' | 'Floor plan' | 'Network & campus' | 'Labels & notes'

export interface LibItem {
  key: string
  label: string
  category: Category
  keywords?: string
  make: () => Omit<El, 'id' | 'x' | 'y'>
}

const shape = (kind: ElKind, w: number, h: number, extra: Partial<El> = {}) => (): Omit<El, 'id' | 'x' | 'y'> => ({
  kind, w, h, rot: 0, fill: '#e8f3ec', stroke: '#3d5a47', strokeW: 2, opacity: 1, ...extra,
})
const label = (kind: ElKind, w: number, h: number, text: string, fontSize: number, extra: Partial<El> = {}) =>
  shape(kind, w, h, { fill: 'transparent', stroke: 'transparent', strokeW: 0, text, fontSize, align: 'center', textColor: '#0f2318', ...extra })
const sym = (icon: IconKey) => shape('sym', 48, 48, { icon, fill: '#ffffff', stroke: '#3d5a47', strokeW: 1.5 })

export const LIBRARY: LibItem[] = [
  { key: 'rect',     label: 'Rectangle', category: 'Basic shapes', make: shape('rect', 160, 100) },
  { key: 'square',   label: 'Square',    category: 'Basic shapes', make: shape('square', 100, 100) },
  { key: 'circle',   label: 'Circle',    category: 'Basic shapes', make: shape('circle', 100, 100) },
  { key: 'ellipse',  label: 'Ellipse',   category: 'Basic shapes', make: shape('ellipse', 160, 100) },
  { key: 'triangle', label: 'Triangle',  category: 'Basic shapes', make: shape('triangle', 120, 100) },
  { key: 'polygon',  label: 'Polygon',   category: 'Basic shapes', keywords: 'hexagon custom shape', make: shape('polygon', 120, 104, {
    points: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]] }) },
  { key: 'line',     label: 'Line',      category: 'Basic shapes', make: shape('line', 200, 12, { fill: 'transparent', stroke: '#3d5a47', strokeW: 3 }) },
  { key: 'arrow',    label: 'Arrow',     category: 'Basic shapes', make: shape('arrow', 200, 16, { fill: 'transparent', stroke: '#3d5a47', strokeW: 3 }) },

  { key: 'wall',     label: 'Wall',      category: 'Floor plan', make: shape('wall', 240, 12, { fill: '#3d4a42', stroke: 'transparent', strokeW: 0 }) },
  { key: 'room',     label: 'Room',      category: 'Floor plan', make: shape('room', 240, 160, {
    fill: 'rgba(22,163,74,.06)', stroke: '#3d5a47', strokeW: 3, text: 'Room', roomNumber: '', fontSize: 16, textColor: '#0f2318' }) },
  { key: 'door',     label: 'Door',      category: 'Floor plan', make: shape('door', 60, 60, { fill: 'transparent', stroke: '#3d5a47', strokeW: 2 }) },
  { key: 'window',   label: 'Window',    category: 'Floor plan', make: shape('window', 90, 12, { fill: '#e0f2fe', stroke: '#0891b2', strokeW: 2 }) },
  { key: 'corridor', label: 'Corridor',  category: 'Floor plan', keywords: 'hallway', make: shape('corridor', 320, 80, {
    fill: '#f4f7f5', stroke: '#b8d4c4', strokeW: 2, text: 'Corridor', fontSize: 13, textColor: '#6b8a76' }) },
  { key: 'stairs',   label: 'Staircase', category: 'Floor plan', keywords: 'stairs steps', make: shape('stairs', 100, 140, { fill: '#ffffff', stroke: '#3d5a47', strokeW: 2 }) },
  { key: 'elevator', label: 'Elevator',  category: 'Floor plan', keywords: 'lift', make: shape('elevator', 80, 80, { fill: '#ffffff', stroke: '#3d5a47', strokeW: 2 }) },
  { key: 'entrance', label: 'Entrance',  category: 'Floor plan', make: shape('entrance', 110, 44, { fill: '#e8f3ec', stroke: '#16a34a', strokeW: 2, text: 'Entrance', fontSize: 13, textColor: '#15803d' }) },
  { key: 'exit',     label: 'Exit',      category: 'Floor plan', keywords: 'emergency', make: shape('exit', 90, 40, { fill: '#16a34a', stroke: '#15803d', strokeW: 2, text: 'EXIT', fontSize: 15, textColor: '#ffffff' }) },

  { key: 'router',   label: 'Router',          category: 'Network & campus', make: sym('router') },
  { key: 'switch',   label: 'Switch',          category: 'Network & campus', make: sym('switch') },
  { key: 'ap',       label: 'Access point',    category: 'Network & campus', keywords: 'wireless wifi wap', make: sym('ap') },
  { key: 'server',   label: 'Server',          category: 'Network & campus', make: sym('server') },
  { key: 'computer', label: 'Computer',        category: 'Network & campus', keywords: 'pc desktop', make: sym('computer') },
  { key: 'rack',     label: 'Network rack',    category: 'Network & campus', keywords: 'cabinet', make: sym('rack') },
  { key: 'cctv',     label: 'CCTV camera',     category: 'Network & campus', keywords: 'camera security', make: sym('cctv') },
  { key: 'printer',  label: 'Printer',         category: 'Network & campus', make: sym('printer') },
  { key: 'firewall', label: 'Firewall',        category: 'Network & campus', make: sym('firewall') },
  { key: 'other',    label: 'Other device',    category: 'Network & campus', keywords: 'generic network', make: sym('other') },

  { key: 'text',         label: 'Text',          category: 'Labels & notes', make: label('text', 160, 30, 'Text', 16) },
  { key: 'roomName',     label: 'Room name',     category: 'Labels & notes', make: label('roomName', 180, 30, 'Room name', 18) },
  { key: 'roomNumber',   label: 'Room number',   category: 'Labels & notes', make: label('roomNumber', 90, 30, 'R-101', 15, { textColor: '#3d5a47' }) },
  { key: 'floorLabel',   label: 'Floor label',   category: 'Labels & notes', make: label('floorLabel', 240, 40, 'Ground Floor', 24) },
  { key: 'buildingName', label: 'Building name', category: 'Labels & notes', make: label('buildingName', 320, 48, 'Building', 30) },
  { key: 'note',         label: 'Note',          category: 'Labels & notes', keywords: 'sticky comment', make: shape('note', 180, 110, {
    fill: '#fff7d6', stroke: '#e5c96b', strokeW: 1, text: 'Note', fontSize: 13, align: 'left', textColor: '#3d3a1a' }) },
  { key: 'legend',       label: 'Legend',        category: 'Labels & notes', keywords: 'status key', make: shape('legend', 190, 120, {
    fill: '#ffffff', stroke: '#b8d4c4', strokeW: 1, fontSize: 12, textColor: '#0f2318' }) },
]

export const CATEGORIES: Category[] = ['Basic shapes', 'Floor plan', 'Network & campus', 'Labels & notes']

// ── Icons (24 × 24, stroked) ─────────────────────────────────────────────────

export const ICON_PATHS: Record<IconKey, string> = {
  router:   'M3 14h18v6H3z M7 17h.01 M11 17h.01 M8 14V10 M16 14V10 M5.5 7.5a9 9 0 0 1 5-2.5 M13.5 5a9 9 0 0 1 5 2.5',
  switch:   'M2 8h20v8H2z M6 12h.01 M10 12h.01 M14 12h.01 M18 12h.01',
  ap:       'M2 9a15 15 0 0 1 20 0 M5 12.5a10 10 0 0 1 14 0 M8.5 16a5 5 0 0 1 7 0 M12 19.5h.01',
  server:   'M4 3h16v7H4z M4 14h16v7H4z M8 6.5h.01 M8 17.5h.01 M12 6.5h5 M12 17.5h5',
  computer: 'M3 4h18v12H3z M8 20h8 M12 16v4',
  rack:     'M5 2h14v20H5z M8 6h8 M8 10h8 M8 14h8 M8 18h8',
  cctv:     'M3 8l12-3 2 6-12 3z M8 13l1 4H4 M17 8l4-1v5l-4-1',
  printer:  'M6 9V3h12v6 M6 18H4v-7h16v7h-2 M6 14h12v7H6z',
  firewall: 'M3 4h18v16H3z M3 9h18 M3 14h18 M9 4v5 M15 9v5 M9 14v6',
  other:    'M12 2l9 5v10l-9 5-9-5V7z M12 12l9-5 M12 12v10 M12 12L3 7',
}

export function iconForType(type: string | null | undefined): IconKey {
  const t = (type ?? '').toLowerCase()
  if (t.includes('router')) return 'router'
  if (t.includes('switch')) return 'switch'
  if (t.includes('access') || t.includes('wireless') || t === 'ap') return 'ap'
  if (t.includes('server')) return 'server'
  if (t.includes('firewall')) return 'firewall'
  if (t.includes('camera') || t.includes('cctv')) return 'cctv'
  if (t.includes('printer')) return 'printer'
  if (t.includes('computer') || t.includes('client') || t.includes('pc') || t.includes('laptop')) return 'computer'
  return 'other'
}

export function Icon({ k, size = 18, color = 'currentColor' }: { k: IconKey; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICON_PATHS[k]} />
    </svg>
  )
}

// ── Device status colours (from the monitoring agent's latest check) ────────

export const STATUS_COLOR = { online: '#16a34a', warning: '#d97706', offline: '#dc2626', other: '#8a9a90' }
export function statusOf(d: Pick<Device, 'status'> | undefined): { label: string; color: string } {
  switch (d?.status) {
    case 'up': return { label: 'Online', color: STATUS_COLOR.online }
    case 'warn': return { label: 'Warning', color: STATUS_COLOR.warning }
    case 'unreachable': return { label: 'Warning', color: STATUS_COLOR.warning }
    case 'down': return { label: 'Offline', color: STATUS_COLOR.offline }
    case 'maint': return { label: 'Maintenance', color: STATUS_COLOR.other }
    case 'unknown': return { label: 'Not checked', color: STATUS_COLOR.other }
    default: return { label: d ? d.status : 'Device removed', color: STATUS_COLOR.other }
  }
}

// ── Drawing one element (SVG, canvas units) ─────────────────────────────────

// Simple word wrap for SVG text (no foreignObject, so PNG export stays possible)
function wrap(text: string, width: number, fontSize: number): string[] {
  const maxChars = Math.max(1, Math.floor(width / (fontSize * 0.56)))
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word
      if (next.length > maxChars && line) { out.push(line); line = word } else line = next
    }
    out.push(line)
  }
  return out
}

function TextBlock({ el, x, y, w, h, bold }: { el: El; x: number; y: number; w: number; h: number; bold?: boolean }) {
  if (!el.text) return null
  const fs = el.fontSize ?? 14
  const lines = wrap(el.text, w - 8, fs)
  const anchor = el.align === 'left' ? 'start' : el.align === 'right' ? 'end' : 'middle'
  const tx = el.align === 'left' ? x + 6 : el.align === 'right' ? x + w - 6 : x + w / 2
  const lh = fs * 1.25
  const top = el.align === 'left' && el.kind === 'note' ? y + 8 + fs : y + h / 2 - ((lines.length - 1) * lh) / 2
  return (
    <text x={tx} y={top} textAnchor={anchor} dominantBaseline={el.kind === 'note' ? 'auto' : 'central'}
      fontSize={fs} fontWeight={bold ? 700 : 500} fill={el.textColor ?? '#0f2318'} fontFamily="Inter, system-ui, sans-serif"
      style={{ pointerEvents: 'none', userSelect: 'none' }}>
      {lines.map((l, i) => <tspan key={i} x={tx} dy={i ? lh : 0}>{l}</tspan>)}
    </text>
  )
}

export function ElementView({ el, devices }: { el: El; devices: Map<string, Device> }) {
  const { x, y, w, h } = el
  const cx = x + w / 2, cy = y + h / 2
  const common = { fill: el.fill, stroke: el.stroke, strokeWidth: el.strokeW }
  let body: React.ReactNode

  switch (el.kind) {
    case 'rect': case 'square':
      body = <><rect x={x} y={y} width={w} height={h} {...common} /><TextBlock el={el} x={x} y={y} w={w} h={h} /></>; break
    case 'circle': case 'ellipse':
      body = <><ellipse cx={cx} cy={cy} rx={w / 2} ry={h / 2} {...common} /><TextBlock el={el} x={x} y={y} w={w} h={h} /></>; break
    case 'triangle':
      body = <><polygon points={`${cx},${y} ${x + w},${y + h} ${x},${y + h}`} {...common} /><TextBlock el={el} x={x} y={y + h * .25} w={w} h={h * .75} /></>; break
    case 'polygon': {
      const pts = (el.points ?? [[0, 0], [1, 0], [1, 1], [0, 1]]).map(([px, py]) => `${x + px * w},${y + py * h}`).join(' ')
      const fs = el.fontSize ?? 16
      body = <>
        <polygon points={pts} {...common} />
        {el.roomNumber === undefined ? <TextBlock el={el} x={x} y={y} w={w} h={h} /> : <>
          {el.text && <text x={cx} y={el.roomNumber ? cy - fs * .55 : cy} textAnchor="middle" dominantBaseline="central" fontSize={fs} fontWeight={700}
            fill={el.textColor ?? '#0f2318'} fontFamily="Inter, system-ui, sans-serif" style={{ pointerEvents: 'none' }}>{el.text}</text>}
          {el.roomNumber && <text x={cx} y={el.text ? cy + fs * .65 : cy} textAnchor="middle" dominantBaseline="central" fontSize={fs * .78}
            fill="#6b8a76" fontFamily="Inter, system-ui, sans-serif" style={{ pointerEvents: 'none' }}>{el.roomNumber}</text>}
        </>}
      </>; break
    }
    case 'line':
      body = <line x1={x} y1={cy} x2={x + w} y2={cy} stroke={el.stroke} strokeWidth={el.strokeW} strokeLinecap="round" />; break
    case 'arrow': {
      const head = Math.min(18, w / 3, Math.max(8, el.strokeW * 3.5))
      body = <>
        <line x1={x} y1={cy} x2={x + w - head * .8} y2={cy} stroke={el.stroke} strokeWidth={el.strokeW} strokeLinecap="round" />
        <polygon points={`${x + w},${cy} ${x + w - head},${cy - head / 2} ${x + w - head},${cy + head / 2}`} fill={el.stroke} />
      </>; break
    }
    case 'wall':
      body = <rect x={x} y={y} width={w} height={h} fill={el.fill} stroke={el.stroke} strokeWidth={el.strokeW} />; break
    case 'room': {
      const fs = el.fontSize ?? 16
      body = <>
        <rect x={x} y={y} width={w} height={h} {...common} />
        {el.text && <text x={cx} y={el.roomNumber ? cy - fs * .55 : cy} textAnchor="middle" dominantBaseline="central" fontSize={fs} fontWeight={700}
          fill={el.textColor ?? '#0f2318'} fontFamily="Inter, system-ui, sans-serif" style={{ pointerEvents: 'none' }}>{el.text}</text>}
        {el.roomNumber && <text x={cx} y={el.text ? cy + fs * .65 : cy} textAnchor="middle" dominantBaseline="central" fontSize={fs * .78}
          fill="#6b8a76" fontFamily="Inter, system-ui, sans-serif" style={{ pointerEvents: 'none' }}>{el.roomNumber}</text>}
      </>; break
    }
    case 'door':
      body = <>
        <rect x={x} y={y} width={w} height={h} fill="transparent" stroke="none" />
        <line x1={x} y1={y + h} x2={x} y2={y} stroke={el.stroke} strokeWidth={el.strokeW} />
        <path d={`M ${x} ${y} A ${w} ${h} 0 0 1 ${x + w} ${y + h}`} fill="none" stroke={el.stroke} strokeWidth={Math.max(1, el.strokeW / 2)} strokeDasharray="4 3" />
        <line x1={x} y1={y + h} x2={x + w} y2={y + h} stroke={el.stroke} strokeWidth={Math.max(1, el.strokeW / 2)} opacity={.4} />
      </>; break
    case 'window':
      body = <>
        <rect x={x} y={y} width={w} height={h} fill={el.fill} stroke={el.stroke} strokeWidth={el.strokeW} />
        <line x1={x} y1={cy} x2={x + w} y2={cy} stroke={el.stroke} strokeWidth={1} />
      </>; break
    case 'corridor':
      body = <><rect x={x} y={y} width={w} height={h} {...common} strokeDasharray="8 6" /><TextBlock el={el} x={x} y={y} w={w} h={h} /></>; break
    case 'stairs': {
      const steps = Math.max(3, Math.round(h / 16))
      body = <>
        <rect x={x} y={y} width={w} height={h} {...common} />
        {Array.from({ length: steps - 1 }, (_, i) => <line key={i} x1={x} x2={x + w} y1={y + (h / steps) * (i + 1)} y2={y + (h / steps) * (i + 1)} stroke={el.stroke} strokeWidth={1} />)}
        <line x1={cx} y1={y + h - 8} x2={cx} y2={y + 10} stroke={el.stroke} strokeWidth={1.5} />
        <polygon points={`${cx},${y + 4} ${cx - 6},${y + 14} ${cx + 6},${y + 14}`} fill={el.stroke} />
      </>; break
    }
    case 'elevator':
      body = <>
        <rect x={x} y={y} width={w} height={h} {...common} />
        <line x1={x} y1={y} x2={x + w} y2={y + h} stroke={el.stroke} strokeWidth={1} />
        <line x1={x + w} y1={y} x2={x} y2={y + h} stroke={el.stroke} strokeWidth={1} />
        <rect x={cx - 14} y={cy - 9} width={28} height={18} rx={3} fill="#ffffff" stroke={el.stroke} strokeWidth={1} />
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight={700} fill={el.stroke} fontFamily="Inter, system-ui, sans-serif">LIFT</text>
      </>; break
    case 'entrance':
      body = <>
        <rect x={x} y={y} width={w} height={h} rx={6} {...common} />
        <path d={`M ${x + 10} ${cy} h 14 m -5 -5 l 5 5 l -5 5`} fill="none" stroke={el.textColor ?? '#15803d'} strokeWidth={2} />
        <TextBlock el={{ ...el, align: 'center' }} x={x + 18} y={y} w={w - 18} h={h} bold />
      </>; break
    case 'exit':
      body = <><rect x={x} y={y} width={w} height={h} rx={4} {...common} /><TextBlock el={el} x={x} y={y} w={w} h={h} bold /></>; break
    case 'sym': {
      const s = Math.min(w, h) * .62
      body = <>
        <rect x={x} y={y} width={w} height={h} rx={Math.min(w, h) * .2} {...common} />
        <g transform={`translate(${cx - s / 2},${cy - s / 2}) scale(${s / 24})`}>
          <path d={ICON_PATHS[el.icon ?? 'other']} fill="none" stroke={el.stroke} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </g>
        {el.text && <TextBlock el={{ ...el, fontSize: el.fontSize ?? 11 }} x={x - 30} y={y + h + 2} w={w + 60} h={(el.fontSize ?? 11) * 1.6} />}
      </>; break
    }
    case 'device': {
      const d = el.deviceId ? devices.get(el.deviceId) : undefined
      const st = statusOf(d)
      const r = Math.min(w, h) / 2
      const s = r * 1.15
      const name = d?.name ?? 'Device removed'
      const fs = el.fontSize ?? 11
      body = <>
        <circle cx={cx} cy={cy} r={r} fill="#ffffff" stroke={st.color} strokeWidth={3} />
        <g transform={`translate(${cx - s / 2},${cy - s / 2}) scale(${s / 24})`}>
          <path d={ICON_PATHS[iconForType(d?.type)]} fill="none" stroke="#0f2318" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </g>
        <circle cx={cx + r * .72} cy={cy - r * .72} r={Math.max(4, r * .28)} fill={st.color} stroke="#ffffff" strokeWidth={2} />
        <text x={cx} y={y + h + fs + 2} textAnchor="middle" fontSize={fs} fontWeight={600} fill="#0f2318" fontFamily="Inter, system-ui, sans-serif"
          stroke="#ffffff" strokeWidth={3} paintOrder="stroke" style={{ pointerEvents: 'none' }}>{name}</text>
        {d && <text x={cx} y={y + h + fs * 2.2 + 2} textAnchor="middle" fontSize={fs * .85} fill="#3d5a47" fontFamily="JetBrains Mono, monospace"
          stroke="#ffffff" strokeWidth={3} paintOrder="stroke" style={{ pointerEvents: 'none' }}>{d.ip}</text>}
      </>; break
    }
    case 'note':
      body = <>
        <path d={`M ${x} ${y} h ${w} v ${h - 16} l -16 16 h ${-(w - 16)} z`} {...common} />
        <TextBlock el={el} x={x} y={y} w={w} h={h} />
      </>; break
    case 'legend': {
      const fs = el.fontSize ?? 12
      const rows: [string, string][] = [['Online', STATUS_COLOR.online], ['Warning', STATUS_COLOR.warning], ['Offline', STATUS_COLOR.offline], ['Not checked', STATUS_COLOR.other]]
      const lh = (h - fs * 2.2) / rows.length
      body = <>
        <rect x={x} y={y} width={w} height={h} rx={6} {...common} />
        <text x={x + 10} y={y + fs * 1.4} fontSize={fs} fontWeight={700} fill={el.textColor ?? '#0f2318'} fontFamily="Inter, system-ui, sans-serif">Device status</text>
        {rows.map(([l, c], i) => {
          const ry = y + fs * 2.2 + lh * i + lh / 2
          return <g key={l}>
            <circle cx={x + 16} cy={ry} r={Math.min(6, lh / 3)} fill={c} />
            <text x={x + 28} y={ry} dominantBaseline="central" fontSize={fs} fill={el.textColor ?? '#0f2318'} fontFamily="Inter, system-ui, sans-serif">{l}</text>
          </g>
        })}
      </>; break
    }
    default: // text, roomName, roomNumber, floorLabel, buildingName
      body = <>
        {el.fill !== 'transparent' && <rect x={x} y={y} width={w} height={h} {...common} />}
        <TextBlock el={el} x={x} y={y} w={w} h={h} bold={el.kind === 'roomName' || el.kind === 'floorLabel' || el.kind === 'buildingName'} />
      </>
  }

  return (
    <g transform={el.rot ? `rotate(${el.rot} ${cx} ${cy})` : undefined} opacity={el.opacity}>
      {body}
    </g>
  )
}

// What counts as a room: the Room / Shape room tools, and any labelled
// rectangle, square, circle, ellipse or polygon (e.g. a box named "AB1-2")
export const isRoomLike = (e: El) =>
  e.kind === 'room' || (e.kind === 'polygon' && e.roomNumber !== undefined) ||
  (['rect', 'square', 'circle', 'ellipse', 'polygon'] as ElKind[]).includes(e.kind) && !!e.text?.trim()

// Which elements are thin lines (resize only along their length)
export const isLinear = (k: ElKind) => k === 'line' || k === 'arrow' || k === 'wall' || k === 'window'
// Which elements carry text a user can edit
export const hasText = (k: ElKind) => !['line', 'arrow', 'wall', 'door', 'window', 'stairs', 'elevator', 'device', 'legend'].includes(k)
export const KIND_LABEL: Record<ElKind, string> = {
  rect: 'Rectangle', square: 'Square', circle: 'Circle', ellipse: 'Ellipse', triangle: 'Triangle', polygon: 'Polygon',
  line: 'Line', arrow: 'Arrow', wall: 'Wall', room: 'Room', door: 'Door', window: 'Window', corridor: 'Corridor',
  stairs: 'Staircase', elevator: 'Elevator', entrance: 'Entrance', exit: 'Exit', sym: 'Network symbol', device: 'Device',
  text: 'Text', roomName: 'Room name', roomNumber: 'Room number', floorLabel: 'Floor label', buildingName: 'Building name',
  note: 'Note', legend: 'Legend',
}
