// GET    /api/bookkeeping/rules?clientId=...  — regras do cliente + globais
// POST   /api/bookkeeping/rules               — cria regra (manager/owner)
// DELETE /api/bookkeeping/rules?id=...        — exclui regra (manager/owner)

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'

async function requireManager(userId: string) {
  const level = await getStaffLevel(userId)
  return level === 'owner' || level === 'manager'
}

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })

  const { data, error } = await serviceDb()
    .from('bookkeeping_rules')
    .select('*')
    .or(`client_id.eq.${clientId},client_id.is.null`)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rules: data || [] })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  if (!(await requireManager(auth.userId))) {
    return NextResponse.json({ error: 'Somente manager/owner criam regras' }, { status: 403 })
  }

  const b = await req.json()
  const name = String(b.name || '').trim()
  const pattern = String(b.pattern || '').trim().toLowerCase() || null
  const category = String(b.category || '').trim()
  const direction = ['in','out','both'].includes(b.direction) ? b.direction : 'both'
  const matchType = ['contains','starts_with'].includes(b.matchType) ? b.matchType : 'contains'
  const amountOp = ['gt','lt','eq'].includes(b.amountOp) ? b.amountOp : null
  const amountValue = amountOp ? Number(b.amountValue) : null
  const payee = String(b.payee || '').trim() || null
  const global = b.scope === 'global'

  if (name.length < 2) return NextResponse.json({ error: 'Nome da regra obrigatório' }, { status: 400 })
  if (!category) return NextResponse.json({ error: 'Categoria obrigatória' }, { status: 400 })
  if (!pattern && !amountOp) return NextResponse.json({ error: 'Defina ao menos uma condição (descrição ou valor)' }, { status: 400 })
  if (amountOp && (amountValue == null || isNaN(amountValue))) {
    return NextResponse.json({ error: 'Valor da condição inválido' }, { status: 400 })
  }
  if (!global && !b.clientId) return NextResponse.json({ error: 'clientId obrigatório para regra do cliente' }, { status: 400 })

  const { error } = await serviceDb().from('bookkeeping_rules').insert({
    client_id: global ? null : b.clientId,
    name, pattern, category, direction,
    match_type: matchType, amount_op: amountOp, amount_value: amountValue,
    payee, priority: 30, created_by: 'staff',
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  if (!(await requireManager(auth.userId))) {
    return NextResponse.json({ error: 'Somente manager/owner' }, { status: 403 })
  }
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })
  const { error } = await serviceDb().from('bookkeeping_rules').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
