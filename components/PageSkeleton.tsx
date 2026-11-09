export default function PageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div style={{ padding: '0 2px', animation: 'pulse 1.4s ease-in-out infinite' }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
      {/* Hero bar */}
      <div style={{ height: 80, borderRadius: 10, background: 'var(--surface2)', marginBottom: 16 }} />
      {/* KPI row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        {[1,2,3,4].map(i => (
          <div key={i} style={{ flex: 1, height: 72, borderRadius: 8, background: 'var(--surface2)' }} />
        ))}
      </div>
      {/* Table skeleton */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ height: 44, background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }} />
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} style={{ height: 48, borderBottom: '1px solid var(--border)', padding: '12px 16px', display: 'flex', gap: 16, alignItems: 'center' }}>
            <div style={{ width: 140, height: 14, borderRadius: 4, background: 'var(--surface2)' }} />
            <div style={{ width: 70,  height: 14, borderRadius: 4, background: 'var(--surface2)' }} />
            <div style={{ width: 100, height: 14, borderRadius: 4, background: 'var(--surface2)' }} />
            <div style={{ width: 60,  height: 14, borderRadius: 4, background: 'var(--surface2)', marginLeft: 'auto' }} />
          </div>
        ))}
      </div>
    </div>
  )
}
