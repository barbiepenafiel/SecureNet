'use client'

import { useState, useMemo } from 'react'
import type { Device } from '@/lib/database.types'

// ── Canvas dimensions ─────────────────────────────────────────────────────────
const W = 1160, H = 680

// ── Status helpers ────────────────────────────────────────────────────────────
function sc(s: string) {
  return s === 'up' ? '#22c55e' : s === 'warn' ? '#f59e0b' : s === 'down' ? '#ef4444' : '#94a3b8'
}

// ── Subnet helpers ────────────────────────────────────────────────────────────
function subnet3(ip: string) { return ip.split('.').slice(0, 3).join('.') }
function lastOct(ip: string)  { return parseInt(ip.split('.')[3] ?? '0', 10) }
function isGw(ip: string)     { const o = lastOct(ip); return o === 1 || o === 254 }

// ── Tree types ────────────────────────────────────────────────────────────────
type TNode = { dev: Device; children: TNode[] }

function buildTree(devs: Device[]): { root: TNode | null; orphans: Device[] } {
  if (!devs.length) return { root: null, orphans: [] }

  // Root = topmost router — when multiple Router+gateway IPs exist on different subnets,
  // pick the one with the lexicographically smallest subnet (upstream wins over downstream)
  const gwRouters = devs.filter(d => d.type === 'Router' && isGw(d.ip))
  const root =
    (gwRouters.length > 1
      ? gwRouters.sort((a, b) => subnet3(a.ip).localeCompare(subnet3(b.ip)))[0]
      : gwRouters[0]) ??
    devs.find(d => isGw(d.ip)) ??
    devs.find(d => d.type === 'Router') ??
    devs.find(d => d.type === 'Firewall') ??
    devs[0]

  const used = new Set<string | number>([root.id])
  const rootSub = subnet3(root.ip)

  // Group remaining devices by subnet
  const bySub = new Map<string, Device[]>()
  devs.filter(d => !used.has(d.id)).forEach(d => {
    const s = subnet3(d.ip)
    if (!bySub.has(s)) bySub.set(s, [])
    bySub.get(s)!.push(d)
  })

  const level1: TNode[] = []

  bySub.forEach((subDevs, sub) => {
    subDevs.forEach(d => used.add(d.id))

    if (sub === rootSub) {
      // Same subnet as root → direct children, ordered by last octet
      const sorted = [...subDevs].sort((a, b) => lastOct(a.ip) - lastOct(b.ip))
      sorted.forEach(d => level1.push({ dev: d, children: [] }))
    } else {
      // Different subnet → look for a sub-gateway
      const gw = subDevs.find(d => isGw(d.ip))
      const rest = subDevs.filter(d => d.id !== gw?.id)
      if (gw) {
        level1.push({
          dev: gw,
          children: rest.map(d => ({ dev: d, children: [] })),
        })
      } else {
        subDevs.forEach(d => level1.push({ dev: d, children: [] }))
      }
    }
  })

  // Sort level1: gateways first, then by IP
  level1.sort((a, b) => {
    const aGw = isGw(a.dev.ip) ? 0 : 1
    const bGw = isGw(b.dev.ip) ? 0 : 1
    if (aGw !== bGw) return aGw - bGw
    return a.dev.ip.localeCompare(b.dev.ip)
  })

  const orphans = devs.filter(d => !used.has(d.id))

  return { root: { dev: root, children: level1 }, orphans }
}

// ── Positioned node ───────────────────────────────────────────────────────────
type Placed = { dev: Device; x: number; y: number; parentId?: string | number; parentX?: number; parentY?: number }

function layoutPlaced(devs: Device[]): Placed[] {
  const { root, orphans } = buildTree(devs)
  if (!root) return []

  const PAD  = 60
  const L0_Y = 100   // root
  const L1_Y = 290   // level 1
  const L2_Y = 490   // level 2
  const ORF_Y = 590  // orphans

  const placed: Placed[] = []

  // Root
  placed.push({ dev: root.dev, x: W / 2, y: L0_Y })

  // Level 1 — spread evenly
  const l1 = root.children
  const l1X = l1.map((_, i) =>
    l1.length === 1 ? W / 2 : PAD + i * ((W - PAD * 2) / (l1.length - 1))
  )

  l1.forEach((n, i) => {
    const px = l1X[i]
    placed.push({ dev: n.dev, x: px, y: L1_Y, parentId: root.dev.id, parentX: W / 2, parentY: L0_Y })

    // Level 2 — spread below parent
    const l2 = n.children
    if (!l2.length) return
    const spread = Math.min((l2.length - 1) * 110, 220)
    l2.forEach((n2, j) => {
      const cx = l2.length === 1 ? px : px - spread / 2 + j * (spread / (l2.length - 1))
      placed.push({ dev: n2.dev, x: cx, y: L2_Y, parentId: n.dev.id, parentX: px, parentY: L1_Y })
    })
  })

  // Orphans row
  if (orphans.length) {
    orphans.forEach((d, i) => {
      placed.push({ dev: d, x: PAD + i * ((W - PAD * 2) / Math.max(orphans.length - 1, 1)), y: ORF_Y })
    })
  }

  return placed
}

