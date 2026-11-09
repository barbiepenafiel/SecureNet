import { createServerClient } from '@/lib/supabase'
import type { AuditEntry } from '@/lib/database.types'

export const dynamic = 'force-dynamic'

export default async function AuditLogPage() {
  const db = createServerClient()
  const { data } = await db.from('audit_log').select('*').order('logged_at', { ascending: false }).limit(100)
  const entries = (data ?? []) as AuditEntry[]

  return (
    <>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <input className="form-input" style={{ width: 220 }} placeholder="Search log…" />
        <select className="form-select" style={{ width: 160 }}>
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
      </div>
    </>
  )
}
