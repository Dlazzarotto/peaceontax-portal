import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const type = searchParams.get('type')
  if (code) {
    const sb = await supabaseServer()
    await sb.auth.exchangeCodeForSession(code)
    if (type === 'recovery') return NextResponse.redirect(`${origin}/reset-password/new`)
    return NextResponse.redirect(`${origin}/`)
  }
  return NextResponse.redirect(`${origin}/login?error=auth_failed`)
}
