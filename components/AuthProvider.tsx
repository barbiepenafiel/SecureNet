'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { can as canRole, type Permission, type Profile } from '@/lib/roles'

interface AuthState {
  profile: Profile | null
  loading: boolean
  can: (perm: Permission) => boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  profile: null,
  loading: true,
  can: () => false,
  signOut: async () => {},
})

export function useAuth() {
  return useContext(AuthContext)
}

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setProfile(null); setLoading(false); return }
      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single()
      setProfile((data as Profile) ?? null)
      setLoading(false)
    }
    load()
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') load()
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  async function signOut() {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  return (
    <AuthContext.Provider value={{
      profile,
      loading,
      can: (perm) => canRole(profile?.role, perm),
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  )
}
