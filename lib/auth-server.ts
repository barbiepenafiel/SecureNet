// Server-only helpers: find out who is calling an API route.
import { cookies } from 'next/headers'
import { createServerClient as createSsrClient } from '@supabase/ssr'
import { createServerClient } from '@/lib/supabase'
import { can, type Permission, type Profile } from '@/lib/roles'

export async function getCurrentProfile(): Promise<Profile | null> {
  const cookieStore = await cookies()
  const auth = createSsrClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => { /* API routes don't refresh cookies; middleware does */ },
      },
    },
  )
  const { data: { user } } = await auth.auth.getUser()
  if (!user) return null

  const { data } = await createServerClient()
    .from('profiles').select('*').eq('id', user.id).single()
  return (data as Profile) ?? null
}

// Use at the top of an API handler:
//   const gate = await requirePermission('settings.manage'); if (gate instanceof Response) return gate
export async function requirePermission(perm?: Permission): Promise<Profile | Response> {
  const profile = await getCurrentProfile()
  if (!profile) return Response.json({ error: 'Not signed in' }, { status: 401 })
  if (perm && !can(profile.role, perm)) {
    return Response.json({ error: 'You do not have permission to do this' }, { status: 403 })
  }
  return profile
}
