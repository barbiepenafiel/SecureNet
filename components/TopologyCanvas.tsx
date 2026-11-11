'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import type { Device } from '@/lib/database.types'

// ─────────────────────────────────────────────────────────────────────────────
// Topology tree
//   Gateway (top) → one lane per network (subnet) → devices in rows.
//   Links: gateway → network (curved), network → devices (trunk + bus + drops,
//   so lines never cross cards). Colours follow device status.
// ─────────────────────────────────────────────────────────────────────────────

// ── Status ────────────────────────────────────────────────────────────────────
const STATUS: Record<string, { color: string; bg: string; label: string }> = {
  up:          { color: '#16a34a', bg: '#f0fdf4', label: 'Online' },
  warn:        { color: '#d97706', bg: '#fffbeb', label: 'Warning' },
  unreachable: { color: '#f59e0b', bg: '#fffbeb', label: 'Unreachable' },
  down:        { color: '#dc2626', bg: '#fef2f2', label: 'Offline' },
  unknown:     { color: '#94a3b8', bg: '#f8fafc', label: 'Unknown' },
  maint:       { color: '#7c3aed', bg: '#f5f3ff', label: 'Maintenance' },
}
const st = (s: string) => STATUS[s] ?? STATUS.unknown

// ── Network helpers ───────────────────────────────────────────────────────────
const subnet3 = (ip: string) => ip.split('.').slice(0, 3).join('.')
const lastOct = (ip: string) => parseInt(ip.split('.')[3] ?? '0', 10)
const isGwIp  = (ip: string) => { const o = lastOct(ip); return o === 1 || o === 254 }

function networkLabel(sub: string, devs: Device[]) {
  if (devs.some(d => /virtualbox|vmware|hyper-v|qemu/i.test(d.vendor ?? '')) || sub === '192.168.56') return 'Virtual network'
  if (devs.some(d => d.name.includes('(agent)'))) return 'Agent network'
  return 'Network'
}

// ── Layout ────────────────────────────────────────────────────────────────────
const CW = 200, CH = 72        // device card
const GX = 22                  // gap between cards in a row
const ROW_GAP = 44             // vertical gap between rows (room for the bus line)
const LANE_GAP = 56            // gap between network lanes
const PER_ROW = 4              // cards per row in a lane
const PAD = 40
const ROOT_W = 230, ROOT_H = 78
const HEAD_W = 260, HEAD_H = 48
const Y_ROOT = 30
const Y_HEAD = Y_ROOT + ROOT_H + 64
const Y_ROW0 = Y_HEAD + HEAD_H + 58

type Card = { dev: Device; x: number; y: number; row: number }       // x,y = top-left
type Lane = {
  sub: string; label: string; devs: Device[]
  x: number; width: number                                         // lane box
  head: { x: number; y: number }                                   // centre-top of head chip
  cards: Card[]; rows: number
}
type Layout = { W: number; H: number; root: Device | null; lanes: Lane[]; yRoot: number; yHead: number; yRow0: number; rowGap: number }

