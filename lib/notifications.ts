// Notification bell data: the rows of the `alerts` table plus each user's
// read / cleared state (supabase/migration_notifications.sql).
import { supabase } from '@/lib/supabase'
import type { Alert, AlertSeverity } from '@/lib/database.types'

export interface AppNotification {
  alert: Alert
  read: boolean
  cleared: boolean
}

export const SEVERITY: Record<AlertSeverity, { label: string; color: string; tint: string }> = {
  crit: { label: 'Critical',    color: 'var(--crit)', tint: 'rgba(220, 38, 38, .10)' },
  warn: { label: 'Warning',     color: 'var(--warn)', tint: 'rgba(217, 119, 6, .10)' },
  info: { label: 'Information', color: 'var(--info)', tint: 'rgba(8, 145, 178, .10)' },
}

export const MIGRATION_FILE = 'supabase/migration_notifications.sql'

// The functions/tables are missing until the migration is run
export function isMissingMigration(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false
  return err.code === 'PGRST202' || err.code === '42883' || err.code === '42P01' || err.code === 'PGRST205'
    || /could not find the function|does not exist|schema cache/i.test(err.message ?? '')
}

export interface ListOptions {
  limit?: number
  offset?: number
  before?: string | null        // snapshot time for later pages (rows raised before it)
  severity?: AlertSeverity | null
  unreadOnly?: boolean
  includeCleared?: boolean
}

// How many notifications match (same filters as listNotifications, without limit/offset)
export async function countNotifications(opts: ListOptions = {}): Promise<number | null> {
  const { data, error } = await supabase.rpc('notification_count', {
    p_before:          opts.before ?? null,
    p_severity:        opts.severity ?? null,
    p_unread_only:     opts.unreadOnly ?? false,
    p_include_cleared: opts.includeCleared ?? false,
  })
  if (!error) return typeof data === 'number' ? data : Number(data) || 0
  if (!isMissingMigration(error)) return null
  // Before the migration: count the alerts themselves
  if (opts.unreadOnly) return 0
  let q = supabase.from('alerts').select('id', { count: 'exact', head: true }).eq('suppressed', false)
  if (opts.before) q = q.lt('created_at', opts.before)
  if (opts.severity) q = q.eq('severity', opts.severity)
  const { count } = await q
  return count ?? 0
}

export interface ListResult {
  items: AppNotification[]
  missingMigration: boolean
  error?: string
}

export async function listNotifications(opts: ListOptions = {}): Promise<ListResult> {
  const { data, error } = await supabase.rpc('notification_list', {
    p_limit:           opts.limit ?? 20,
    p_offset:          opts.offset ?? 0,
    p_before:          opts.before ?? null,
    p_severity:        opts.severity ?? null,
    p_unread_only:     opts.unreadOnly ?? false,
    p_include_cleared: opts.includeCleared ?? false,
  })
  if (error) {
    if (!isMissingMigration(error)) return { items: [], missingMigration: false, error: error.message }
    // Before the migration: show the alerts themselves, without read state
    const from = opts.offset ?? 0
    let q = supabase.from('alerts').select('*').eq('suppressed', false)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(from, from + (opts.limit ?? 20) - 1)
    if (opts.before) q = q.lt('created_at', opts.before)
    if (opts.severity) q = q.eq('severity', opts.severity)
    const { data: rows, error: e2 } = await q
    return {
      items: opts.unreadOnly ? [] : ((rows ?? []) as Alert[]).map(alert => ({ alert, read: true, cleared: false })),
      missingMigration: true,
      error: e2?.message,
    }
  }
  const rows = (data ?? []) as { alert: Alert; is_read: boolean; cleared: boolean }[]
  return { items: rows.map(r => ({ alert: r.alert, read: r.is_read, cleared: r.cleared })), missingMigration: false }
}

export async function unreadCount(): Promise<number | null> {
  const { data, error } = await supabase.rpc('notification_unread_count')
  if (error) return null
  return typeof data === 'number' ? data : Number(data) || 0
}

async function upsertReads(userId: string, alertIds: number[], clear: boolean) {
  if (!alertIds.length) return null
  const now = new Date().toISOString()
  const rows = alertIds.map(alert_id => clear
    ? { user_id: userId, alert_id, read_at: now, cleared_at: now }
    : { user_id: userId, alert_id, read_at: now })
  // Marking as read never un-clears: only read_at is written
  const { error } = await supabase.from('notification_reads')
    .upsert(rows, { onConflict: 'user_id,alert_id', ignoreDuplicates: false })
  return error
}

export const markRead  = (userId: string, alertIds: number[]) => upsertReads(userId, alertIds, false)
export const clearOne  = (userId: string, alertId: number)    => upsertReads(userId, [alertId], true)

export async function markAllRead(userId: string) {
  const { error } = await supabase.from('notification_cursor')
    .upsert({ user_id: userId, read_before: new Date().toISOString() }, { onConflict: 'user_id' })
  return error
}

// "Nov 18, 2:31 PM" plus "5 min ago"
export function formatWhen(iso: string): { absolute: string; relative: string } {
  const d = new Date(iso)
  const sec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  const relative = sec < 45 ? 'just now'
    : sec < 3600 ? `${Math.round(sec / 60)} min ago`
    : sec < 86400 ? `${Math.round(sec / 3600)} h ago`
    : `${Math.round(sec / 86400)} d ago`
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const absolute = d.toLocaleString([], {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric', minute: '2-digit',
  })
  return { absolute, relative }
}
