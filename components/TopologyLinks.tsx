'use client'

import { useMemo, useState } from 'react'
import type { Device } from '@/lib/database.types'

// ─────────────────────────────────────────────────────────────────────────────
// Connection tree: each device under the device it is actually connected to
// (devices.parent_id). Links come from the agent (a router's ARP / bridge
// table over SNMP, or "same network as the gateway") or are set by hand in
// Settings → Manage. Devices with no known link are listed separately —
// nothing is placed by guessing from IP numbers.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS: Record<string, { color: string; bg: string; label: string }> = {
  up:          { color: '#16a34a', bg: '#f0fdf4', label: 'Online' },
  warn:        { color: '#d97706', bg: '#fffbeb', label: 'Warning' },
  unreachable: { color: '#f59e0b', bg: '#fffbeb', label: 'Unreachable' },
  down:        { color: '#dc2626', bg: '#fef2f2', label: 'Offline' },
  unknown:     { color: '#94a3b8', bg: '#f8fafc', label: 'Unknown' },
  maint:       { color: '#7c3aed', bg: '#f5f3ff', label: 'Maintenance' },
}
const st = (s: string) => STATUS[s] ?? STATUS.unknown
const SOURCE: Record<string, string> = { snmp: 'router table (SNMP)', gateway: 'same network as gateway', manual: 'set by an admin' }

const CW = 190, CH = 60, GX = 18, GY = 70, LEAF_COLS = 4, LEAF_GY = 18, PAD = 30

type Box = { dev: Device; x: number; y: number }
type Edge = { from: Box; to: Box; port: string | null; source: string | null; bus?: number }
type Laid = { width: number; height: number; place: (x: number, y: number, boxes: Box[], edges: Edge[], parent: Box | null) => void }

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function layoutTree(dev: Device, kids: Map<string, Device[]>): Laid {
  const children = kids.get(dev.id) ?? []
  const inner = children.filter(c => kids.get(c.id)?.length)
  const leaves = children.filter(c => !kids.get(c.id)?.length)
  const sub = inner.map(c => layoutTree(c, kids))
  const cols = Math.min(LEAF_COLS, leaves.length)
  const rows = Math.ceil(leaves.length / LEAF_COLS)
  const leafW = cols ? cols * CW + (cols - 1) * GX : 0
  const leafH = rows ? rows * CH + (rows - 1) * LEAF_GY : 0
  const parts = [...sub.map(s => ({ w: s.width, h: s.height })), ...(leaves.length ? [{ w: leafW, h: leafH }] : [])]
  const childrenW = parts.reduce((a, p) => a + p.w, 0) + Math.max(0, parts.length - 1) * GX * 2
  const width = Math.max(CW, childrenW)
  const height = CH + (parts.length ? GY + Math.max(...parts.map(p => p.h)) : 0)

  return {
    width, height,
    place(x, y, boxes, edges, parent) {
      const me: Box = { dev, x: x + (width - CW) / 2, y }
      boxes.push(me)
      if (parent) edges.push({ from: parent, to: me, port: dev.parent_port ?? null, source: dev.parent_source ?? null })
      let cx = x + (width - childrenW) / 2
      const cy = y + CH + GY
      sub.forEach(s => { s.place(cx, cy, boxes, edges, me); cx += s.width + GX * 2 })
      leaves.forEach((c, i) => {
        const r = Math.floor(i / LEAF_COLS), col = i % LEAF_COLS
        const inRow = Math.min(LEAF_COLS, leaves.length - r * LEAF_COLS)
        const rowW = inRow * CW + (inRow - 1) * GX
        const b: Box = { dev: c, x: cx + (leafW - rowW) / 2 + col * (CW + GX), y: cy + r * (CH + LEAF_GY) }
        boxes.push(b)
        edges.push({ from: me, to: b, port: c.parent_port ?? null, source: c.parent_source ?? null, bus: r })
      })
    },
  }
}

