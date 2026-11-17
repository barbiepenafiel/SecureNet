import { createServerClient } from '@/lib/supabase'
import type { AuditEntry } from '@/lib/database.types'
import LiveRefresh from '@/components/LiveRefresh'
import { UrlPagination } from '@/components/Pagination'

const PAGE_SIZES = [10, 25, 50, 100]   // same choices as the Per page selector

const LIVE_TABLES = ['audit_log']

export const dynamic = 'force-dynamic'

// Newest first, one page per request: ?page=2&size=50 (25 per page by default)
export default async function AuditLogPage({ searchParams }: { searchParams: Promise<{ page?: string; size?: string }> }) {
  const sp = await searchParams
  const size = PAGE_SIZES.includes(Number(sp.size)) ? Number(sp.size) : 25
  let page = Math.max(1, Math.floor(Number(sp.page)) || 1)

  const db = createServerClient()
  const fetchPage = (p: number) => db.from('audit_log').select('*', { count: 'exact' })
    .order('logged_at', { ascending: false }).order('id', { ascending: false })
    .range((p - 1) * size, p * size - 1)
  let { data, count } = await fetchPage(page)
  // Past the last page (e.g. an old link): show the last page instead
  const pages = Math.max(1, Math.ceil((count ?? 0) / size))
  if (page > pages) { page = pages; ({ data, count } = await fetchPage(page)) }
  const entries = (data ?? []) as AuditEntry[]
  const total = count ?? entries.length

  return (
    <>
      <LiveRefresh tables={LIVE_TABLES} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        <input suppressHydrationWarning className="form-input" style={{ width: 220 }} placeholder="Search log…" />
        <select suppressHydrationWarning className="form-select" style={{ width: 160 }}>
          <option>All actions</option>
          <option>Config changes</option>
          <option>Alert actions</option>
          <option>User actions</option>
          <option>Logins</option>
        </select>
      </div>

      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr><th>Timestamp</th><th>User</th><th>IP</th><th>Action</th><th>Object</th><th>Before</th><th>After</th></tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id}>
                  <td className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    {new Date(e.logged_at).toLocaleString()}
                  </td>
                  <td>{e.user_name}</td>
                  <td className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{e.user_ip}</td>
                  <td><span className="tag">{e.action}</span></td>
                  <td style={{ fontSize: 12 }}>{e.object_name}</td>
                  <td className="mono" style={{ fontSize: 11, color: 'var(--crit)' }}>{e.before_val}</td>
                  <td className="mono" style={{ fontSize: 11, color: 'var(--ok)'   }}>{e.after_val}</td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--text3)' }}>No audit entries yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {total > 0 && <UrlPagination page={page} pageSize={size} total={total} label="entries" />}
      </div>
    </>
  )
}
