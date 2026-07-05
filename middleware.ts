import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

const PUBLIC = ['/login', '/invite', '/reset-password', '/auth/callback', '/api/invite', '/agendar']

// APIs acessíveis sem login (prospects precisam agendar antes de ter conta).
// Todas as demais /api/ agora exigem sessão válida.
const API_PUBLIC = ['/api/invite', '/api/agenda/slots', '/api/agenda/bookings']

const FIRM_ONLY = ['/dashboard', '/clients', '/invitations', '/bookkeeping', '/reports', '/settings']
const CLIENT_ONLY = ['/portal', '/organizer', '/messages', '/payments']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const response = NextResponse.next({ request })

  if (PUBLIC.some(p => pathname === p || pathname.startsWith(p + '/'))) return response
  if (pathname.startsWith('/_next/') || pathname.includes('.')) return response

  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (pairs) => pairs.forEach(({ name, value, options }) => {
          request.cookies.set(name, value)
          response.cookies.set(name, value, options)
        }),
      },
    }
  )

  // ---- APIs: públicas explícitas passam; o resto exige sessão (401, sem redirect) ----
  if (pathname.startsWith('/api/')) {
    if (API_PUBLIC.some(p => pathname === p || pathname.startsWith(p + '/'))) return response
    const { data: { user } } = await sb.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
    return response
  }

  const { data: { user } } = await sb.auth.getUser()
  if (!user) {
    const url = new URL('/login', request.url)
    url.searchParams.set('redirectTo', pathname)
    return NextResponse.redirect(url)
  }

  const role = user.user_metadata?.role === 'firm' ? 'firm' : 'client'

  if (FIRM_ONLY.some(p => pathname.startsWith(p)) && role === 'client')
    return NextResponse.redirect(new URL('/portal', request.url))

  if (CLIENT_ONLY.some(p => pathname.startsWith(p)) && role === 'firm')
    return NextResponse.redirect(new URL('/dashboard', request.url))

  if (pathname === '/')
    return NextResponse.redirect(new URL(role === 'firm' ? '/dashboard' : '/portal', request.url))

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
