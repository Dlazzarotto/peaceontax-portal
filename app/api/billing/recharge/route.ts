// /api/billing/recharge
//
// POST { invoiceId } → pede ao Stripe para cobrar DE NOVO uma fatura em
//   aberto cujo débito automático falhou (NSF, cartão recusado):
//   - mensalidade: a invoice do Stripe ligada à fatura;
//   - parcelamento: a invoice da parcela mais antiga com status 'failed'.
//   O resultado volta pelo webhook (invoice.paid / invoice.payment_failed).
//
// Só gerente ou sócio (mesma permissão de receber). Trilha em invoice_audit.

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { permissoesFinanceiro, RECUSA } from '@/lib/billing-perms'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  if (!perms.receber) return NextResponse.json({ error: RECUSA.receber }, { status: 403 })

  const { invoiceId } = await req.json()
  if (!invoiceId) return NextResponse.json({ error: 'invoiceId obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: inv } = await db.from('invoices')
    .select('id, number, status, total, paid_total, stripe_invoice').eq('id', invoiceId).maybeSingle()
  if (!inv) return NextResponse.json({ error: 'Fatura não encontrada' }, { status: 404 })
  if (['paid', 'void', 'draft'].includes(inv.status)) {
    return NextResponse.json({ error: 'Fatura não está em aberto.' }, { status: 409 })
  }

  // Qual invoice do Stripe cobrar
  let alvo: string | null = inv.stripe_invoice || null
  let parcela: { seq: number; amount: number } | null = null
  if (!alvo) {
    const { data: f } = await db.from('invoice_installments')
      .select('seq, amount, stripe_invoice').eq('invoice_id', inv.id).eq('status', 'failed')
      .order('seq').limit(1).maybeSingle()
    if (f?.stripe_invoice) { alvo = f.stripe_invoice; parcela = { seq: f.seq, amount: Number(f.amount) } }
  }
  if (!alvo) {
    return NextResponse.json({
      error: 'Esta fatura não tem cobrança automática pendente no Stripe. Cobre pelo cartão ou registre o recebimento.',
    }, { status: 409 })
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' as Stripe.LatestApiVersion })
  let resultado: string
  let ok = true
  try {
    const paga = await stripe.invoices.pay(alvo)
    resultado = paga.status === 'paid' ? 'cobrada' : `pedido enviado (${paga.status})`
  } catch (e) {
    ok = false
    resultado = (e as Error).message || 'o Stripe recusou'
  }

  await db.from('invoice_audit').insert({
    invoice_id: inv.id, action: 'recharge_requested', performed_by: auth.userId,
    staff_level: perms.nivel, next: { stripeInvoice: alvo, parcela, ok, resultado },
  }).then(() => null, () => null)

  if (!ok) return NextResponse.json({ error: `Nova cobrança recusada: ${resultado}` }, { status: 502 })
  return NextResponse.json({
    ok: true,
    message: `${inv.number}${parcela ? ` parcela ${parcela.seq}` : ''}: ${resultado}. A confirmação chega pelo Stripe e dá baixa sozinha.`,
  })
}
