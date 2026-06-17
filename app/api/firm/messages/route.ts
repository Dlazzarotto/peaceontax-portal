import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'

export async function POST(req: NextRequest) {
  try {
    const { clientId, text } = await req.json()
    if (!clientId || !text?.trim()) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    const db = supabaseAdmin()
    const { data } = await db.from('messages').insert({ client_id: clientId, sender: 'firm', text: text.trim() }).select().single()
    return NextResponse.json({ message: data })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
