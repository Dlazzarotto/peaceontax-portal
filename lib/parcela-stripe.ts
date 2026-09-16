// lib/parcela-stripe.ts — qual parcela do cronograma o Stripe está cobrando.
//
// Existe porque o número da parcela saía de `paid_installments + 1`. Parecia
// certo e não é: o Stripe não garante ordem de entrega dos eventos, uma
// parcela pode falhar e a seguinte ser paga antes, e a baixa manual por fora
// mexe no cronograma sem passar pelo webhook. Em qualquer desses casos o
// contador apontava para a parcela ERRADA — e era ela que recebia a baixa ou
// a marca de falha.
//
// Aqui a verdade é o cronograma (`invoice_installments`), amarrado à invoice
// do Stripe no `invoice.finalized`.

/**
 * Qual parcela do cronograma esta invoice do Stripe representa.
 *
 * O número NUNCA sai de um contador. `paid_installments + 1` parecia certo e
 * não é: o Stripe não garante ordem de entrega, uma parcela pode falhar e a
 * seguinte ser paga antes, e a baixa manual por fora mexe no cronograma sem
 * passar por aqui. Em qualquer desses casos o contador apontava para a parcela
 * ERRADA — e era ela que recebia a baixa.
 *
 * A ordem de busca é: a parcela já amarrada a esta invoice (gravada no
 * `invoice.finalized`), depois a primeira em aberto do cronograma.
 */
export async function parcelaDaInvoice(
  db: any, plan: any, invoice: { id?: string | null },
): Promise<{ seq: number; status: string } | null> {
  if (!plan.invoice_id) return null

  const { data: amarrada } = await db.from('invoice_installments')
    .select('seq, status').eq('invoice_id', plan.invoice_id)
    .eq('stripe_invoice', String(invoice.id)).order('seq').limit(1)
  if (amarrada?.length) return amarrada[0] as any

  const { data: aberta } = await db.from('invoice_installments')
    .select('seq, status').eq('invoice_id', plan.invoice_id)
    .in('status', ['scheduled', 'failed']).order('seq').limit(1)
  if (aberta?.length) return aberta[0] as any

  console.error('parcelaDaInvoice: cronograma sem parcela em aberto', plan.id, invoice.id)
  return null
}

/**
 * Quantas parcelas estão pagas, CONTADAS no cronograma. Somar +1 a cada evento
 * fazia o número divergir do que realmente foi recebido — e era ele que
 * decidia se o parcelamento tinha terminado.
 */
export async function recontarParcelas(db: any, plan: any): Promise<number> {
  if (!plan.invoice_id) return Number(plan.paid_installments || 0)
  const { count } = await db.from('invoice_installments')
    .select('seq', { count: 'exact', head: true })
    .eq('invoice_id', plan.invoice_id).eq('status', 'paid')
  return count ?? Number(plan.paid_installments || 0)
}
