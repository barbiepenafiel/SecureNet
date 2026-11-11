'use client'

import { useEffect, useRef } from 'react'

// Calls `fn` every `ms` while the browser tab is visible, so a page keeps its
// data current without a manual refresh. Used alongside Supabase realtime as
// a backup for tables that don't have realtime enabled.
export function usePolling(fn: () => unknown, ms = 5_000) {
  const ref = useRef(fn)
  ref.current = fn

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') ref.current()
    }, ms)
    // Catch up immediately when the user comes back to the tab
    const onVisible = () => { if (document.visibilityState === 'visible') ref.current() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible) }
  }, [ms])
}