// targetRatio = height/width of the space on screen. When there is spare height the
// vertical spacing grows to use it, so the diagram fills the canvas.
function layout(devs: Device[], targetRatio = 0): Layout {
  if (!devs.length) return { W: 900, H: 300, root: null, lanes: [], yRoot: Y_ROOT, yHead: Y_HEAD, yRow0: Y_ROW0, rowGap: ROW_GAP }

  // Group by /24
  const bySub = new Map<string, Device[]>()
  for (const d of devs) {
    const s = subnet3(d.ip)
    if (!bySub.has(s)) bySub.set(s, [])
    bySub.get(s)!.push(d)
  }

  // Root = the gateway (.1/.254) of the busiest network; prefer routers / APs
  const gws = devs.filter(d => isGwIp(d.ip))
  gws.sort((a, b) =>
    (bySub.get(subnet3(b.ip))!.length - bySub.get(subnet3(a.ip))!.length) ||
    (Number(/router|access point|firewall/i.test(b.type)) - Number(/router|access point|firewall/i.test(a.type))))
  const root = gws[0] ?? devs.find(d => /router/i.test(d.type)) ?? null
  const rootSub = root ? subnet3(root.ip) : null

  // Lanes: root's network first, then the others by size
  const subs = [...bySub.keys()].sort((a, b) =>
    (a === rootSub ? -1 : b === rootSub ? 1 : 0) || bySub.get(b)!.length - bySub.get(a)!.length || a.localeCompare(b))

  const lanes: Lane[] = []
  let x = PAD
  for (const sub of subs) {
    const laneDevs = bySub.get(sub)!
      .filter(d => d.id !== root?.id)
      .sort((a, b) => Number(isGwIp(b.ip)) - Number(isGwIp(a.ip)) || lastOct(a.ip) - lastOct(b.ip))
    if (!laneDevs.length) continue
    const cols  = Math.min(PER_ROW, laneDevs.length)
    const rows  = Math.ceil(laneDevs.length / PER_ROW)
    const width = Math.max(HEAD_W, cols * CW + (cols - 1) * GX + (rows > 1 ? 24 : 0))
    const cards: Card[] = laneDevs.map((dev, i) => {
      const row = Math.floor(i / PER_ROW), col = i % PER_ROW
      const inRow = Math.min(PER_ROW, laneDevs.length - row * PER_ROW)
      const rowW = inRow * CW + (inRow - 1) * GX
      const left = x + (rows > 1 ? 24 : 0) + ((width - (rows > 1 ? 24 : 0)) - rowW) / 2
      return { dev, row, x: left + col * (CW + GX), y: 0 }
    })
    lanes.push({ sub, label: networkLabel(sub, bySub.get(sub)!), devs: laneDevs, x, width, head: { x: x + width / 2, y: 0 }, cards, rows })
    x += width + LANE_GAP
  }

  const contentW = x - LANE_GAP + PAD
  const W = Math.max(900, contentW, ROOT_W + PAD * 2)
  // Centre everything if the canvas is wider than the content
  const shift = (W - contentW) / 2
  if (shift > 0) for (const l of lanes) { l.x += shift; l.head.x += shift; l.cards.forEach(c => { c.x += shift }) }

  const maxRows = Math.max(1, ...lanes.map(l => l.rows))
  const naturalH = Y_ROW0 + maxRows * CH + (maxRows - 1) * ROW_GAP + 24

  // Spread spare height over the gaps (top, gateway→networks, networks→rows, between rows)
  const extra = targetRatio > 0 ? Math.max(0, Math.min(targetRatio * W - naturalH, naturalH * 1.5)) : 0
  const yRoot  = Y_ROOT + extra * 0.08
  const yHead  = Y_HEAD + extra * 0.45
  const yRow0  = Y_ROW0 + extra * 0.70
  const rowGap = ROW_GAP + (maxRows > 1 ? extra * 0.22 / (maxRows - 1) : 0)
  const H = Math.round(naturalH + extra)
  for (const l of lanes) {
    l.head.y = yHead
    l.cards.forEach(c => { c.y = yRow0 + c.row * (CH + rowGap) })
  }
  return { W, H, root, lanes, yRoot, yHead, yRow0, rowGap }
}

