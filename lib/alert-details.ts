import type { Alert } from '@/lib/database.types'

export interface AlertDetails {
  name: string
  ip: string
  mac: string
  location: string
  method: string
  status: 'online' | 'offline' | null
  discovered: boolean
}

// Reads device details from the alert's own columns, falling back to the
// `meta` text (used before supabase/migration_alert_details.sql is run, and
// by older alerts written as "IP: x · Building A · failed N ping checks").
export function alertDetails(a: Alert): AlertDetails {
  const meta = a.meta ?? ''
  const field = (label: string) => meta.match(new RegExp(`${label}: ([^·]+)`))?.[1]?.trim()

  const status = a.status
    ?? (field('Status')?.toLowerCase() === 'online' ? 'online'
      : field('Status')?.toLowerCase() === 'offline' ? 'offline'
      : /offline|unreachable/i.test(a.title) ? 'offline'
      : /back online/i.test(a.title) ? 'online'
      : null)

  // Old format: "IP: 1.2.3.4 · Building A · failed 2 consecutive ping checks"
  const oldParts = meta.replace('[Discovered] ', '').split(' · ')
  const oldLocation = !field('Location') && oldParts.length >= 2 && !/^MAC:/.test(oldParts[1]) ? oldParts[1] : undefined

  return {
    name:       a.device_name ?? a.title.replace(/ (is offline|is back online|unreachable)$/i, ''),
    ip:         a.device_ip ?? field('IP') ?? '—',
    mac:        a.device_mac ?? field('MAC') ?? '—',
    location:   a.location ?? field('Location') ?? oldLocation ?? '—',
    method:     a.detection_method ?? field('Method') ?? (/ping/i.test(meta) ? 'ICMP' : '—'),
    status,
    discovered: meta.startsWith('[Discovered]'),
  }
}
