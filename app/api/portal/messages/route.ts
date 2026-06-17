import { NextRequest, NextResponse } from 'next/server'
import { getUser } from '@/lib/supabase-server'
import { supabaseAdmin } from '@/lib/supabase-browser'

export async function GET() {
  try {
    const user = await getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const db = supabaseAdmin()
    const { data: client } = await db.from('clients').select('*').eq('user_id', user.id).single()
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    const { data: messages } = await db.from('messages').select('*').eq('client_id', client.id).order('created_at', { ascending: true })
    return NextResponse.json({ client, messages: messages || [] })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { text } = await req.json()
    if (!text?.trim()) return NextResponse.json({ error: 'Message is empty' }, { status: 400 })
    const db = supabaseAdmin()
    const { data: client } = await db.from('clients').select('id').eq('user_id', user.id).single()
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    const { data: message } = await db.from('messages').insert({ client_id: client.id, sender: 'client', text: text.trim() }).select().single()
    return NextResponse.json({ message })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
