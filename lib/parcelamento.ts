// lib/parcelamento.ts — encerrar um parcelamento de fatura, num lugar só.
//
// Quatro caminhos levam ao mesmo lugar e precisam fazer a MESMA coisa, senão
// sobra débito órfão cobrando o cliente:
//   1. quitação antecipada pela tela (recebimento manual do saldo)
//   2. fatura quitada pelo Stripe (cartão/Klarna/ACH no link da equipe)
//   3. cancelamento da fatura antes de qualquer cobrança
//   4. cancelamento SÓ DO PARCELAMENTO, com a fatura seguindo em aberto —
//      o acordo não se cumpriu, o cliente vai pagar de outro jeito
//
// O caso 4 era proibido ("parcelamento não se cancela em andamento"). Não era
// decisão de negócio: era a falta de um caminho definido para ele. O acordo
// desandar é normal — o que não pode é o débito continuar rodando enquanto a
// firma cobra por fora. O que já foi PAGO fica pago: o cancelamento para a
// cobrança futura, nunca desfaz recebimento (isso é estorno, e tem rotina
// própria em lib/estorno-stripe.ts).
//
// O que ninguém pode esquecer, e que estava faltando: além de cancelar o
// schedule/assinatura, é preciso FECHAR AS INVOICES JÁ ABERTAS das parcelas.
// Cancelar a assinatura no Stripe não fecha invoice que já foi finalizada —
// uma parcela em NSF continuava lá, aberta, e o cliente era debitado de novo
// depois de a fatura estar quitada.

import type Stripe from 'stripe'

export type MotivoDoEncerramento = 'quitacao' | 'fatura_cancelada' | 'plano_cancelado'

/** Parcelamento vivo desta fatura, se houver. */
export const STATUS_VIVOS = ['draft', 'awaiting_entry', 'awaiting_setup', 'awaiting_signature',
  'active', 'paused', 'payment_failed'] as const

export async function parcelamentoVivo(db: any, invoiceId: string) {
  const { data } = await db.from('payment_plans')
    .select('id, status, kind, installments, paid_installments, stripe_schedule_id, stripe_subscription_id')
    .eq('invoice_id', invoiceId).eq('kind', 'installment')
    .in('status', STATUS_VIVOS as unknown as string[])
    .order('created_at', { ascending: false })
  // Pode existir mais de um por dados antigos: o mais recente é o que vale,
  // e maybeSingle() daria erro em vez de resposta.
  return (data && data[0]) || null
}

/**
 * Encerra o parcelamento: para a cobrança no Stripe, fecha as invoices das
 * parcelas que ficaram abertas e acerta o cronograma e o plano.
 * Devolve o que deu certo, para quem chamou avisar a equipe com honestidade.
 */
export async function encerrarParcelamento(
  db: any, stripe: Stripe, plano: any, invoiceId: string,
  opts: { motivo: MotivoDoEncerramento; performedBy?: string | null; razao?: string | null },
): Promise<{ stripeOk: boolean; parcelasFechadas: number; nota: string }> {
  const quitou = opts.motivo === 'quitacao'
  let stripeOk = true

  // 1. Para a régua de cobrança
  try {
    if (plano.stripe_schedule_id) await stripe.subscriptionSchedules.cancel(plano.stripe_schedule_id)
    else if (plano.stripe_subscription_id) await stripe.subscriptions.cancel(plano.stripe_subscription_id)
  } catch (e) {
    stripeOk = false
    console.error('encerrarParcelamento: cancelar no Stripe:', (e as Error).message)
  }

  // 2. Invoices de parcela que já estavam abertas no Stripe (NSF, por exemplo):
  //    cancelar a assinatura NÃO as fecha. Quitada, a parcela sai como paga
  //    fora do Stripe; fatura cancelada, a invoice é anulada.
  const { data: pendentes } = await db.from('invoice_installments')
    .select('id, seq, stripe_invoice').eq('invoice_id', invoiceId)
    .in('status', ['scheduled', 'charged', 'failed'])
  let parcelasFechadas = 0
  for (const p of (pendentes || [])) {
    if (!p.stripe_invoice) continue
    try {
      if (quitou) await stripe.invoices.pay(p.stripe_invoice, { paid_out_of_band: true })
      else await stripe.invoices.voidInvoice(p.stripe_invoice)
      parcelasFechadas++
    } catch (e) {
      stripeOk = false
      console.error(`encerrarParcelamento: parcela ${p.seq} no Stripe:`, (e as Error).message)
    }
  }

  // 3. Cronograma e plano
  const agora = new Date().toISOString()
  await db.from('invoice_installments')
    .update(quitou ? { status: 'paid', paid_at: agora } : { status: 'canceled' })
    .eq('invoice_id', invoiceId).in('status', ['scheduled', 'charged', 'failed'])

  await db.from('payment_plans').update({
    status: quitou ? 'completed' : 'cancelled',
    ...(quitou
      ? { paid_installments: plano.installments }
      : { cancel_reason: opts.razao?.trim()
            || (opts.motivo === 'plano_cancelado' ? 'parcelamento cancelado' : 'fatura cancelada') }),
    updated_at: agora,
  }).eq('id', plano.id)

  // A fatura volta a ser uma fatura comum em aberto: o saldo continua
  // devido, sem cronograma nem débito automático atrás dele. Só neste
  // caminho — quitação e fatura cancelada não deixam saldo a cobrar.
  if (opts.motivo === 'plano_cancelado') {
    await db.from('invoices').update({ payment_plan: 'full' }).eq('id', invoiceId)
  }

  await db.from('plan_audit').insert({
    plan_id: plano.id,
    action: quitou ? 'paid_off_early'
      : opts.motivo === 'plano_cancelado' ? 'installments_cancelled' : 'cancelled_with_invoice',
    performed_by: opts.performedBy || null,
    reason: opts.razao?.trim() || null,
    snapshot: { previous_status: plano.status, stripe_cancelado: stripeOk, parcelas_fechadas: parcelasFechadas },
  }).then(() => null, () => null)

  const nota = stripeOk
    ? (quitou
        ? ' · parcelamento quitado antecipadamente; débito automático encerrado'
        : opts.motivo === 'plano_cancelado'
          ? ' · parcelamento cancelado; débito automático encerrado e a fatura segue em aberto com o saldo'
          : ' · parcelamento cancelado junto; débito automático encerrado')
    : ' · ATENÇÃO: o débito no Stripe não pôde ser encerrado por completo — abra a assinatura no painel do Stripe e cancele, senão o cliente será cobrado de novo'
  return { stripeOk, parcelasFechadas, nota }
}
