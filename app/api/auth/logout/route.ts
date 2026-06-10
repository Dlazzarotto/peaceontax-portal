import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  const sb = await supabaseServer()
  await sb.auth.signOut()
  return NextResponse.redirect(new URL('/login', req.url))
}
