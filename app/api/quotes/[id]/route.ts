// PATCH  /api/quotes/[id] — editar itens (draft/sent)
// DELETE /api/quotes/[id] — cancelar (motivo sempre)
// REGRA DE DESCONTO: qualquer item com valor negativo exige PIN de
// manager/owner + motivo, INDEPENDENTE do nível de quem edita.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel, validateManagerPin, auditQuote } from '@/lib/staff-perms'

interface QuoteItem { label: string; amount: number; qty?: number }

async function authorize(userId: string, managerPin?: string, reason?: string, forcePin = false) {
  const level = await getStaffLevel(userId)
  const isSenior = level === 'owner' || level === 'manager'

  if (isSenior && !forcePin) return { ok: true as const, approvedBy: null, level }

  // Junior sempre, ou qualquer nível quando forcePin (desconto)
  if (!reason?.trim()) {
    return { ok: false as const, error: forcePin
      ? 'Motivo é obrigatório para aplicar desconto.'
      : 'Motivo obrigatório para alterações (nível junior).' }
  }
  const approvedBy = await validateManagerPin(managerPin ?? '')
  if (!approvedBy) {
    return { ok: false as const, error: forcePin
      ? 'Desconto exige PIN válido de manager/owner.'
      : 'PIN de manager inválido.' }
  }
  return { ok: true as const, approvedBy, level }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito à equipe' }, { status: 403 })

  const { items, managerPin, reason } = await req.json() as
    { items: QuoteItem[]; managerPin?: string; reason?: string }

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'items obrigatório' }, { status: 400 })
  }
  for (const it of items) {
    const q = it.qty ?? 1
    if (!it.label?.trim() || typeof it.amount !== 'number' || it.amount < -50000 || it.amount > 50000 || q < 1 || q > 999) {
      return NextResponse.json({ error: 'Item inválido (label e amount entre -50000 e 50000)' }, { status: 400 })
    }
  }

  const hasDiscount = items.some(i => i.amount < 0)
  const perm = await authorize(auth.userId, managerPin, reason, hasDiscount)
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: 403 })

  const db = serviceDb()
  const { data: current } = await db.from('quotes').select('*').eq('id', params.id).single()
  if (!current) return NextResponse.json({ error: 'Cotação não encontrada' }, { status: 404 })
  if (current.status === 'paid') {
    return NextResponse.json({ error: 'Cotação paga não pode ser alterada' }, { status: 409 })
  }

  const total = items.reduce((s, i) => s + i.amount * (i.qty || 1), 0)
  if (total < 0) return NextResponse.json({ error: 'Total não pode ser negativo' }, { status: 400 })

  const { data: updated, error } = await db.from('quotes')
    .update({ items, total, updated_at: new Date().toISOString() })
    .eq('id', params.id).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await auditQuote({
    quoteId: params.id, action: 'edited',
    performedBy: auth.userId, approvedBy: perm.approvedBy,
    reason: reason ?? (hasDiscount ? 'desconto aplicado' : null),
    previousState: { items: current.items, total: current.total },
    newState: { items, total },
  })
  return NextResponse.json({ ok: true, quote: updated })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito à equipe' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const { managerPin, reason } = body as { managerPin?: string; reason?: string }
  if (!reason?.trim()) {
    return NextResponse.json({ error: 'Motivo do cancelamento é obrigatório.' }, { status: 400 })
  }

  const perm = await authorize(auth.userId, managerPin, reason)
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: 403 })

  const db = serviceDb()
  const { data: current } = await db.from('quotes').select('*').eq('id', params.id).single()
  if (!current) return NextResponse.json({ error: 'Cotação não encontrada' }, { status: 404 })
  if (current.status === 'paid') {
    return NextResponse.json({ error: 'Cotação paga: use reembolso no Stripe.' }, { status: 409 })
  }

  const { error } = await db.from('quotes')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await auditQuote({
    quoteId: params.id, action: 'cancelled',
    performedBy: auth.userId, approvedBy: perm.approvedBy, reason,
    previousState: { status: current.status, items: current.items, total: current.total },
    newState: { status: 'cancelled' },
  })
  return NextResponse.json({ ok: true })
}
