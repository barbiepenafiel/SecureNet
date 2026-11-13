'use client'

import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'

// ── Decorative network topology (illustration only — no live data) ──────────
// Device glyphs drawn around (0,0)
function Glyph({ kind }: { kind: 'router' | 'switch' | 'server' | 'ap' | 'pc' | 'firewall' }) {
  const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (kind) {
    case 'router': return <g {...s}><rect x="-11" y="-3" width="22" height="9" rx="2"/><path d="M-6 -3v-6M6 -3v-6"/><circle cx="-5" cy="1.5" r=".9" fill="currentColor"/><circle cx="-1" cy="1.5" r=".9" fill="currentColor"/></g>
    case 'firewall': return <g {...s}><path d="M0 -10l9 3v6c0 5-4 8-9 10c-5-2-9-5-9-10v-6z"/><path d="M-4 0l3 3l5-6"/></g>
    case 'switch': return <g {...s}><rect x="-12" y="-5" width="24" height="10" rx="2"/><path d="M-7 0h1M-3 0h1M1 0h1M5 0h1"/></g>
    case 'server': return <g {...s}><rect x="-8" y="-10" width="16" height="8" rx="1.5"/><rect x="-8" y="1" width="16" height="8" rx="1.5"/><path d="M-4 -6h4M-4 5h4"/></g>
    case 'ap': return <g {...s}><circle cx="0" cy="4" r="1.6" fill="currentColor"/><path d="M-5 0a7 7 0 0 1 10 0M-9 -4a12.5 12.5 0 0 1 18 0"/></g>
    case 'pc': return <g {...s}><rect x="-10" y="-8" width="20" height="13" rx="1.5"/><path d="M-4 9h8M0 5v4"/></g>
  }
}

type NodeDef = { id: string; x: number; y: number; kind: Parameters<typeof Glyph>[0]['kind']; label: string; core?: boolean }
const NODES: NodeDef[] = [
  { id: 'fw',  x: 280, y: 52,  kind: 'firewall', label: 'Firewall' },
  { id: 'rt',  x: 280, y: 132, kind: 'router',   label: 'Core router', core: true },
  { id: 'sw1', x: 140, y: 222, kind: 'switch',   label: 'Switch' },
  { id: 'sw2', x: 420, y: 222, kind: 'switch',   label: 'Switch' },
  { id: 'sv',  x: 60,  y: 318, kind: 'server',   label: 'Server' },
  { id: 'ap1', x: 175, y: 318, kind: 'ap',       label: 'Access point' },
  { id: 'pc1', x: 365, y: 318, kind: 'pc',       label: 'Workstation' },
  { id: 'ap2', x: 490, y: 318, kind: 'ap',       label: 'Access point' },
]
const LINKS: [string, string][] = [['fw', 'rt'], ['rt', 'sw1'], ['rt', 'sw2'], ['sw1', 'sv'], ['sw1', 'ap1'], ['sw2', 'pc1'], ['sw2', 'ap2']]
const at = (id: string) => NODES.find(n => n.id === id)!
const linkPath = (a: NodeDef, b: NodeDef) => {
  // From below the parent's label to the top of the child's tile
  const y1 = a.y + 42, y2 = b.y - 21, my = (y1 + y2) / 2
  return `M${a.x} ${y1} C${a.x} ${my}, ${b.x} ${my}, ${b.x} ${y2}`
}

function TopologyArt({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 560 370" role="img" aria-label="Illustration of a campus network: firewall, core router, switches, server, access points and a workstation">
      <defs>
        <radialGradient id="lg-glow" cx="50%" cy="40%" r="60%">
          <stop offset="0" stopColor="#4ade80" stopOpacity=".16"/>
          <stop offset="1" stopColor="#4ade80" stopOpacity="0"/>
        </radialGradient>
      </defs>
      <ellipse cx="280" cy="170" rx="270" ry="190" fill="url(#lg-glow)"/>
      {LINKS.map(([a, b], i) => {
        const d = linkPath(at(a), at(b))
        return (
          <g key={`${a}-${b}`}>
            <path d={d} className="lg-link"/>
            <path d={d} className="lg-flow" style={{ animationDelay: `${-i * 0.7}s` }}/>
          </g>
        )
      })}
      {NODES.map(n => (
        <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
          {n.core && <circle r="30" className="lg-ring"/>}
          <rect x="-22" y="-20" width="44" height="40" rx="10" className={`lg-node${n.core ? ' lg-node-core' : ''}`}/>
          <g className="lg-glyph"><Glyph kind={n.kind}/></g>
          <text y="36" textAnchor="middle" className="lg-node-label">{n.label}</text>
        </g>
      ))}
    </svg>
  )
}