export default function TopologyLinks({ devs }: { devs: Device[] }) {
  const [zoom, setZoom] = useState(1)
  const [sel, setSel] = useState<Device | null>(null)

  const { W, H, boxes, edges, unlinked, linkedCount } = useMemo(() => {
    const ids = new Set(devs.map(d => d.id))
    const kids = new Map<string, Device[]>()
    for (const d of devs) {
      if (!d.parent_id || !ids.has(d.parent_id) || d.parent_id === d.id) continue
      if (!kids.has(d.parent_id)) kids.set(d.parent_id, [])
      kids.get(d.parent_id)!.push(d)
    }
    for (const list of kids.values()) list.sort((a, b) => a.name.localeCompare(b.name))
    const hasParent = (d: Device) => !!d.parent_id && ids.has(d.parent_id) && d.parent_id !== d.id
    const roots = devs.filter(d => !hasParent(d) && kids.get(d.id)?.length)
      .sort((a, b) => (kids.get(b.id)!.length - kids.get(a.id)!.length) || a.name.localeCompare(b.name))
    const unlinked = devs.filter(d => !hasParent(d) && !kids.get(d.id)?.length)

    const boxes: Box[] = [], edges: Edge[] = []
    let x = PAD, H = 0
    for (const r of roots) {
      const t = layoutTree(r, kids)
      t.place(x, PAD, boxes, edges, null)
      x += t.width + GX * 3
      H = Math.max(H, t.height)
    }
    return { W: Math.max(700, x - GX * 3 + PAD), H: H + PAD * 2, boxes, edges, unlinked, linkedCount: devs.length - unlinked.length }
  }, [devs])

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text2)', flexWrap: 'wrap' }}>
        <strong style={{ color: 'var(--text)' }}>{linkedCount} connected devices</strong>
        <span>· links from routers&apos; ARP / bridge tables, the gateway&apos;s network, or set in Settings → Manage</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {([['−', () => setZoom(z => Math.max(.5, +(z - .1).toFixed(1)))], ['100%', () => setZoom(1)], ['+', () => setZoom(z => Math.min(2, +(z + .1).toFixed(1)))]] as const).map(([l, fn]) => (
            <button suppressHydrationWarning key={l} className="btn btn-sm" onClick={fn} style={{ minWidth: 34, justifyContent: 'center', padding: '2px 8px' }}>{l}</button>
          ))}
        </span>
      </div>

      {boxes.length ? (
        <div style={{ overflow: 'auto', maxHeight: '70vh', WebkitOverflowScrolling: 'touch' }}>
          <svg width={W * zoom} height={H * zoom} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', background: 'linear-gradient(180deg,#f8fbff,#eef4fa)', fontFamily: 'var(--font)' }}>
            <defs>
              <filter id="tl-shadow" x="-20%" y="-20%" width="140%" height="160%">
                <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#0f172a" floodOpacity=".10"/>
              </filter>
              <style>{`.tl-flow{stroke-dasharray:5 7;animation:tl-flow 1.1s linear infinite}@keyframes tl-flow{to{stroke-dashoffset:-12}}@media (prefers-reduced-motion:reduce){.tl-flow{animation:none}}`}</style>
            </defs>
            {edges.map((e, i) => {
              const px = e.from.x + CW / 2, py = e.from.y + CH
              const cx = e.to.x + CW / 2, cy = e.to.y
              const midY = e.bus != null ? cy - LEAF_GY / 2 - 6 : py + GY / 2
              const s = st(e.to.dev.status)
              const live = e.to.dev.status === 'up' || e.to.dev.status === 'warn'
              const d = e.bus != null && e.bus > 0
                ? `M${px},${py} V${py + GY / 2} H${e.to.x - GX / 2} V${midY} H${cx} V${cy}`
                : `M${px},${py} V${midY} H${cx} V${cy}`
              return (
                <g key={i}>
                  <path d={d} fill="none" stroke={s.color} strokeWidth={e.source === 'manual' ? 2 : 2.2} opacity={.85}
                    strokeDasharray={e.to.dev.status === 'down' ? '4 4' : undefined} className={live ? 'tl-flow' : undefined}>
                    <title>{`${e.from.dev.name} → ${e.to.dev.name}${e.port ? ` (port ${e.port})` : ''} · ${SOURCE[e.source ?? ''] ?? 'link'}`}</title>
                  </path>
                  {e.port && (
                    <g transform={`translate(${cx + 4},${cy - 14})`}>
                      <rect width={e.port.length * 6 + 10} height="13" rx="6.5" fill="#0f172a" opacity=".82"/>
                      <text x="5" y="9.5" fontSize="9" fill="white" fontFamily="var(--mono)">{e.port}</text>
                    </g>
                  )}
                </g>
              )
            })}
            {boxes.map(b => {
              const d = b.dev, s = st(d.status)
              const isSel = sel?.id === d.id
              return (
                <g key={d.id} transform={`translate(${b.x},${b.y})`} style={{ cursor: 'pointer' }} onClick={() => setSel(x => x?.id === d.id ? null : d)}>
                  <title>{`${d.name}\n${d.ip}${d.mac ? ` · ${d.mac}` : ''}\n${d.type} · ${s.label}`}</title>
                  <rect width={CW} height={CH} rx="10" fill="white" stroke={isSel ? '#7c3aed' : s.color} strokeWidth={isSel ? 2.5 : 1.5}
                    strokeDasharray={d.status === 'down' ? '5 4' : undefined} filter="url(#tl-shadow)"/>
                  <rect width="5" height={CH} rx="2.5" fill={s.color}/>
                  <text x="14" y="22" fontSize="13" fontWeight="700" fill="#0f172a">{trunc(d.name, 22)}</text>
                  <text x="14" y="39" fontSize="11" fill="#475569" fontFamily="var(--mono)">{d.ip}</text>
                  <text x="14" y="53" fontSize="10" fill="#94a3b8">{trunc(d.type, 14)}</text>
                  <g transform={`translate(${CW - 10 - (s.label.length * 6 + 14)},42)`}>
                    <rect width={s.label.length * 6 + 14} height="14" rx="7" fill={s.bg} stroke={s.color} strokeWidth=".8"/>
                    <text x={(s.label.length * 6 + 14) / 2} y="10" textAnchor="middle" fontSize="9" fontWeight="700" fill={s.color}>{s.label}</text>
                  </g>
                </g>
              )
            })}
          </svg>
        </div>
      ) : (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
          No connections known yet. The agent learns them within a minute of running (needs <code>supabase/migration_objectives.sql</code>);
          you can also set &quot;Connected to&quot; per device in Settings → Manage.
        </div>
      )}

      {sel && (
        <div style={{ borderTop: `3px solid ${st(sel.status).color}`, padding: '12px 16px', fontSize: 12.5, display: 'flex', flexWrap: 'wrap', gap: '6px 22px' }}>
          <strong style={{ fontSize: 14 }}>{sel.name}</strong>
          <span className="mono">{sel.ip}</span>
          <span className="mono">{sel.mac ?? '—'}</span>
          <span>{st(sel.status).label}</span>
          {sel.parent_id && <span>Connected to <strong>{devs.find(d => d.id === sel.parent_id)?.name ?? '—'}</strong>{sel.parent_port ? ` on ${sel.parent_port}` : ''} · {SOURCE[sel.parent_source ?? ''] ?? ''}</span>}
          {sel.parent_updated_at && <span style={{ color: 'var(--text3)' }}>link confirmed {new Date(sel.parent_updated_at).toLocaleString()}</span>}
          <button suppressHydrationWarning className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setSel(null)}>Close ×</button>
        </div>
      )}

      {unlinked.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '10px 16px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>No known connection ({unlinked.length})</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {unlinked.map(d => (
              <span key={d.id} title={`${d.ip} · ${st(d.status).label}`} style={{ fontSize: 11.5, padding: '3px 9px', borderRadius: 12, border: `1px solid ${st(d.status).color}55`, background: st(d.status).bg }}>
                <span style={{ color: st(d.status).color }}>●</span> {d.name} <span className="mono" style={{ color: 'var(--text3)' }}>{d.ip}</span>
              </span>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>These are on networks the agent isn&apos;t on right now, or behind equipment that doesn&apos;t report its neighbours. Set &quot;Connected to&quot; in Settings → Manage.</div>
        </div>
      )}
    </div>
  )
}
