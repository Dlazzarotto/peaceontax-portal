import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase-server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const type = searchParams.get('type')
  if (code) {
    const sb = await supabaseServer()
    const { error } = await sb.auth.exchangeCodeForSession(code)
    if (error) {
      // Link expirado/inválido: dizer a verdade e oferecer novo pedido
      const dest = type === 'recovery' ? '/reset-password?error=expired' : '/login?error=link_expired'
      return NextResponse.redirect(`${origin}${dest}`)
    }
    if (type === 'recovery') return NextResponse.redirect(`${origin}/reset-password/new`)
    return NextResponse.redirect(`${origin}/`)
  }
  return NextResponse.redirect(`${origin}/login?error=auth_failed`)
}
