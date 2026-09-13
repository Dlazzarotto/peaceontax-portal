// lib/stripe-invoice.ts — lê a Invoice do Stripe nos dois formatos que o
// webhook pode receber.
//
// A partir da versão 2025-03-31 (Basil) da API, `invoice.subscription` e
// `invoice.payment_intent` deixaram de existir no objeto: a assinatura mora
// em `invoice.parent.subscription_details.subscription` e o pagamento em
// `invoice.payments.data[].payment.payment_intent`. O evento chega no formato
// da versão configurada no endpoint do webhook, não na do SDK. O código lia
// só o formato antigo — com endpoint em versão nova, `subscription` vinha
// vazio e a mensalidade paga era ignorada em silêncio: nada de fatura,
// nada no financeiro. Módulo puro, testável.

const id = (v: unknown): string | null =>
  typeof v === 'string' ? v : (v && typeof v === 'object' && typeof (v as any).id === 'string') ? (v as any).id : null

/** Assinatura que gerou a invoice, em qualquer formato da API. */
export function assinaturaDaInvoice(invoice: any): string | null {
  return id(invoice?.subscription) ?? id(invoice?.parent?.subscription_details?.subscription) ?? null
}

/** PaymentIntent que quitou a invoice, em qualquer formato da API. */
export function intentDaInvoice(invoice: any): string | null {
  const direto = id(invoice?.payment_intent)
  if (direto) return direto
  const pagamentos: any[] = invoice?.payments?.data || []
  for (const p of pagamentos) {
    const pi = id(p?.payment?.payment_intent)
    if (pi) return pi
  }
  return null
}

/** Data-base da competência: início do período faturado, ou a criação. */
export function dataDaCompetencia(invoice: any): Date {
  const linha = invoice?.lines?.data?.[0]?.period?.start
  const ts = invoice?.period_start || linha || invoice?.created || Math.floor(Date.now() / 1000)
  return new Date(Number(ts) * 1000)
}

/** Vencimento da cobrança: due_date do Stripe, senão o início do período. */
export function vencimentoDaInvoice(invoice: any): string {
  const ts = invoice?.due_date || invoice?.next_payment_attempt || null
  const d = ts ? new Date(Number(ts) * 1000) : dataDaCompetencia(invoice)
  return d.toISOString().slice(0, 10)
}

/** Marcada como paga fora do Stripe (baixa manual nossa): não há dinheiro novo. */
export function pagaForaDoStripe(invoice: any): boolean {
  return invoice?.paid_out_of_band === true
}

/** Motivo legível da falha de cobrança, para a trilha e o alerta. */
export function motivoDaFalha(invoice: any): string {
  const erro = invoice?.last_finalization_error?.message
    || invoice?.payments?.data?.[0]?.payment?.payment_intent?.last_payment_error?.message
  return erro || 'débito recusado pelo banco'
}
