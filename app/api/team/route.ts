// /api/team
//
// Cadastro da equipe — alimenta o seletor de responsável no CRM.
//
//  GET    ?all=1        → lista (por padrão só os ativos)
//  POST   { name, email?, role? }        → inclui
//  PATCH  { id, name?, email?, role?, active? }  → edita ou desativa
//
// Desativar preserva o histórico: o nome some das listas novas, mas os
// clientes já atribuídos continuam mostrando quem cuidava deles.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const todos = req.nextUrl.searchParams.get('all') === '1'
  let q = serviceDb().from('team_members').select('id, name, email, role, active')
  if (!todos) q = q.eq('active', true)

  const { data, error } = await q.order('name', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ members: data || [] })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const b = await req.json()
  const name = String(b.name || '').trim()
  if (name.length < 2) return NextResponse.json({ error: 'Informe o nome de quem entra na equipe.' }, { status: 400 })

  const role = ['owner', 'manager', 'junior'].includes(b.role) ? b.role : 'junior'
  const email = String(b.email || '').trim().toLowerCase() || null

  const { data, error } = await serviceDb().from('team_members')
    .insert({ name, email, role, active: true })
    .select('id, name, email, role, active').single()

  if (error) {
    const dup = /duplicate|unique/i.test(error.message)
    return NextResponse.json(
      { error: dup ? 'Já existe alguém com esse nome na equipe.' : error.message },
      { status: dup ? 409 : 500 })
  }
  return NextResponse.json({ ok: true, member: data })
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const b = await req.json()
  if (!b.id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const upd: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (b.name !== undefined) {
    const n = String(b.name).trim()
    if (n.length < 2) return NextResponse.json({ error: 'Nome muito curto.' }, { status: 400 })
    upd.name = n
  }
  if (b.email !== undefined) upd.email = String(b.email).trim().toLowerCase() || null
  if (b.role !== undefined && ['owner', 'manager', 'junior'].includes(b.role)) upd.role = b.role
  if (b.active !== undefined) upd.active = !!b.active

  const db = serviceDb()
  const { data, error } = await db.from('team_members')
    .update(upd).eq('id', b.id)
    .select('id, name, active').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Renomeou? Atualiza os clientes que apontavam para o nome antigo
  let renomeados = 0
  if (b.name !== undefined && b.oldName && b.oldName !== upd.name) {
    const { data: mudou } = await db.from('clients')
      .update({ assignee: upd.name }).eq('assignee', b.oldName).select('id')
    renomeados = (mudou || []).length
  }

  return NextResponse.json({ ok: true, member: data, renomeados })
}
