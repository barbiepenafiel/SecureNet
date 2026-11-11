import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { isAdminOnlyPath } from '@/lib/roles'

const PUBLIC_PATHS = ['/login']

export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: req })

  const auth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (list: { name: string; value: string; options: CookieOptions }[]) => {
          list.forEach(({ name, value }) => req.cookies.set(name, value))
          res = NextResponse.next({ request: req })
          list.forEach(({ name, value, options }) => res.cookies.set(name, value, options))
        },
      },
    },
  )

  // Also refreshes the session cookie when it is about to expire
  const { data: { user } } = await auth.auth.getUser()

  const path = req.nextUrl.pathname
  const isApi = path.startsWith('/api/')
  const isPublic = PUBLIC_PATHS.includes(path)

  if (!user) {
    if (isPublic) return res
    if (isApi) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    url.search = path === '/' ? '' : `?next=${encodeURIComponent(path)}`
    return NextResponse.redirect(url)
  }

  if (isPublic) {
    const url = req.nextUrl.clone()
    url.pathname = '/'
    url.search = ''
    return NextResponse.redirect(url)
  }

  if (isAdminOnlyPath(path)) {
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    )
    const { data } = await db.from('profiles').select('role').eq('id', user.id).single()
    if (data?.role !== 'net_admin') {
      const url = req.nextUrl.clone()
      url.pathname = '/'
      url.search = '?denied=1'
      return NextResponse.redirect(url)
    }
  }

  return res
}

export const config = {
  // Everything except Next internals and static files
  matcher: ['/((?!_next/static|_next/image|favicon.ico|images/|assets/|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|css|js)$).*)'],
}
