'use client'

import { useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

// One pagination bar for every paged list (alerts, incidents, devices,
// notifications, audit log, report snapshots).

export const PAGE_SIZES = [10, 25, 50, 100] as const

// Page numbers with gaps: 1 … 4 5 [6] 7 8 … 20
function pageList(page: number, pages: number): (number | 'gap')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  const out: (number | 'gap')[] = [1]
  const from = Math.max(2, page - 1)
  const to = Math.min(pages - 1, page + 1)
  if (from > 2) out.push('gap')
  for (let p = from; p <= to; p++) out.push(p)
  if (to < pages - 1) out.push('gap')
  out.push(pages)
  return out
}

interface Props {
  page: number                    // 1-based
  pageSize: number
  total: number
  onPage: (page: number) => void
  onPageSize?: (size: number) => void
  loading?: boolean
  label?: string                  // "alerts", "devices" …
  sizes?: readonly number[]
}

export default function Pagination({ page, pageSize, total, onPage, onPageSize, loading, label = 'records', sizes = PAGE_SIZES }: Props) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(total, page * pageSize)

  return (
    <nav className="pager" aria-label="Pagination">
      <div className="pager-info">
        {loading && <span className="pager-spin" aria-hidden />}
        <span>
          Showing <strong>{first.toLocaleString()}–{last.toLocaleString()}</strong> of <strong>{total.toLocaleString()}</strong> {label}
        </span>
      </div>

      <div className="pager-pages">
        <button type="button" className="pager-btn" onClick={() => onPage(page - 1)} disabled={page <= 1 || loading} aria-label="Previous page">
          ‹ <span className="pager-word">Previous</span>
        </button>
        {pageList(page, pages).map((p, i) => p === 'gap'
          ? <span key={`g${i}`} className="pager-gap">…</span>
          : (
            <button key={p} type="button" className={`pager-btn pager-num${p === page ? ' active' : ''}`}
              onClick={() => p !== page && onPage(p)} aria-current={p === page ? 'page' : undefined} disabled={loading && p !== page}>
              {p}
            </button>
          ))}
        <button type="button" className="pager-btn" onClick={() => onPage(page + 1)} disabled={page >= pages || loading} aria-label="Next page">
          <span className="pager-word">Next</span> ›
        </button>
      </div>

      {onPageSize && (
        <label className="pager-size">
          <span>Per page</span>
          <select className="form-select" value={pageSize} onChange={e => onPageSize(Number(e.target.value))}>
            {sizes.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      )}
    </nav>
  )
}

// Page + page size that go back to page 1 whenever `resetKey` changes
// (a filter, search, period or sort). The page size is kept.
export function usePager(resetKey: string, initialSize = 25) {
  // Reset during render (not in an effect), so a filter change never fetches the old page first
  const [state, setState] = useState({ key: resetKey, page: 1 })
  const [pageSize, setPageSizeState] = useState(initialSize)
  if (state.key !== resetKey) setState({ key: resetKey, page: 1 })
  const page = state.key === resetKey ? state.page : 1
  const setPage = (p: number) => setState({ key: resetKey, page: Math.max(1, p) })
  const setPageSize = (s: number) => { setPageSizeState(s); setState({ key: resetKey, page: 1 }) }
  return { page, setPage, pageSize, setPageSize, offset: (page - 1) * pageSize }
}

// Stay on a page that still exists after the total shrinks
export function clampPage(page: number, pageSize: number, total: number) {
  return Math.min(page, Math.max(1, Math.ceil(total / pageSize)))
}

// For server-rendered pages: the page and page size live in the URL
// (?page=2&size=50), so the server fetches only that page.
export function UrlPagination(props: Omit<Props, 'onPage' | 'onPageSize'>) {
  const router = useRouter()
  const path = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()
  const go = (page: number, size: number) => {
    const q = new URLSearchParams(params.toString())
    q.set('page', String(page))
    q.set('size', String(size))
    startTransition(() => router.push(`${path}?${q.toString()}`, { scroll: false }))
  }
  return (
    <Pagination {...props} loading={props.loading || pending}
      onPage={p => go(p, props.pageSize)} onPageSize={s => go(1, s)} />
  )
}
