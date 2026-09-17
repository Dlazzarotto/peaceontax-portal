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
    // A parcela que falhou MAIS ANTIGA que tenha invoice no Stripe. Antes
    // olhava só a primeira que falhou: se ela tivesse ficado sem invoice
    // (falha antes do finalized), a rota dizia que não havia o que cobrar,
    // mesmo com outra parcela cobrável logo atrás.
    const { data: falhas } = await db.from('invoice_installments')
      .select('seq, amount, stripe_invoice').eq('invoice_id', inv.id).eq('status', 'failed')
      .not('stripe_invoice', 'is', null).order('seq').limit(1)
    const f = falhas?.[0]
    if (f?.stripe_invoice) { alvo = f.stripe_invoice; parcela = { seq: f.seq, amount: Number(f.amount) } }
  }
  if (!alvo) {
    return NextResponse.json({
      error: 'Esta fatura não tem cobrança automática pendente no Stripe. Cobre pelo cartão ou registre o recebimento.',
    }, { status: 409 })
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' as Stripe.LatestApiVersion })

  // Dois cliques (ou duas pessoas) cobravam DUAS VEZES do cliente:
  // `invoices.pay` não é idempotente por conta própria. A chave é a invoice
  // do Stripe mais quantas vezes ela já foi recobrada — cliques simultâneos
  // leem o mesmo número, então o Stripe trata o segundo como repetição;
  // uma nova tentativa deliberada, depois, tem número novo e passa.
  const { count: tentativas } = await db.from('invoice_audit')
    .select('id', { count: 'exact', head: true })
    .eq('invoice_id', inv.id).eq('action', 'recharge_requested')
  const chave = `recharge:${alvo}:${tentativas ?? 0}`

  let resultado: string
  let ok = true
  try {
    const paga = await stripe.invoices.pay(alvo, {}, { idempotencyKey: chave })
    resultado = paga.status === 'paid' ? 'cobrada' : `pedido enviado (${paga.status})`
  } catch (e: any) {
    ok = false
    // O Stripe recusa pagar invoice já paga: não é erro da equipe, é o
    // webhook que ainda não chegou.
    const msg = String(e?.raw?.message || e?.message || '')
    resultado = /already (been )?paid|no longer open/i.test(msg)
      ? 'esta cobrança já foi paga no Stripe — a baixa chega pelo webhook'
      : (msg || 'o Stripe recusou')
  }

  await db.from('invoice_audit').insert({
    invoice_id: inv.id, action: 'recharge_requested', performed_by: auth.userId,
    staff_level: perms.nivel, next: { stripeInvoice: alvo, parcela, ok, resultado, chave },
  }).then(() => null, () => null)

  if (!ok) return NextResponse.json({ error: `Nova cobrança recusada: ${resultado}` }, { status: 502 })
  return NextResponse.json({
    ok: true,
    message: `${inv.number}${parcela ? ` parcela ${parcela.seq}` : ''}: ${resultado}. A confirmação chega pelo Stripe e dá baixa sozinha.`,
  })
}
