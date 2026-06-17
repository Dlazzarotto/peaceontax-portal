import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const db = supabaseAdmin()
    const [{ data: client }, { data: docs }, { data: msgs }] = await Promise.all([
      db.from('clients').select('*').eq('id', params.id).single(),
      db.from('documents').select('*').eq('client_id', params.id).order('created_at', { ascending: false }),
      db.from('messages').select('*').eq('client_id', params.id).order('created_at', { ascending: false }).limit(20),
    ])
    return NextResponse.json({ client, documents: docs || [], messages: msgs || [] })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.json()
    const db = supabaseAdmin()
    const { data, error } = await db.from('clients').update({ ...body, updated_at: new Date().toISOString() }).eq('id', params.id).select().single()
    if (error) throw error
    return NextResponse.json({ client: data })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const db = supabaseAdmin()
    await db.from('clients').update({ active: false, updated_at: new Date().toISOString() }).eq('id', params.id)
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
