// GET   /api/pricing — lista catálogo (toda a equipe; usado no editor de cotação)
// POST  /api/pricing — cria item (SÓ OWNER)
// PATCH /api/pricing — edita item (SÓ OWNER)  Body: { id, label?, amount?, active?, kind?, sort? }

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'

export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const { data, error } = await serviceDb()
    .from('pricing_items')
    .select('*')
    .order('sort')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data })
}

async function requireOwner(userId: string) {
  const level = await getStaffLevel(userId)
  return level === 'owner'
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  if (!(await requireOwner(auth.userId))) {
    return NextResponse.json({ error: 'Somente o owner cria itens de cobrança' }, { status: 403 })
  }

  const { label, amount, kind } = await req.json()
  if (!label?.trim() || typeof amount !== 'number' || amount < 0 || amount > 50000) {
    return NextResponse.json({ error: 'label e amount (0–50000) obrigatórios' }, { status: 400 })
  }
  const validKind = ['per_unit','fixed','discount'].includes(kind) ? kind : 'fixed'
  const code = 'custom_' + label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40) + '_' + Date.now().toString(36)

  const { data, error } = await serviceDb()
    .from('pricing_items')
    .insert({ code, label: label.trim(), amount, kind: validKind, sort: 50 })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, item: data })
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  if (!(await requireOwner(auth.userId))) {
    return NextResponse.json({ error: 'Somente o owner altera itens de cobrança' }, { status: 403 })
  }

  const { id, label, amount, active, kind, sort } = await req.json()
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (label !== undefined) {
    if (!label.trim()) return NextResponse.json({ error: 'label inválido' }, { status: 400 })
    patch.label = label.trim()
  }
  if (amount !== undefined) {
    if (typeof amount !== 'number' || amount < 0 || amount > 50000) {
      return NextResponse.json({ error: 'amount 0–50000' }, { status: 400 })
    }
    patch.amount = amount
  }
  if (active !== undefined) patch.active = !!active
  if (kind !== undefined && ['per_unit','fixed','discount','base_single','base_married'].includes(kind)) patch.kind = kind
  if (sort !== undefined) patch.sort = Number(sort) || 100

  const { error } = await serviceDb().from('pricing_items').update(patch).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
