'use client'

import { useState, useRef, useEffect } from 'react'

function renderInsights(text: string) {
  return text.split('\n').map((line, i) => {
    if (!line.trim()) return <div key={i} style={{ height: 6 }} />

    // Section headers like **Network Health Overview**
    if (/^\*\*[^*]+\*\*$/.test(line.trim())) {
      return (
        <div key={i} style={{ fontWeight: 700, fontSize: 13, color: '#4ade80', marginTop: 14, marginBottom: 4 }}>
          {line.replace(/\*\*/g, '')}
        </div>
      )
    }

    // Bullet points
    if (line.startsWith('• ') || line.startsWith('- ')) {
      const content = line.slice(2)
      return (
        <div key={i} style={{ display: 'flex', gap: 7, marginBottom: 4, fontSize: 12, lineHeight: 1.5 }}>
          <span style={{ color: '#4ade80', flexShrink: 0, marginTop: 1 }}>›</span>
          <span style={{ color: 'var(--text2)' }}>{content}</span>
        </div>
      )
    }

    return (
      <div key={i} style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 2 }}>
        {line}
      </div>
    )
  })
}

export default function AIInsightsButton() {
  const [open,     setOpen]     = useState(false)
  const [insights, setInsights] = useState<string>('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  async function generate() {
    setLoading(true)
    setInsights('')
    setError(null)

    try {
      const res = await fetch('/api/insights', { method: 'POST' })

      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        const msg = j.error ?? (res.status === 503 ? 'Gemini is overloaded. Please try again.' : `HTTP ${res.status}`)
        throw new Error(msg)
      }

      const reader  = res.body!.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        setInsights(prev => prev + decoder.decode(value, { stream: true }))
        // auto-scroll
        if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setLoading(false)
    }
  }

  const hasInsights = insights.length > 0

  // Auto-generate when panel opens (if no insights yet)
  useEffect(() => {
    if (open && !hasInsights && !loading) generate()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <>
      {/* ── Floating trigger button ── */}
      <button
        onClick={() => setOpen(o => !o)}
        title="AI Network Insights"
        style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 1100,
          width: 52, height: 52, borderRadius: '50%', border: 'none',
          background: 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)',
          boxShadow: '0 4px 20px rgba(22,163,74,.5)',
          cursor: 'pointer', fontSize: 22,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'transform .15s, box-shadow .15s',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.08)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)' }}
        suppressHydrationWarning
      >
        🤖
      </button>

      {/* ── Popup panel ── */}
      {open && (
        <div style={{
          position: 'fixed', bottom: 86, right: 24, zIndex: 1100,
          width: 360,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          boxShadow: '0 12px 40px rgba(0,0,0,.55)',
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          maxHeight: 'calc(100vh - 120px)',
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '13px 16px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface2)',
            flexShrink: 0,
          }}>
            <span style={{ fontSize: 18 }}>🤖</span>
            <span style={{ fontWeight: 600, fontSize: 14 }}>AI Network Insights</span>
            <button suppressHydrationWarning
              onClick={() => setOpen(false)}
              style={{
                marginLeft: 'auto', background: 'none', border: 'none',
                cursor: 'pointer', color: 'var(--text3)', fontSize: 20, lineHeight: 1,
                padding: '0 2px',
              }}
            >
              ×
            </button>
          </div>

          {/* Body */}
          <div
            ref={bodyRef}
            style={{ padding: '18px 16px', overflowY: 'auto', flex: 1 }}
          >
            {/* Initial state */}
            {!hasInsights && !loading && !error && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 52, opacity: .25, marginBottom: 14 }}>🧠</div>
                <p style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 1.6, marginBottom: 20 }}>
                  Click <strong style={{ color: 'var(--text)' }}>Generate Insights</strong> to run
                  an AI analysis of your network data.
                </p>
              </div>
            )}

            {/* Error */}
            {error && (
              <div style={{
                background: 'rgba(248,81,73,.1)', border: '1px solid rgba(248,81,73,.25)',
                borderRadius: 8, padding: '10px 12px', marginBottom: 14,
                color: 'var(--crit)', fontSize: 12,
              }}>
                {error}
              </div>
            )}

            {/* Loading animation */}
            {loading && !hasInsights && (
              <div style={{ textAlign: 'center', color: 'var(--text3)', fontSize: 13, padding: '12px 0' }}>
                <div style={{ marginBottom: 10, fontSize: 24 }}>⏳</div>
                Analyzing network data…
              </div>
            )}

            {/* Streaming / complete insights */}
            {hasInsights && (
              <div>{renderInsights(insights)}</div>
            )}
          </div>

          {/* Footer */}
          <div style={{
            padding: '12px 16px',
            borderTop: '1px solid var(--border)',
            background: 'var(--surface2)',
            flexShrink: 0,
          }}>
            <button suppressHydrationWarning
              onClick={generate}
              disabled={loading}
              style={{
                width: '100%', padding: '10px 0', borderRadius: 8, border: 'none',
                background: loading
                  ? 'var(--surface3)'
                  : 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)',
                color: loading ? 'var(--text3)' : '#fff',
                fontWeight: 600, fontSize: 13, cursor: loading ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                transition: 'opacity .15s',
              }}
            >
              <span style={{ fontSize: 15 }}>{loading ? '⏳' : '🔄'}</span>
              {loading ? 'Generating…' : hasInsights ? 'Regenerate Insights' : 'Generate Insights'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
