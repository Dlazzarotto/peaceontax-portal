// lib/stripe-invoice.ts — lê a Invoice do Stripe como ela REALMENTE chega.
//
// O endpoint desta conta está na versão 2026-06-24.dahlia. A partir da versão
// 2025-03-31 (Basil), o objeto Invoice perdeu vários campos no topo, e o
// payload do webhook (conferido em dois eventos reais de 05/09/2026) confirma:
//
//   NÃO vêm:  subscription · payment_intent · charge · paid · paid_out_of_band
//   Vêm:      parent.subscription_details.{subscription, metadata}
//             lines.data[].period · status · amount_paid · status_transitions
//   NÃO vem:  payments  — é campo EXPANSÍVEL, e webhook nunca traz expandido
//
// Consequência prática: forma de pagamento, PaymentIntent e motivo de recusa
// NÃO existem no evento. Quem precisa deles tem de buscar a invoice na API
// com expand (ver detalhesDoPagamento no webhook). As funções abaixo leem só
// o que o payload garante. Módulo puro, testável.

const id = (v: unknown): string | null =>
  typeof v === 'string' ? v : (v && typeof v === 'object' && typeof (v as any).id === 'string') ? (v as any).id : null

/** Assinatura que gerou a invoice. Formato antigo e novo. */
export function assinaturaDaInvoice(invoice: any): string | null {
  return id(invoice?.subscription) ?? id(invoice?.parent?.subscription_details?.subscription) ?? null
}

/**
 * Plano gravado no metadata da assinatura (planId/planKind).
 * Vale mais que a assinatura: o metadata viaja com a invoice mesmo quando o
 * stripe_subscription_id do nosso banco está vazio ou defasado — o que
 * acontece em plano criado por SubscriptionSchedule, que nasce sem assinatura.
 */
export function planoDaInvoice(invoice: any): { planId: string | null; planKind: string | null } {
  const m = invoice?.parent?.subscription_details?.metadata
    || invoice?.lines?.data?.[0]?.metadata
    || invoice?.subscription_details?.metadata
    || {}
  return {
    planId: typeof m.planId === 'string' && m.planId ? m.planId : null,
    planKind: typeof m.planKind === 'string' && m.planKind ? m.planKind : null,
  }
}

/**
 * PaymentIntent que quitou a invoice. SÓ funciona numa invoice buscada com
 * expand — no payload do webhook devolve null, e é o esperado.
 */
export function intentDaInvoice(invoice: any): string | null {
  const direto = id(invoice?.payment_intent)
  if (direto) return direto
  for (const p of (invoice?.payments?.data || [])) {
    const pi = id(p?.payment?.payment_intent)
    if (pi) return pi
  }
  return null
}

/**
 * Data-base da competência: o período do SERVIÇO faturado, que está na linha
 * da invoice — não em invoice.period_start.
 *
 * Conferido nos eventos reais: numa cobrança de 05/09 cobrindo 05/09→05/10,
 * lines[0].period.start = 05/09 (certo), mas invoice.period_start = 27/08 num
 * cliente e 20/08 no outro — data de atividade anterior da assinatura, não do
 * serviço. Lendo period_start, toda fatura nascia com a competência do mês
 * ANTERIOR e o cliente recebia "Bookkeeping mensal — agosto" por setembro.
 */
export function dataDaCompetencia(invoice: any): Date {
  const ts = invoice?.lines?.data?.[0]?.period?.start
    || invoice?.period_start
    || invoice?.created
  return new Date(Number(ts) * 1000)
}

/** Vencimento da cobrança: due_date do Stripe, senão o início do período. */
export function vencimentoDaInvoice(invoice: any): string {
  const ts = invoice?.due_date || invoice?.next_payment_attempt || null
  const d = ts ? new Date(Number(ts) * 1000) : dataDaCompetencia(invoice)
  return d.toISOString().slice(0, 10)
}

/**
 * Paga sem dinheiro novo pelo Stripe (baixa manual nossa, crédito de saldo).
 * SÓ decide numa invoice buscada com expand: quitada e sem nenhum pagamento
 * registrado. No payload do webhook devolve false — por isso a trava de
 * reprocessamento no webhook é por ESTADO (cobrancaJaRegistrada), não por
 * este sinal.
 */
export function pagaForaDoStripe(invoice: any): boolean {
  if (invoice?.paid_out_of_band === true) return true
  if (!invoice?.payments) return false
  const quitada = invoice?.status === 'paid' || Number(invoice?.amount_remaining ?? 1) === 0
  return quitada && (invoice.payments.data || []).length === 0
}

/** Motivo legível da recusa. Precisa da invoice expandida para ser específico. */
export function motivoDaFalha(invoice: any): string {
  for (const p of (invoice?.payments?.data || [])) {
    const erro = p?.payment?.payment_intent?.last_payment_error
    if (erro?.message) return erro.message
    const cod = p?.payment?.payment_intent?.last_payment_error?.decline_code
    if (cod) return String(cod)
  }
  return invoice?.last_finalization_error?.message || 'débito recusado pelo banco'
}