// ── Icons ────────────────────────────────────────────────────────────────────
const Eye = ({ off }: { off?: boolean }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>
    {off && <path d="M4 4l16 16"/>}
  </svg>
)
const Mail = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>
  </svg>
)
const Lock = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>
  </svg>
)
const Alert = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>
  </svg>
)

const FEATURES = [
  ['Network discovery', 'ICMP and ARP scanning maps every device on the campus network'],
  ['SNMP monitoring', 'Routers, switches and servers checked for status, load and traffic'],
  ['Real-time alerts', 'Outages and recoveries reported the moment they happen'],
]

// ── Page ─────────────────────────────────────────────────────────────────────
function LoginForm() {
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErr, setFieldErr] = useState<{ email?: string; password?: string }>({})

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    // Field checks before contacting the server
    const errs: { email?: string; password?: string } = {}
    if (!email.trim()) errs.email = 'Enter your email address.'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = 'Enter a valid email address.'
    if (!password) errs.password = 'Enter your password.'
    setFieldErr(errs)
    if (errs.email || errs.password) return

    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) {
      setError(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message)
      setBusy(false)
      return
    }
    await fetch('/api/users/me', { method: 'POST' }).catch(() => {})
    const next = params.get('next')
    // Full reload so the server sees the new session cookie
    window.location.href = next && next.startsWith('/') ? next : '/'
  }

  const trackCaps = (e: React.KeyboardEvent) => setCapsLock(e.getModifierState?.('CapsLock') ?? false)

  return (
    <div className="lg-root">
      <style>{CSS}</style>

      {/* ── Left: product identity + illustration (desktop / tablet) ── */}
      <section className="lg-visual">
        <div className="lg-grid" aria-hidden="true"/>
        <div className="lg-visual-inner">
          <div className="lg-brand">
            <img src="/images/securenet-shield.png" alt="SecureNet logo" width={42} height={45}/>
            <div>
              <div className="lg-brand-name">SmartCampus <span>SecureNet</span></div>
              <div className="lg-brand-sub">Network Monitoring &amp; Security Platform</div>
            </div>
          </div>

          <div className="lg-hero">
            <div className="lg-kicker"><span className="lg-kicker-dot"/>Network Operations Center</div>
            <h1>See every device on the campus network, in one place.</h1>
            <p>Device discovery, topology mapping, SNMP monitoring and alerting for DNSC&apos;s network infrastructure.</p>
          </div>

          <TopologyArt className="lg-art"/>

          <ul className="lg-features">
            {FEATURES.map(([t, d]) => (
              <li key={t}><span className="lg-feat-mark" aria-hidden="true"/><div><strong>{t}</strong><span>{d}</span></div></li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── Right: sign-in ── */}
      <main className="lg-panel">
        <div className="lg-mobile-art" aria-hidden="true"><TopologyArt/></div>

        <form onSubmit={submit} className="lg-card" noValidate aria-describedby={error ? 'lg-error' : undefined}>
          <div className="lg-card-brand">
            <img src="/images/securenet-logo.png" alt="SecureNet — Network Mapping & Monitoring" width={601} height={193}/>
          </div>

          <h2 className="lg-title">Sign in</h2>
          <p className="lg-subtitle">Use your SecureNet staff account to access the monitoring dashboard.</p>

          {error && (
            <div id="lg-error" className="lg-error" role="alert"><Alert/><span>{error}</span></div>
          )}

          <div className="lg-field">
            <label htmlFor="email">Email address</label>
            <div className={`lg-input${fieldErr.email ? ' lg-input-bad' : ''}`}>
              <span className="lg-input-icon"><Mail/></span>
              <input id="email" type="email" autoComplete="email" inputMode="email" placeholder="name@dnsc.edu.ph"
                required disabled={busy} suppressHydrationWarning aria-invalid={!!fieldErr.email}
                aria-describedby={fieldErr.email ? 'email-err' : undefined}
                value={email} onChange={e => { setEmail(e.target.value); if (fieldErr.email) setFieldErr(f => ({ ...f, email: undefined })) }}/>
            </div>
            {fieldErr.email && <div id="email-err" className="lg-field-err">{fieldErr.email}</div>}
          </div>

          <div className="lg-field">
            <label htmlFor="password">Password</label>
            <div className={`lg-input${fieldErr.password ? ' lg-input-bad' : ''}`}>
              <span className="lg-input-icon"><Lock/></span>
              <input id="password" type={showPw ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter your password"
                required disabled={busy} suppressHydrationWarning aria-invalid={!!fieldErr.password}
                aria-describedby={fieldErr.password ? 'password-err' : capsLock ? 'caps-hint' : undefined}
                onKeyUp={trackCaps} onKeyDown={trackCaps} onBlur={() => setCapsLock(false)}
                value={password} onChange={e => { setPassword(e.target.value); if (fieldErr.password) setFieldErr(f => ({ ...f, password: undefined })) }}/>
              <button type="button" className="lg-eye" onClick={() => setShowPw(s => !s)} disabled={busy} suppressHydrationWarning
                aria-label={showPw ? 'Hide password' : 'Show password'} aria-pressed={showPw} title={showPw ? 'Hide password' : 'Show password'}>
                <Eye off={showPw}/>
              </button>
            </div>
            {fieldErr.password
              ? <div id="password-err" className="lg-field-err">{fieldErr.password}</div>
              : capsLock && <div id="caps-hint" className="lg-field-hint">Caps Lock is on</div>}
          </div>

          <button className="lg-submit" type="submit" disabled={busy} suppressHydrationWarning aria-busy={busy}>
            {busy ? <><span className="lg-spinner" aria-hidden="true"/>Signing in…</> : 'Sign in'}
          </button>

          <div className="lg-foot">
            <Lock/><span>No account? Ask a Network Admin to add you.</span>
          </div>
        </form>

        <div className="lg-legal">© {new Date().getFullYear()} Davao del Norte State College · SmartCampus SecureNet</div>
      </main>
    </div>
  )
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>
}

// ── Styles (scoped to the login page by the lg- prefix) ──────────────────────
const CSS = `
.lg-root {
  /* The dashboard's palette (globals.css): deep green sidebar, white surfaces, green accent */
  --lg-dark: #0a1f10; --lg-dark2: #132b1a; --lg-dark3: #1a4a28; --lg-line-d: rgba(134,239,172,.13);
  --lg-on-dark2: rgba(255,255,255,.72); --lg-on-dark3: rgba(255,255,255,.5);
  --lg-mint: #4ade80; --lg-green: #16a34a; --lg-green2: #15803d;
  --lg-err: #dc2626;
  min-height: 100vh; min-height: 100dvh; display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  background: var(--bg); color: var(--text); font-family: var(--font);
}

/* Left: deep green network panel */
.lg-visual { position: relative; overflow: hidden; color: #fff;
  background: radial-gradient(900px 520px at 85% 110%, rgba(22,163,74,.55) 0%, transparent 60%), linear-gradient(155deg, var(--lg-dark) 0%, #0f2a17 55%, var(--lg-dark3) 100%); }
.lg-grid { position: absolute; inset: 0; opacity: .6;
  background-image: linear-gradient(var(--lg-line-d) 1px, transparent 1px), linear-gradient(90deg, var(--lg-line-d) 1px, transparent 1px);
  background-size: 44px 44px; mask-image: radial-gradient(ellipse at 45% 45%, #000 20%, transparent 75%); -webkit-mask-image: radial-gradient(ellipse at 45% 45%, #000 20%, transparent 75%); }
.lg-visual-inner { position: relative; height: 100%; display: flex; flex-direction: column; gap: 28px; padding: 40px clamp(28px, 4vw, 64px); max-width: 760px; }
.lg-brand, .lg-card-brand { display: flex; align-items: center; gap: 12px; }
.lg-brand img { flex-shrink: 0; height: 45px; width: auto; }
/* Full SecureNet logo (shield + wordmark) at the top of the white card */
.lg-card-brand { justify-content: center; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
.lg-card-brand img { display: block; height: 68px; width: auto; max-width: 100%; }
.lg-brand-name { font-size: 17px; font-weight: 700; letter-spacing: -.01em; }
.lg-brand-sub { font-size: 12px; margin-top: 2px; }
.lg-brand .lg-brand-name { color: #fff; }
.lg-brand .lg-brand-name span { color: var(--lg-mint); }
.lg-brand .lg-brand-sub { color: var(--lg-on-dark3); }
.lg-card-brand .lg-brand-name { color: var(--text); }
.lg-card-brand .lg-brand-name span { color: var(--lg-green); }
.lg-card-brand .lg-brand-sub { color: var(--text3); }
.lg-hero { margin-top: auto; }
.lg-kicker { display: inline-flex; align-items: center; gap: 8px; font-size: 11.5px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--lg-mint);
  padding: 5px 11px; border: 1px solid rgba(74,222,128,.3); border-radius: 999px; background: rgba(74,222,128,.08); }
.lg-kicker-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--lg-mint); box-shadow: 0 0 8px var(--lg-mint); }
.lg-hero h1 { font-size: clamp(26px, 2.6vw, 38px); line-height: 1.15; font-weight: 700; letter-spacing: -.02em; margin: 16px 0 12px; max-width: 560px; color: #fff; }
.lg-hero p { font-size: 15px; line-height: 1.6; color: var(--lg-on-dark2); max-width: 520px; }
.lg-art { width: 100%; max-width: 620px; height: auto; display: block; }
.lg-features { list-style: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: auto; }
.lg-features li { display: flex; gap: 10px; padding: 14px; border: 1px solid var(--lg-line-d); border-radius: 12px; background: rgba(10,31,16,.45); }
.lg-features strong { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: #fff; }
.lg-features span { font-size: 12px; line-height: 1.5; color: var(--lg-on-dark3); }
.lg-feat-mark { width: 3px; border-radius: 2px; background: linear-gradient(var(--lg-mint), var(--lg-green)); flex-shrink: 0; }

/* Topology illustration (drawn on dark green) */
.lg-link { fill: none; stroke: rgba(134,239,172,.3); stroke-width: 1.4; }
.lg-flow { fill: none; stroke: var(--lg-mint); stroke-width: 1.6; stroke-linecap: round; stroke-dasharray: 3 22; opacity: .8; animation: lg-flow 4.5s linear infinite; }
@keyframes lg-flow { to { stroke-dashoffset: -100; } }
.lg-node { fill: var(--lg-dark2); stroke: rgba(134,239,172,.4); stroke-width: 1.2; }
.lg-node-core { stroke: var(--lg-mint); }
.lg-glyph { color: #bbf7d0; }
.lg-ring { fill: none; stroke: rgba(74,222,128,.4); stroke-width: 1; transform-box: fill-box; transform-origin: center; animation: lg-ring 3.6s ease-out infinite; }
@keyframes lg-ring { 0% { transform: scale(.85); opacity: .9 } 100% { transform: scale(1.35); opacity: 0 } }
.lg-node-label { font-size: 10.5px; fill: var(--lg-on-dark3); font-family: var(--font); }

/* Right: white sign-in card on the dashboard's light green */
.lg-panel { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; padding: 40px 24px;
  background: radial-gradient(640px 420px at 75% 20%, #e4f0e8 0%, transparent 70%), var(--bg); }
.lg-mobile-art { display: none; }
.lg-card { width: 100%; max-width: 420px; padding: 34px 32px 26px; border-radius: 16px; border: 1px solid var(--border);
  border-top: 4px solid var(--lg-green); background: var(--surface); box-shadow: 0 18px 50px rgba(10,31,16,.12), 0 1px 4px rgba(0,0,0,.05); }
.lg-card-brand { margin-bottom: 22px; }
.lg-title { font-size: 24px; font-weight: 700; letter-spacing: -.01em; color: var(--text); }
.lg-subtitle { font-size: 13.5px; line-height: 1.55; color: var(--text2); margin: 6px 0 22px; }
.lg-error { display: flex; gap: 10px; align-items: flex-start; padding: 11px 12px; margin-bottom: 18px; border-radius: 10px; font-size: 13.5px; line-height: 1.45;
  color: #991b1b; background: #fef2f2; border: 1px solid #fecaca; }
.lg-error svg { color: var(--lg-err); flex-shrink: 0; margin-top: 1px; }
.lg-field { margin-bottom: 16px; }
.lg-field label { display: block; font-size: 12.5px; font-weight: 600; color: var(--text2); margin-bottom: 7px; }
.lg-input { display: flex; align-items: center; border-radius: 10px; border: 1px solid var(--border2); background: #fff; transition: border-color .15s, box-shadow .15s; }
.lg-input:hover { border-color: #9cc5ad; }
.lg-input:focus-within { border-color: var(--lg-green); box-shadow: 0 0 0 3px rgba(22,163,74,.15); }
.lg-input-bad, .lg-input-bad:focus-within, .lg-input-bad:hover { border-color: var(--lg-err); box-shadow: 0 0 0 3px rgba(220,38,38,.1); }
.lg-input-icon { display: flex; padding-left: 13px; color: var(--text3); }
.lg-input input { flex: 1; min-width: 0; height: 46px; padding: 0 12px; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 15px; }
.lg-input input::placeholder { color: #9ab1a3; }
.lg-input input:disabled { opacity: .7; }
.lg-input input:-webkit-autofill { -webkit-text-fill-color: var(--text); -webkit-box-shadow: 0 0 0 40px #fff inset; caret-color: var(--text); }
.lg-eye { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; margin-right: 1px; border: 0; border-radius: 8px; background: transparent; color: var(--text3); cursor: pointer; }
.lg-eye:hover { color: var(--lg-green2); }
.lg-eye:focus-visible { outline: 2px solid var(--lg-green); outline-offset: -4px; }
.lg-field-err { margin-top: 6px; font-size: 12.5px; color: var(--lg-err); }
.lg-field-hint { margin-top: 6px; font-size: 12.5px; color: var(--warn); }
.lg-submit { width: 100%; height: 48px; margin-top: 6px; display: inline-flex; align-items: center; justify-content: center; gap: 10px;
  border: 0; border-radius: 10px; cursor: pointer; font: inherit; font-size: 15px; font-weight: 600; color: #fff;
  background: linear-gradient(180deg, var(--lg-green), var(--lg-green2)); box-shadow: 0 8px 20px rgba(22,163,74,.28); transition: filter .15s, transform .05s; }
.lg-submit:hover:not(:disabled) { filter: brightness(1.07); }
.lg-submit:active:not(:disabled) { transform: translateY(1px); }
.lg-submit:focus-visible { outline: 2px solid var(--lg-green2); outline-offset: 2px; }
.lg-submit:disabled { cursor: progress; opacity: .85; }
.lg-spinner { width: 16px; height: 16px; border-radius: 50%; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; animation: lg-spin .7s linear infinite; }
@keyframes lg-spin { to { transform: rotate(360deg); } }
.lg-foot { display: flex; align-items: center; justify-content: center; gap: 7px; margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--border); font-size: 12.5px; color: var(--text3); }
.lg-legal { font-size: 11.5px; color: var(--text3); text-align: center; }

/* Laptop / small desktop: lighter left column */
@media (max-width: 1280px) {
  .lg-features { grid-template-columns: 1fr; gap: 10px; }
  .lg-features li { padding: 11px 12px; }
}
@media (max-height: 820px) and (min-width: 1025px) {
  .lg-visual-inner { gap: 18px; padding-top: 28px; padding-bottom: 28px; }
  .lg-art { max-height: 300px; }
  .lg-features { display: none; }
}

/* Tablet and phone: green network header, white card over it */
@media (max-width: 1024px) {
  .lg-root { grid-template-columns: 1fr; }
  .lg-visual { display: none; }
  .lg-panel { justify-content: flex-start; padding: 0 20px 28px; min-height: 100vh; min-height: 100dvh; overflow: hidden; background: var(--bg); }
  /* Full-width green band holding the whole drawing; the card overlaps its empty lower edge */
  .lg-mobile-art { display: block; align-self: stretch; margin: 0 -20px -64px; padding: 12px 20px 76px; pointer-events: none;
    background: radial-gradient(500px 220px at 50% 100%, rgba(22,163,74,.45) 0%, transparent 70%), linear-gradient(170deg, var(--lg-dark) 0%, #0f2a17 60%, var(--lg-dark3) 100%); }
  .lg-mobile-art svg { width: 100%; max-width: 520px; height: auto; display: block; margin: 0 auto; }
  .lg-card { position: relative; }
}
@media (max-width: 480px) {
  .lg-panel { padding: 0 14px 22px; }
  .lg-mobile-art { margin: 0 -14px -52px; padding: 10px 14px 62px; }
  .lg-card { padding: 26px 20px 20px; border-radius: 14px; }
  .lg-title { font-size: 21px; }
  .lg-input input { font-size: 16px; }   /* stops iOS zooming into the field */
}

@media (prefers-reduced-motion: reduce) {
  .lg-flow, .lg-ring, .lg-spinner { animation: none; }
  .lg-flow { opacity: 0; }
}
`
