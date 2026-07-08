// GET  /api/bookkeeping/payees?clientId=... — cadastro de payees do cliente
// POST /api/bookkeeping/payees { clientId, name, type } — cria/atualiza (equipe)

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })

  const { data, error } = await serviceDb().from('payees')
    .select('id, name, type').eq('client_id', clientId).eq('active', true)
    .order('type').order('name')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ payees: data || [] })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const { clientId, name, type } = await req.json()
  const clean = String(name || '').trim()
  if (!clientId || clean.length < 2) return NextResponse.json({ error: 'clientId e name obrigatórios' }, { status: 400 })
  if (!['vendor','customer'].includes(type)) return NextResponse.json({ error: 'type: vendor ou customer' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const { error } = await serviceDb().from('payees')
    .upsert({ client_id: clientId, name: clean, type }, { onConflict: 'client_id,name' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
