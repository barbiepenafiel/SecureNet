'use client'

import { alertDetails } from '@/lib/alert-details'
import { SEVERITY, formatWhen, type AppNotification } from '@/lib/notifications'

export function SeverityIcon({ severity, size = 16 }: { severity: 'crit' | 'warn' | 'info'; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  if (severity === 'crit') return (
    <svg {...common}><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
  )
  if (severity === 'warn') return (
    <svg {...common}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
  )
  return (
    <svg {...common}><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
  )
}

interface Props {
  n: AppNotification
  canChange: boolean                 // false before the migration is run
  onRead: (id: number) => void
  onClear: (id: number) => void
  compact?: boolean                  // dropdown (true) vs history page
}

export default function NotificationItem({ n, canChange, onRead, onClear, compact }: Props) {
  const a = n.alert
  const sev = SEVERITY[a.severity] ?? SEVERITY.info
  const d = alertDetails(a)
  const when = formatWhen(a.created_at)
  const hasDevice = d.ip !== '—'
  const unread = !n.read

  return (
    <div
      className={`notif-item${unread ? ' unread' : ''}${compact ? ' compact' : ''}${n.cleared ? ' cleared' : ''}`}
      onClick={() => { if (unread && canChange) onRead(a.id) }}
      role="listitem"
    >
      <div className="notif-icon" style={{ color: sev.color, background: sev.tint }}>
        <SeverityIcon severity={a.severity} />
      </div>

      <div className="notif-main">
        <div className="notif-top">
          <span className="notif-title">{a.title}</span>
          {unread && <span className="notif-dot" aria-label="Unread" />}
        </div>
        {a.root_cause && <div className="notif-desc">{a.root_cause}</div>}
        <div className="notif-meta">
          <span className="notif-sev" style={{ color: sev.color, background: sev.tint }}>{sev.label}</span>
          {hasDevice && (
            <span className="notif-device" title={`${d.name} · ${d.ip}`}>
              {d.name} · <span className="mono">{d.ip}</span>
            </span>
          )}
          <span className="notif-time" title={new Date(a.created_at).toLocaleString()}>
            {when.absolute} · {when.relative}
          </span>
          <span className="notif-state">
            {n.cleared ? 'Cleared' : unread ? 'Unread' : 'Read'}
            {a.resolved_at ? ' · Resolved' : ''}
          </span>
        </div>
      </div>

      {canChange && (
        <div className="notif-actions" onClick={e => e.stopPropagation()}>
          {unread && (
            <button type="button" className="notif-act" title="Mark as read" aria-label="Mark as read" onClick={() => onRead(a.id)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="20 6 9 17 4 12" /></svg>
            </button>
          )}
          {!n.cleared && (
            <button type="button" className="notif-act" title="Clear" aria-label="Clear notification" onClick={() => onClear(a.id)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
