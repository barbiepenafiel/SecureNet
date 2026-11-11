'use client'

import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'

function LoginForm() {
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
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

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: 16,
    }}>
      <form onSubmit={submit} className="card" style={{ width: '100%', maxWidth: 380 }}>
        <div className="card-body" style={{ padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <img src="/images/dnsc_logo.png" alt="" width={36} height={36} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 18 }}>Securenet</div>
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>DNSC Network Monitoring</div>
            </div>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text2)', margin: '18px 0' }}>Sign in with your staff account.</div>

          <div className="form-group">
            <label className="form-label" htmlFor="email">Email</label>
            <input id="email" className="form-input" type="email" autoComplete="email" required suppressHydrationWarning
              value={email} onChange={e => setEmail(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="password">Password</label>
            <input id="password" className="form-input" type="password" autoComplete="current-password" required suppressHydrationWarning
              value={password} onChange={e => setPassword(e.target.value)} />
          </div>

          {error && (
            <div style={{ color: 'var(--crit)', fontSize: 13, marginBottom: 12 }}>{error}</div>
          )}

          <button className="btn btn-primary" type="submit" disabled={busy} suppressHydrationWarning
            style={{ width: '100%', justifyContent: 'center', padding: '9px 12px' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 16, textAlign: 'center' }}>
            No account? Ask a Network Admin to add you.
          </div>
        </div>
      </form>
    </div>
  )
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>
}
