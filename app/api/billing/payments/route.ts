// /api/billing/payments
//
// POST { invoiceId, amount, method, reference?, receivedAt?, financier? }
//   → registra o recebimento. O saldo e a situação da fatura são
//     atualizados pelo próprio banco (gatilho).
//
// Só gerente ou sócio: quem emite não dá baixa.
// Dinheiro, Zelle e Venmo são à vista — o banco recusa valor parcial.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { permissoesFinanceiro, RECUSA } from '@/lib/billing-perms'

export const dynamic = 'force-dynamic'

const MANUAIS = ['zelle', 'venmo', 'cash', 'check', 'wire', 'external', 'other']

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  if (!perms.receber) return NextResponse.json({ error: RECUSA.receber }, { status: 403 })

  const b = await req.json()
  const valor = Math.round((Number(b.amount) || 0) * 100) / 100
  if (!b.invoiceId) return NextResponse.json({ error: 'invoiceId obrigatório' }, { status: 400 })
  if (valor <= 0) return NextResponse.json({ error: 'Informe o valor recebido.' }, { status: 400 })

  const method = String(b.method || '')
  if (!['card', 'ach', ...MANUAIS].includes(method)) {
    return NextResponse.json({ error: 'Forma de pagamento inválida.' }, { status: 400 })
  }

  const db = serviceDb()
  const { data: inv } = await db.from('invoices')
    .select('id, client_id, number, total, paid_total, status').eq('id', b.invoiceId).single()
  if (!inv) return NextResponse.json({ error: 'Fatura não encontrada' }, { status: 404 })
  if (inv.status === 'void') return NextResponse.json({ error: 'Fatura cancelada não recebe pagamento.' }, { status: 409 })

  const saldo = Math.round((Number(inv.total) - Number(inv.paid_total)) * 100) / 100
  if (valor > saldo + 0.005) {
    return NextResponse.json({
      error: `Valor acima do saldo desta fatura ($${saldo.toFixed(2)}).`,
    }, { status: 400 })
  }

  const { error } = await db.from('invoice_payments').insert({
    invoice_id: inv.id,
    client_id: inv.client_id,
    amount: valor,
    method,
    reference: b.reference || null,
    financier: method === 'external' ? (b.financier || null) : null,
    received_at: b.receivedAt ? new Date(b.receivedAt).toISOString() : new Date().toISOString(),
    created_by: auth.userId,
  })
  if (error) {
    // O gatilho do banco devolve a mensagem de "à vista" com o valor certo
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  await db.from('invoice_audit').insert({
    invoice_id: inv.id, action: 'payment', performed_by: auth.userId,
    staff_level: perms.nivel, next: { amount: valor, method },
  }).then(() => null, () => null)

  const restante = Math.round((saldo - valor) * 100) / 100
  return NextResponse.json({
    ok: true,
    message: restante > 0
      ? `Recebido $${valor.toFixed(2)} em ${inv.number} · saldo $${restante.toFixed(2)}`
      : `${inv.number} quitada com $${valor.toFixed(2)}`,
  })
}
