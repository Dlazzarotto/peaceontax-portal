// PATCH  /api/quotes/[id] — editar itens/total de uma cotação (draft ou sent)
// DELETE /api/quotes/[id] — cancelar cotação (exige motivo)
// Regras:
//   owner/manager: direto
//   junior: exige managerPin válido + reason
// Toda ação grava em quote_audit.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel, validateManagerPin, auditQuote } from '@/lib/staff-perms'

interface QuoteItem { label: string; amount: number; qty?: number }

async function authorize(userId: string, managerPin?: string, reason?: string) {
  const level = await getStaffLevel(userId)
  if (level === 'owner' || level === 'manager') {
    return { ok: true as const, approvedBy: null, level }
  }
  // Junior: precisa de PIN + motivo
  if (!reason?.trim()) {
    return { ok: false as const, error: 'Motivo obrigatório para alterações (nível junior).' }
  }
  const approvedBy = await validateManagerPin(managerPin ?? '')
  if (!approvedBy) {
    return { ok: false as const, error: 'PIN de manager inválido. Peça aprovação a um manager.' }
  }
  return { ok: true as const, approvedBy, level }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito à equipe' }, { status: 403 })

  const body = await req.json()
  const { items, managerPin, reason } = body as { items: QuoteItem[]; managerPin?: string; reason?: string }

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'items obrigatório' }, { status: 400 })
  }
  // Validação dos itens
  for (const it of items) {
    if (!it.label?.trim() || typeof it.amount !== 'number' || it.amount < 0 || it.amount > 50000) {
      return NextResponse.json({ error: 'Item inválido (label e amount 0–50000 obrigatórios)' }, { status: 400 })
    }
  }

  const perm = await authorize(auth.userId, managerPin, reason)
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: 403 })

  const db = serviceDb()
  const { data: current } = await db.from('quotes').select('*').eq('id', params.id).single()
  if (!current) return NextResponse.json({ error: 'Cotação não encontrada' }, { status: 404 })
  if (current.status === 'paid') {
    return NextResponse.json({ error: 'Cotação paga não pode ser alterada' }, { status: 409 })
  }

  const total = items.reduce((s, i) => s + i.amount, 0)

  const { data: updated, error } = await db
    .from('quotes')
    .update({ items, total, updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await auditQuote({
    quoteId: params.id,
    action: 'edited',
    performedBy: auth.userId,
    approvedBy: perm.approvedBy,
    reason: reason ?? null,
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

  // Cancelamento SEMPRE exige motivo, mesmo para owner/manager
  if (!reason?.trim()) {
    return NextResponse.json({ error: 'Motivo do cancelamento é obrigatório.' }, { status: 400 })
  }

  const perm = await authorize(auth.userId, managerPin, reason)
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: 403 })

  const db = serviceDb()
  const { data: current } = await db.from('quotes').select('*').eq('id', params.id).single()
  if (!current) return NextResponse.json({ error: 'Cotação não encontrada' }, { status: 404 })
  if (current.status === 'paid') {
    return NextResponse.json({ error: 'Cotação paga não pode ser cancelada por aqui — use reembolso no Stripe.' }, { status: 409 })
  }

  const { error } = await db
    .from('quotes')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await auditQuote({
    quoteId: params.id,
    action: 'cancelled',
    performedBy: auth.userId,
    approvedBy: perm.approvedBy,
    reason,
    previousState: { status: current.status, items: current.items, total: current.total },
    newState: { status: 'cancelled' },
  })

  return NextResponse.json({ ok: true })
}
