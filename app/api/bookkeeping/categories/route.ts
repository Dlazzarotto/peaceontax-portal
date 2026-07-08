// GET  /api/bookkeeping/categories — lista (equipe)
// POST /api/bookkeeping/categories { name, kind } — cria (manager/owner)

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

  const { name, kind } = await req.json()
  const clean = String(name || '').trim()
  if (clean.length < 2 || clean.length > 60) return NextResponse.json({ error: 'Nome: 2 a 60 caracteres' }, { status: 400 })
  if (!['income','expense','non_pnl'].includes(kind)) return NextResponse.json({ error: 'Tipo inválido' }, { status: 400 })

  const { error } = await serviceDb().from('bookkeeping_categories').insert({ name: clean, kind })
  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'Categoria já existe' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
