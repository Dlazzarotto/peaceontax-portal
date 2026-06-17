import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'

export async function GET(req: NextRequest) {
  try {
    const db = supabaseAdmin()
    const { searchParams } = new URL(req.url)
    const search = searchParams.get('search')
    const type   = searchParams.get('type')
    const stage  = searchParams.get('stage')

    let query = db.from('clients').select('*').eq('active', true).order('name')
    if (search) query = query.ilike('name', `%${search}%`)
    if (type)   query = query.eq('type', type)
    if (stage)  query = query.eq('stage', stage)

    const { data, error } = await query
    if (error) throw error
    return NextResponse.json({ clients: data || [] })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const db = supabaseAdmin()
    const { data, error } = await db.from('clients').insert(body).select().single()
    if (error) throw error
    return NextResponse.json({ client: data })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
