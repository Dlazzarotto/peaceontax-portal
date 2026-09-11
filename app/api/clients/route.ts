// GET  /api/clients — lista de clientes da firma (só equipe)
// POST /api/clients — cadastra cliente (só equipe)
//
// O middleware só garante que existe sessão: sem a conferência abaixo, um
// cliente logado no portal enxergava a carteira inteira da firma.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'
import { getAuth } from '@/lib/api-auth'

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuth()
    if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
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
    const auth = await getAuth()
    if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
    const body = await req.json()
    const db = supabaseAdmin()
    const { data, error } = await db.from('clients').insert(body).select().single()
    if (error) throw error
    return NextResponse.json({ client: data })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
