// GET  /api/bookkeeping/categories — lista (equipe)
// POST /api/bookkeeping/categories { name, kind, parent? } — cria (manager/owner)
//   parent: nome de categoria existente do MESMO kind → sub-conta "Pai: Filho"

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'

export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const { data, error } = await serviceDb()
    .from('bookkeeping_categories')
    .select('id, name, kind, active')
    .eq('active', true)
    .order('kind').order('name')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ categories: data || [] })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return NextResponse.json({ error: 'Somente manager/owner criam categorias' }, { status: 403 })
  }

  const { name, kind, parent } = await req.json()
  let clean = String(name || '').trim()
  if (clean.length < 2 || clean.length > 60) return NextResponse.json({ error: 'Nome: 2 a 60 caracteres' }, { status: 400 })
  if (!['income','cogs','expense','other_income','other_expense','liability','asset','non_pnl'].includes(kind)) return NextResponse.json({ error: 'Tipo inválido' }, { status: 400 })
  if (clean.includes(':')) return NextResponse.json({ error: 'Não use ":" no nome — ele é reservado para sub-contas' }, { status: 400 })

  const db = serviceDb()
  const parentClean = String(parent || '').trim()
  if (parentClean) {
    const { data: parentCat } = await db.from('bookkeeping_categories')
      .select('name, kind').eq('name', parentClean).eq('active', true).single()
    if (!parentCat) return NextResponse.json({ error: 'Categoria-mãe não encontrada' }, { status: 400 })
    if (parentCat.kind !== kind) return NextResponse.json({ error: `A sub-conta deve ser do mesmo tipo da mãe (${parentCat.kind})` }, { status: 400 })
    if (parentClean.includes(':')) return NextResponse.json({ error: 'Só um nível de sub-conta (a mãe já é sub)' }, { status: 400 })
    clean = `${parentClean}: ${clean}`   // padrão QuickBooks "Pai: Filho"
  }

  const { error } = await db.from('bookkeeping_categories').insert({ name: clean, kind })
  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'Categoria já existe' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