// ── Icons (24×24, drawn in the card's status colour) ─────────────────────────
function DeviceIcon({ dev, color }: { dev: Device; color: string }) {
  const t = `${dev.type} ${dev.vendor ?? ''} ${dev.name}`.toLowerCase()
  const p = { fill: 'none', stroke: color, strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (/router|access point|firewall|gateway/.test(t)) return (
    <g {...p}><rect x="3" y="13" width="18" height="7" rx="2"/><circle cx="7" cy="16.5" r=".6" fill={color}/><circle cx="10" cy="16.5" r=".6" fill={color}/>
      <path d="M12 13V9"/><path d="M8.5 7.5a5 5 0 0 1 7 0"/><path d="M6 5a8.5 8.5 0 0 1 12 0"/></g>)
  if (/switch/.test(t)) return (
    <g {...p}><rect x="2" y="8" width="20" height="8" rx="2"/>{[6, 9.5, 13, 16.5].map(cx => <rect key={cx} x={cx - 1} y="11" width="2" height="2" fill={color} stroke="none"/>)}</g>)
  if (/server|vm\b|virtualbox|vmware|hyper-v|qemu/.test(t)) return (
    <g {...p}><rect x="4" y="3" width="16" height="7" rx="1.5"/><rect x="4" y="14" width="16" height="7" rx="1.5"/>
      <circle cx="8" cy="6.5" r=".7" fill={color}/><circle cx="8" cy="17.5" r=".7" fill={color}/></g>)
  if (/private mac|phone|android|iphone/.test(t)) return (
    <g {...p}><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></g>)
  return (
    <g {...p}><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6"/><path d="M12 16v4"/></g>)
}

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// ── Main ──────────────────────────────────────────────────────────────────────
export default function TopologyCanvas({ devs, clientCounts = {} }: {
  devs: Device[]
  clientCounts?: Record<string, number>
}) {
  const [hover,    setHover]    = useState<{ dev: Device; x: number; y: number } | null>(null)
  const [selected, setSelected] = useState<Device | null>(null)
  const [zoom,     setZoom]     = useState(1)
  const wrapRef = useRef<HTMLDivElement>(null)

  // The diagram fills the rest of the screen (no empty space below it)
  const [boxH, setBoxH] = useState(560)
  const [boxW, setBoxW] = useState(0)

  // In "Fit" mode the layout stretches vertically to the canvas's shape
  const L = useMemo(() => layout(devs, zoom === 1 && boxW ? boxH / boxW : 0), [devs, zoom, boxH, boxW])
  const hoverLane = hover ? L.lanes.find(l => l.cards.some(c => c.dev.id === hover.dev.id))?.sub : null

  useEffect(() => {
    const fit = () => {
      const el = wrapRef.current
      if (!el) return
      const top = el.getBoundingClientRect().top + window.scrollY
      const LEGEND_AND_PADDING = 66
      setBoxH(Math.max(380, Math.round(window.innerHeight - top - LEGEND_AND_PADDING)))
      setBoxW(el.clientWidth)
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  // Hover card uses screen coordinates so it's never clipped by the canvas
  function showTip(e: React.MouseEvent, dev: Device) {
    setHover({ dev, x: e.clientX, y: e.clientY })
  }

  const rootCx = L.W / 2
  const rootBottom = L.yRoot + ROOT_H

  return (
    <div>
      {/* ── Zoom ── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, padding: '6px 10px 0' }}>
        {[['−', () => setZoom(z => Math.max(.6, +(z - .2).toFixed(1)))], ['Fit', () => setZoom(1)], ['+', () => setZoom(z => Math.min(2, +(z + .2).toFixed(1)))]].map(([l, fn]) => (
          <button suppressHydrationWarning key={l as string} className="btn btn-sm" onClick={fn as () => void}
            style={{ minWidth: 34, justifyContent: 'center', padding: '2px 8px' }} title={l === 'Fit' ? 'Fit to width' : l === '+' ? 'Zoom in' : 'Zoom out'}>{l as string}</button>
        ))}
      </div>

      <div ref={wrapRef} style={{ position: 'relative', overflow: 'auto', height: boxH }} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${L.W} ${L.H}`}
          width={zoom === 1 ? '100%' : `${zoom * 100}%`}
          height={zoom === 1 ? '100%' : undefined}
          preserveAspectRatio="xMidYMid meet"
          style={{ display: 'block', minWidth: zoom > 1 ? undefined : 640, fontFamily: 'var(--font)', background: 'linear-gradient(180deg,#f8fbff,#eef4fa)' }}>
          <defs>
            <pattern id="topo-dots" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill="#cbd5e1" opacity=".55"/>
            </pattern>
            <linearGradient id="topo-bg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#f8fbff"/><stop offset="1" stopColor="#eef4fa"/>
            </linearGradient>
            <filter id="topo-shadow" x="-20%" y="-20%" width="140%" height="160%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#0f172a" floodOpacity=".10"/>
            </filter>
            <style>{`
              .topo-flow { stroke-dasharray: 5 7; animation: topo-flow 1.1s linear infinite; }
              @keyframes topo-flow { to { stroke-dashoffset: -12; } }
              @media (prefers-reduced-motion: reduce) { .topo-flow { animation: none; } }
              .topo-card { transition: opacity .15s; }
            `}</style>
          </defs>
          <rect width={L.W} height={L.H} fill="url(#topo-bg)"/>
          <rect width={L.W} height={L.H} fill="url(#topo-dots)"/>

          {/* ── Lane backgrounds ── */}
          {L.lanes.map(l => (
            <rect key={`lane-${l.sub}`} x={l.x - 14} y={L.yHead - 14} width={l.width + 28}
              height={L.H - L.yHead - 4} rx="14"
              fill={hoverLane === l.sub ? 'rgba(14,165,233,.06)' : 'rgba(255,255,255,.55)'}
              stroke="#dbe5f0" strokeDasharray="5 5"/>
          ))}

          {/* ── Gateway → network links ── */}
          {L.root && L.lanes.map(l => {
            const y1 = rootBottom, y2 = l.head.y
            const my = (y1 + y2) / 2
            const d = `M${rootCx},${y1} C${rootCx},${my} ${l.head.x},${my} ${l.head.x},${y2}`
            const anyUp = l.devs.some(x => x.status === 'up' || x.status === 'warn')
            return (
              <g key={`up-${l.sub}`}>
                <path d={d} fill="none" stroke="#bae6fd" strokeWidth="6" strokeLinecap="round"/>
                <path d={d} fill="none" stroke="#0ea5e9" strokeWidth="2" className={anyUp ? 'topo-flow' : undefined}/>
              </g>
            )
          })}

          {/* ── Network → device links (trunk, row bus, drop) ── */}
          {L.lanes.map(l => {
            const hx = l.head.x, hb = l.head.y + HEAD_H
            const trunkX = l.rows > 1 ? l.x + 8 : hx
            const busYs = Array.from({ length: l.rows }, (_, r) => L.yRow0 + r * (CH + L.rowGap) - 22)
            return (
              <g key={`links-${l.sub}`} opacity={hoverLane && hoverLane !== l.sub ? .35 : 1}>
                {/* trunk: head → each row's bus */}
                <path d={l.rows > 1
                  ? `M${hx},${hb} V${busYs[0] - 0} H${trunkX} V${busYs[busYs.length - 1]}`
                  : `M${hx},${hb} V${busYs[0]}`}
                  fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinejoin="round"/>
                {busYs.map((by, r) => {
                  const rowCards = l.cards.filter(c => c.row === r)
                  const xs = rowCards.map(c => c.x + CW / 2)
                  const from = Math.min(r === 0 ? hx : trunkX, ...xs), to = Math.max(r === 0 ? hx : trunkX, ...xs)
                  return <path key={`bus-${r}`} d={`M${from},${by} H${to}`} stroke="#94a3b8" strokeWidth="2" fill="none"/>
                })}
                {/* drops, coloured by the device's status */}
                {l.cards.map(c => {
                  const s = st(c.dev.status)
                  const cx = c.x + CW / 2
                  const live = c.dev.status === 'up' || c.dev.status === 'warn'
                  const dim = hover && hover.dev.id !== c.dev.id
                  return (
                    <g key={`drop-${c.dev.id}`} opacity={dim ? .45 : 1}>
                      <circle cx={cx} cy={busYs[c.row]} r="3" fill="#94a3b8"/>
                      <path d={`M${cx},${busYs[c.row]} V${c.y}`} stroke={s.color} strokeWidth="2.5"
                        strokeDasharray={c.dev.status === 'down' ? '4 4' : undefined}
                        className={live ? 'topo-flow' : undefined} fill="none"/>
                    </g>
                  )
                })}
              </g>
            )
          })}

          {/* ── Gateway (root) ── */}
          {L.root && (() => {
            const r = L.root, s = st(r.status)
            return (
              <g transform={`translate(${rootCx - ROOT_W / 2},${L.yRoot})`} style={{ cursor: 'pointer' }}
                onMouseMove={e => showTip(e, r)} onMouseLeave={() => setHover(null)}
                onClick={() => setSelected(x => x?.id === r.id ? null : r)}>
                <rect width={ROOT_W} height={ROOT_H} rx="14" fill="white" stroke="#0ea5e9" strokeWidth="2.5" filter="url(#topo-shadow)"/>
                <rect width={ROOT_W} height={ROOT_H} rx="14" fill="none" stroke="#0ea5e9" strokeWidth="8" opacity=".10"/>
                <rect x="14" y="17" width="44" height="44" rx="10" fill="#e0f2fe"/>
                <g transform="translate(24,27)"><DeviceIcon dev={{ ...r, type: 'Router' }} color="#0284c7"/></g>
                <text x="70" y="27" fontSize="10" fontWeight="700" fill="#0284c7" letterSpacing=".08em">GATEWAY</text>
                <text x="70" y="45" fontSize="14" fontWeight="700" fill="#0f172a">{trunc(r.name, 20)}</text>
                <text x="70" y="62" fontSize="11" fill="#64748b" fontFamily="var(--mono)">{r.ip}</text>
                <circle cx={ROOT_W - 16} cy="16" r="6" fill={s.color} stroke="white" strokeWidth="2"/>
              </g>
            )
          })()}

          {/* ── Network heads ── */}
          {L.lanes.map(l => {
            const counts = { up: 0, warn: 0, down: 0 }
            l.devs.forEach(d => { if (d.status === 'up') counts.up++; else if (d.status === 'warn' || d.status === 'unreachable') counts.warn++; else if (d.status === 'down') counts.down++ })
            return (
              <g key={`head-${l.sub}`} transform={`translate(${l.head.x - HEAD_W / 2},${l.head.y})`}>
                <rect width={HEAD_W} height={HEAD_H} rx="24" fill="#0f172a" filter="url(#topo-shadow)"/>
                <text x="20" y="21" fontSize="13" fontWeight="700" fill="white" fontFamily="var(--mono)">{l.sub}.0/24</text>
                <text x="20" y="37" fontSize="10.5" fill="#94a3b8">{l.label} · {l.devs.length} device{l.devs.length === 1 ? '' : 's'}</text>
                {/* mini health: online / warning / offline */}
                <line x1={HEAD_W - 88} y1="12" x2={HEAD_W - 88} y2={HEAD_H - 12} stroke="#334155"/>
                {[['#22c55e', counts.up, 'online'], ['#f59e0b', counts.warn, 'warning'], ['#ef4444', counts.down, 'offline']].map(([c, n, t], i) => (
                  <g key={i} transform={`translate(${HEAD_W - 66 + i * 23},24)`}>
                    <title>{`${n} ${t}`}</title>
                    <circle r="9" fill={n ? c as string : '#334155'}/>
                    <text y="3.5" textAnchor="middle" fontSize="9.5" fontWeight="700" fill="white">{n as number}</text>
                  </g>
                ))}
              </g>
            )
          })}

          {/* ── Device cards ── */}
          {L.lanes.flatMap(l => l.cards).map(c => {
            const d = c.dev, s = st(d.status)
            const isSel = selected?.id === d.id
            const dim = hover && hover.dev.id !== d.id
            const sub = d.vendor && !/^Private MAC/.test(d.vendor) ? d.vendor : d.mac ?? d.type
            return (
              <g key={d.id} className="topo-card" transform={`translate(${c.x},${c.y})`} style={{ cursor: 'pointer' }}
                opacity={dim ? .55 : d.status === 'down' || d.status === 'unknown' ? .85 : 1}
                onMouseMove={e => showTip(e, d)} onMouseLeave={() => setHover(null)}
                onClick={() => setSelected(x => x?.id === d.id ? null : d)}>
                <rect width={CW} height={CH} rx="11" fill="white"
                  stroke={isSel ? '#7c3aed' : s.color} strokeWidth={isSel ? 2.5 : 1.5}
                  strokeDasharray={d.status === 'down' ? '5 4' : undefined} filter="url(#topo-shadow)"/>
                <rect x="0" y="0" width="5" height={CH} rx="2.5" fill={s.color}/>
                <rect x="13" y="16" width="40" height="40" rx="10" fill={s.bg}/>
                <g transform="translate(21,24)"><DeviceIcon dev={d} color={s.color}/></g>
                <text x="63" y="24" fontSize="13.5" fontWeight="700" fill="#0f172a">{trunc(d.name, 19)}</text>
                <text x="63" y="42" fontSize="11.5" fill="#475569" fontFamily="var(--mono)">{d.ip}</text>
                <text x="63" y="60" fontSize="10.5" fill="#94a3b8">{trunc(sub, s.label.length > 8 ? 9 : 12)}</text>
                {/* status pill (bottom-right, never covers the name) */}
                {(() => {
                  const pw = s.label.length * 6.2 + 16
                  return (
                    <g transform={`translate(${CW - 10 - pw},50)`}>
                      <rect width={pw} height="16" rx="8" fill={s.bg} stroke={s.color} strokeWidth=".9"/>
                      <text x={pw / 2} y="11.5" textAnchor="middle" fontSize="9.5" fontWeight="700" fill={s.color}>{s.label}</text>
                    </g>
                  )
                })()}
              </g>
            )
          })}

          {!L.lanes.length && (
            <text x={L.W / 2} y={L.H / 2} textAnchor="middle" fill="#94a3b8" fontSize="13">No devices match the current filters</text>
          )}
        </svg>

        {/* ── Hover details ── */}
        {hover && (() => {
          const d = hover.dev, s = st(d.status)
          const rows: [string, string][] = [
            ['IP', d.ip], ['MAC', d.mac ?? '—'], ['Type', d.type], ['Vendor', d.vendor ?? '—'],
            ['Location', !d.location || d.location === 'Unassigned' ? 'Unassigned' : d.location],
            ['Last seen', d.last_seen ? new Date(d.last_seen).toLocaleTimeString() : '—'],
            ['Detected by', d.last_method ?? '—'],
          ]
          // Keep the card on screen: flip left/up near the edges
          const left = hover.x + 252 > window.innerWidth ? hover.x - 252 : hover.x + 16
          const top  = hover.y + 230 > window.innerHeight ? hover.y - 230 : hover.y + 14
          return (
            <div style={{
              position: 'fixed', left, top, width: 236, pointerEvents: 'none', zIndex: 50,
              background: 'white', border: `1px solid ${s.color}55`, borderRadius: 10,
              boxShadow: '0 10px 30px rgba(15,23,42,.18)', overflow: 'hidden', fontSize: 12,
            }}>
              <div style={{ background: s.bg, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</strong>
                <span style={{ color: s.color, fontWeight: 700, fontSize: 11 }}>● {s.label}</span>
              </div>
              <div style={{ padding: '8px 12px', display: 'grid', gridTemplateColumns: '76px 1fr', rowGap: 3 }}>
                {rows.map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <span style={{ color: '#94a3b8' }}>{k}</span>
                    <span style={{ fontFamily: ['IP', 'MAC'].includes(k) ? 'var(--mono)' : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )
        })()}
      </div>

      {/* ── Legend ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', alignItems: 'center', padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text2)' }}>
        {(['up', 'warn', 'unreachable', 'down', 'unknown'] as const).map(k => (
          <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: STATUS[k].color }}/>{STATUS[k].label}
          </span>
        ))}
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <svg width="28" height="8"><path d="M0 4H28" stroke="#16a34a" strokeWidth="2.5" strokeDasharray="5 7"/></svg>live link
          <svg width="28" height="8" style={{ marginLeft: 10 }}><path d="M0 4H28" stroke="#dc2626" strokeWidth="2.5" strokeDasharray="4 4"/></svg>offline link
        </span>
      </div>

      {/* ── Selected device ── */}
      {selected && (() => {
        const s = st(selected.status)
        const fields: [string, string][] = [
          ['IP', selected.ip], ['MAC', selected.mac ?? '—'], ['Type', selected.type], ['Vendor', selected.vendor ?? '—'],
          ['Hostname', selected.hostname ?? '—'], ['Network', selected.subnet ?? `${subnet3(selected.ip)}.0/24`],
          ['Location', !selected.location || selected.location === 'Unassigned' ? 'Unassigned' : selected.location],
          ['First detected', selected.first_seen ? new Date(selected.first_seen).toLocaleString() : '—'],
          ['Last seen', selected.last_seen ? new Date(selected.last_seen).toLocaleString() : '—'],
          ['Detected by', selected.last_method ?? '—'],
          ['Uptime', selected.uptime || '—'],
          ['CPU / Mem', selected.cpu ? `${selected.cpu}% / ${selected.mem}%` : '—'],
        ]
        return (
          <div style={{ borderTop: `3px solid ${s.color}`, background: 'white', padding: '14px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{selected.name}</span>
              <span style={{ background: s.bg, color: s.color, fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 10, border: `1px solid ${s.color}55` }}>{s.label}</span>
              {selected.source === 'discovered' && <span className="chip chip-info" style={{ fontSize: 10 }}>Auto-discovered</span>}
              {selected.type === 'Access Point' && <span style={{ fontSize: 12, color: 'var(--text3)' }}>{clientCounts[selected.name] ?? 0} wireless clients</span>}
              <a href="/devices" className="btn btn-sm" style={{ marginLeft: 'auto' }}>Open in Devices</a>
              <button suppressHydrationWarning className="btn btn-sm" onClick={() => setSelected(null)}>Close ×</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '8px 18px' }}>
              {fields.map(([k, v]) => (
                <div key={k}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.04em' }}>{k}</div>
                  <div style={{ fontSize: 12.5, fontFamily: ['IP', 'MAC', 'Network'].includes(k) ? 'var(--mono)' : undefined }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