// ── SVG icon helpers ──────────────────────────────────────────────────────────
function isRouterLike(type: string) {
  return type === 'Router' || type === 'Access Point' || type === 'Firewall'
}

function MonitorIcon({ color, scale = 1 }: { color: string; scale?: number }) {
  const s = scale
  return (
    <g transform={`scale(${s})`}>
      {/* screen */}
      <rect x="-20" y="-18" width="40" height="28" rx="3" fill="#f1f5f9" stroke={color} strokeWidth="2"/>
      {/* stand */}
      <rect x="-4" y="10" width="8" height="7"  rx="1"   fill={color} opacity=".7"/>
      <rect x="-11" y="17" width="22" height="3" rx="1.5" fill={color} opacity=".7"/>
    </g>
  )
}

// ── Node box ──────────────────────────────────────────────────────────────────
const NW = 86, NH = 74   // node box w/h
const RW = 100, RH = 88  // root node w/h (larger)

function NodeBox({ dev, x, y, isRoot, selected, onEnter, onLeave, onClick }: {
  dev: Device; x: number; y: number
  isRoot: boolean
  selected: boolean
  onEnter: (e: React.MouseEvent<SVGGElement>) => void
  onLeave: () => void
  onClick: () => void
}) {
  const bw = isRoot ? RW : NW
  const bh = isRoot ? RH : NH
  const border = isRoot ? '#0ea5e9'   // cyan/blue for root
    : selected ? '#7c3aed'
    : sc(dev.status)
  const router = isRouterLike(dev.type)
  const shortName = dev.name.length > 14 ? dev.name.slice(0, 13) + '…' : dev.name

  return (
    <g transform={`translate(${x},${y})`}
      style={{ cursor: 'pointer' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}>
      {/* Drop shadow */}
      <rect x={-bw/2+3} y={-bh/2+4} width={bw} height={bh}
        rx="10" fill="rgba(0,0,0,.13)"/>
      {/* Box */}
      <rect x={-bw/2} y={-bh/2} width={bw} height={bh}
        rx="10" fill="white"
        stroke={border} strokeWidth={isRoot ? 4 : 3}/>
      {/* Root glow */}
      {isRoot && (
        <rect x={-bw/2} y={-bh/2} width={bw} height={bh}
          rx="10" fill="none"
          stroke={border} strokeWidth="8" opacity=".12"/>
      )}

      {/* Icon — root always gets router icon; others by type */}
      {(isRoot || router) ? (
        <image href="/images/router-icon.png"
          x={isRoot ? -18 : -16} y={-bh/2 + 6}
          width={isRoot ? 36 : 32}
          height={isRoot ? 36 : 32}/>
      ) : (
        <g transform={`translate(0,${-bh/2 + (isRoot ? 22 : 18)})`}>
          <MonitorIcon color={border} scale={isRoot ? 0.9 : 0.8}/>
        </g>
      )}

      {/* Name */}
      <text y={bh/2 - 26} textAnchor="middle"
        fill="#1e293b" fontSize={isRoot ? 12 : 11} fontWeight="700"
        style={{ userSelect: 'none' }}>
        {shortName}
      </text>
      {/* IP */}
      <text y={bh/2 - 10} textAnchor="middle"
        fill="#64748b" fontSize={10}
        style={{ userSelect: 'none' }}>
        {dev.ip}
      </text>

      {/* Status dot */}
      <circle cx={bw/2 - 9} cy={-bh/2 + 9} r={isRoot ? 7 : 6}
        fill={isRoot ? '#0ea5e9' : sc(dev.status)}
        stroke="white" strokeWidth="2"/>
    </g>
  )
}

// ── Cable line + label ────────────────────────────────────────────────────────
function CableLine({ x1, y1, x2, y2, label }: {
  x1: number; y1: number; x2: number; y2: number; label: string
}) {
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const angle = Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI)
  // Keep label readable (flip if going right-to-left downward)
  const flip = angle > 90 || angle < -90

  return (
    <g>
      {/* Cable shadow */}
      <line x1={x1} y1={y1} x2={x2} y2={y2}
        stroke="rgba(0,0,0,.12)" strokeWidth="6" strokeLinecap="round"/>
      {/* Cable body */}
      <line x1={x1} y1={y1} x2={x2} y2={y2}
        stroke="#9ca3af" strokeWidth="3" strokeLinecap="round"/>
      {/* Inner highlight */}
      <line x1={x1} y1={y1} x2={x2} y2={y2}
        stroke="rgba(255,255,255,.35)" strokeWidth="1" strokeLinecap="round"/>
      {/* Label */}
      <text
        transform={`translate(${mx},${my}) rotate(${flip ? angle + 180 : angle})`}
        textAnchor="middle" dy={-7}
        fill="#6b7280" fontSize="9" fontWeight="600" letterSpacing=".05em"
        style={{ userSelect: 'none' }}>
        {label}
      </text>
    </g>
  )
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
type Tip = { x: number; y: number; dev: Device }

function Tooltip({ tip }: { tip: Tip }) {
  const { x, y, dev } = tip
  const tx = Math.min(x + 16, W - 192)
  const ty = Math.max(y - 20, 8)
  const rows: [string, string][] = [
    ['Type',     dev.type],
    ['IP',       dev.ip],
    ['Status',   dev.status.toUpperCase()],
    ['Location', dev.location],
    ['CPU',      dev.cpu ? `${dev.cpu}%` : '—'],
    ['Memory',   dev.mem ? `${dev.mem}%` : '—'],
  ]
  return (
    <g transform={`translate(${tx},${ty})`} style={{ pointerEvents: 'none' }}>
      <rect width="184" height="130" rx="8"
        fill="white" stroke={sc(dev.status)} strokeWidth="2"
        style={{ filter: 'drop-shadow(0 4px 16px rgba(0,0,0,.18))' }}/>
      <rect width="184" height="26" rx="8" fill={sc(dev.status)} opacity=".15"/>
      <text x="10" y="17" fill="#1e293b" fontSize="12" fontWeight="700">{dev.name}</text>
      <circle cx="168" cy="13" r="6" fill={sc(dev.status)}/>
      {rows.map(([k, v], i) => (
        <g key={k} transform={`translate(10,${36 + i * 16})`}>
          <text fill="#94a3b8" fontSize="10">{k}</text>
          <text x="66" fill="#1e293b" fontSize="10" fontWeight="600">{v}</text>
        </g>
      ))}
    </g>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function TopologyCanvas({ devs, clientCounts = {} }: {
  devs: Device[]
  clientCounts?: Record<string, number>
}) {
  const [tip,      setTip]      = useState<Tip | null>(null)
  const [selected, setSelected] = useState<Device | null>(null)

  const placed = useMemo(() => layoutPlaced(devs), [devs])

  const posMap = useMemo(() => {
    const m = new Map<string | number, Placed>()
    placed.forEach(p => m.set(p.dev.id, p))
    return m
  }, [placed])

  const rootDev = placed[0]?.dev ?? null

  function connLabel(dev: Device, parentDev: Device | undefined): string {
    if (!parentDev) return ''
    // Router-to-Router or Router-to-Switch = wired Ethernet uplink
    if (dev.type === 'Router' || dev.type === 'Firewall' || dev.type === 'Switch') return 'Ethernet'
    // Everything else (AP, Client, Server) hanging off a router = WiFi
    return 'WiFi'
  }

  function handleEnter(e: React.MouseEvent<SVGGElement>, dev: Device) {
    const svg = (e.currentTarget as SVGElement).closest('svg')!
    const rect = svg.getBoundingClientRect()
    setTip({
      x: ((e.clientX - rect.left) / rect.width)  * W,
      y: ((e.clientY - rect.top)  / rect.height) * H,
      dev,
    })
  }

  // Link endpoint: bottom-center of parent, top-center of child
  function linkPts(p: Placed) {
    const pBh = p.dev.id === rootDev?.id ? RH : NH
    return { x: p.x, y: p.y + pBh / 2 }
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`}
        style={{ display: 'block', background: 'linear-gradient(160deg,#dbe8f5 0%,#eef4fc 60%,#e4eef8 100%)', borderRadius: 10, fontFamily: 'var(--font)' }}
        onMouseLeave={() => setTip(null)}>

        {/* Subtle dot grid */}
        <defs>
          <pattern id="cg" x="0" y="0" width="36" height="36" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="#c5d6e8" opacity=".6"/>
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#cg)"/>

        {/* ── Cable lines (drawn before nodes so nodes sit on top) ── */}
        {placed.map(p => {
          if (!p.parentId) return null
          const par = posMap.get(p.parentId)
          if (!par) return null

          // Parent: exit from bottom-center; Child: enter at top-center
          const parBh = par.dev.id === rootDev?.id ? RH : NH
          const cBh   = NH

          const lx1 = par.x,  ly1 = par.y + parBh / 2
          const lx2 = p.x,    ly2 = p.y   - cBh  / 2

          const label = connLabel(p.dev, par.dev)

          return (
            <CableLine key={`cable-${p.dev.id}`}
              x1={lx1} y1={ly1} x2={lx2} y2={ly2}
              label={label}/>
          )
        })}

        {/* ── Nodes ── */}
        {placed.map(p => (
          <NodeBox key={p.dev.id}
            dev={p.dev} x={p.x} y={p.y}
            isRoot={p.dev.id === rootDev?.id}
            selected={selected?.id === p.dev.id}
            onEnter={e => handleEnter(e, p.dev)}
            onLeave={() => setTip(null)}
            onClick={() => setSelected(s => s?.id === p.dev.id ? null : p.dev)}
          />
        ))}

        {/* ── Subnet grouping labels ── */}
        {(() => {
          const subLabels = new Map<string, { minX: number; maxX: number; y: number }>()
          placed.slice(1).forEach(p => {
            const sub = subnet3(p.dev.ip)
            const existing = subLabels.get(sub)
            if (!existing) subLabels.set(sub, { minX: p.x, maxX: p.x, y: p.y })
            else {
              existing.minX = Math.min(existing.minX, p.x)
              existing.maxX = Math.max(existing.maxX, p.x)
            }
          })
          return [...subLabels.entries()].map(([sub, { minX, maxX, y }]) => {
            if (minX === maxX) return null // single node, no bracket needed
            return (
              <g key={`sub-${sub}`} style={{ pointerEvents: 'none' }}>
                <line x1={minX - 50} y1={y + NH/2 + 12} x2={maxX + 50} y2={y + NH/2 + 12}
                  stroke="#94a3b8" strokeWidth="1" strokeDasharray="4,3" opacity=".5"/>
                <text x={(minX + maxX)/2} y={y + NH/2 + 26}
                  textAnchor="middle" fill="#94a3b8" fontSize="9" fontWeight="600" opacity=".7">
                  {sub}.0/24
                </text>
              </g>
            )
          })
        })()}

        {/* ── Legend ── */}
        <g transform="translate(16,654)">
          {[['#0ea5e9','Root/Gateway'],['#22c55e','Online'],['#f59e0b','Warning'],['#ef4444','Offline']].map(([c,l],i) => (
            <g key={l} transform={`translate(${i * 150},0)`}>
              <circle cx="6" cy="6" r="6" fill={c}/>
              <text x="18" y="11" fill="#64748b" fontSize="11">{l}</text>
            </g>
          ))}
          <g transform="translate(620,0)">
            <line x1="0" y1="6" x2="30" y2="6" stroke="#9ca3af" strokeWidth="3" strokeLinecap="round"/>
            <text x="38" y="11" fill="#64748b" fontSize="11">Network link</text>
          </g>
        </g>

        {/* ── Tooltip ── */}
        {tip && <Tooltip tip={tip}/>}
      </svg>

      {/* ── Selected panel ── */}
      {selected && (
        <div style={{
          borderTop: `2px solid ${sc(selected.status)}`,
          background: 'white', padding: '14px 20px',
          display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start',
        }}>
          <div style={{ minWidth: 220 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{selected.name}</span>
              <span style={{ background: sc(selected.status)+'22', color: sc(selected.status), fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4 }}>
                {selected.status.toUpperCase()}
              </span>
            </div>
            {([
              ['Type',      selected.type],
              ['IP',        selected.ip],
              ['Location',  selected.location],
              ['Uptime',    selected.uptime  || '—'],
              ['CPU / Mem', selected.cpu ? `${selected.cpu}% / ${selected.mem}%` : '—'],
            ] as [string,string][]).map(([k,v]) => (
              <div key={k} style={{ display: 'flex', gap: 8, fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: '#94a3b8', width: 72 }}>{k}</span>
                <span style={{ fontFamily: 'monospace' }}>{v}</span>
              </div>
            ))}
          </div>
          {selected.type === 'Access Point' && (
            <div>
              <div style={{ fontWeight: 600, fontSize: 12, color: '#94a3b8', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.05em' }}>Wireless Clients</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#3b82f6' }}>{clientCounts[selected.name] ?? 0}</div>
            </div>
          )}
          <button onClick={() => setSelected(null)}
            style={{ marginLeft: 'auto', background: 'none', border: '1px solid #e2e8f0', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', color: '#94a3b8', fontSize: 12 }}>
            Close ×
          </button>
        </div>
      )}
    </div>
  )
}
