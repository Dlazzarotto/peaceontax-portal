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
// do Stripe no `invoice.created` (ou no `invoice.finalized`, o que vier antes).
//
// A AMARRAÇÃO É POR PERÍODO (decisão do sócio, 11/2026): cada cobrança do
// agendamento vai para a parcela de MENOR número que ainda não tem cobrança —
// esteja ela em aberto ou já PAGA POR FORA. Antes, a parcela paga por fora era
// pulada: o débito daquele mês caía na parcela seguinte e só a última deixava
// de ser cobrada — o cliente que pagava em Zelle era debitado no mesmo mês.
// Agora a cobrança do mês da parcela paga encontra a parcela paga, e o webhook
// a zera (abatimento no rascunho) ou a anula (rede de segurança no finalized).
// Quem fica de fora da amarração: parcela cancelada, e a paga ANTES de existir
// o agendamento (`PAGA_ANTES_DO_AGENDAMENTO`, gravada pelo "Conferir pagamento
// e agendar", que agenda só as parcelas em aberto).

/** Situações que recebem a cobrança do período: em aberto ou paga por fora. */
export const STATUS_AMARRAVEIS = ['scheduled', 'failed', 'paid'] as const

/**
 * Marca, em `stripe_invoice`, a parcela paga por fora ANTES de o agendamento
 * existir: o agendamento feito depois cobra só as em aberto, e ela não pode
 * receber cobrança de período nenhum. Nunca é id de invoice do Stripe.
 */
export const PAGA_ANTES_DO_AGENDAMENTO = 'paga-antes-do-agendamento'

/**
 * Qual parcela do cronograma esta invoice do Stripe representa.
 *
 * O número NUNCA sai de um contador. `paid_installments + 1` parecia certo e
 * não é: o Stripe não garante ordem de entrega, uma parcela pode falhar e a
 * seguinte ser paga antes, e a baixa manual por fora mexe no cronograma sem
 * passar por aqui. Em qualquer desses casos o contador apontava para a parcela
 * ERRADA — e era ela que recebia a baixa.
 *
 * A ordem de busca é: a parcela já amarrada a esta invoice, depois a de menor
 * número ainda sem cobrança — em aberto ou paga por fora, a mesma regra da
 * amarração. Parcela PAGA devolvida aqui quer dizer que o Stripe cobrou um
 * período cuja parcela já estava quitada: quem chama trata como cobrado a mais
 * (no pago) e não marca falha (no falhou).
 */
export async function parcelaDaInvoice(
  db: any, plan: any, invoice: { id?: string | null },
): Promise<ParcelaDaCobranca | null> {
  if (!plan.invoice_id) return null

  // Leitura que falha LANÇA: o webhook responde 500 e o Stripe reenvia. Devolver
  // null aqui era dizer "não há parcela" — e, no invoice.paid, isso deixava o
  // pagamento sem lançamento e mandava a equipe REEMBOLSAR uma parcela legítima
  // (alerta de cobrado a mais).
  const { data: amarrada, error: erroAmarrada } = await db.from('invoice_installments')
    .select('seq, status, amount, stripe_invoice, stripe_intent').eq('invoice_id', plan.invoice_id)
    .eq('stripe_invoice', String(invoice.id)).order('seq').limit(1)
  if (erroAmarrada) throw new Error(`parcelaDaInvoice: falhou ao ler a parcela desta cobrança: ${erroAmarrada.message}`)
  if (amarrada?.length) return comValor(amarrada[0])

  const { data: livre, error: erroLivre } = await db.from('invoice_installments')
    .select('seq, status, amount, stripe_invoice, stripe_intent').eq('invoice_id', plan.invoice_id)
    .in('status', STATUS_AMARRAVEIS as unknown as string[]).is('stripe_invoice', null)
    .order('seq').limit(1)
  if (erroLivre) throw new Error(`parcelaDaInvoice: falhou ao ler o cronograma: ${erroLivre.message}`)
  if (livre?.length) return comValor(livre[0])

  console.error('parcelaDaInvoice: cronograma sem parcela para esta cobrança', plan.id, invoice.id)
  return null
}

export interface ParcelaDaCobranca {
  seq: number
  status: string
  amount: number
  stripeInvoice: string | null
  stripeIntent: string | null
}

const comValor = (l: any): ParcelaDaCobranca => ({
  seq: Number(l.seq), status: String(l.status), amount: Number(l.amount),
  /** A cobrança amarrada e o pagamento que a quitou: dizem se foi ESTA cobrança que pagou a parcela. */
  stripeInvoice: (l.stripe_invoice ?? null) as string | null,
  stripeIntent: (l.stripe_intent ?? null) as string | null,
})

export type DestinoDaCobranca =
  | { acao: 'ja_amarrada'; seq: number }
  | { acao: 'amarrada'; seq: number }
  | { acao: 'sem_parcela' }

/**
 * Amarra a invoice que o Stripe acabou de criar (`invoice.created`, ou
 * `invoice.finalized`) à parcela do período dela: a de menor número que ainda
 * não tem cobrança, em aberto ou paga por fora (`STATUS_AMARRAVEIS`).
 * `sem_parcela` — todas as parcelas já têm cobrança — é uma cobrança que
 * SOBROU, e é a única resposta que autoriza o webhook a anulá-la. Por isso ela
 * só sai depois de três cuidados:
 *
 *  1. IDEMPOTENTE. O Stripe entrega cada evento pelo menos uma vez, e o
 *     `invoice.paid` pode chegar antes do `invoice.finalized` (ele amarra a
 *     parcela ao pagar). Sem conferir "já há parcela com ESTA invoice", a
 *     segunda entrega amarrava a parcela seguinte — e, na última, não achava
 *     nenhuma em aberto e ANULAVA a cobrança legítima.
 *  2. LEITURA QUE FALHA LANÇA. Consulta com erro não é "nenhuma parcela": o
 *     webhook responde 500 e o Stripe reenvia. Antes, um tropeço do banco
 *     virava anulação.
 *  3. A AMARRAÇÃO É CONDICIONAL (`stripe_invoice is null`) e, antes de dizer
 *     `sem_parcela`, confere de novo se outra entrega simultânea amarrou esta
 *     mesma invoice entre as duas leituras.
 *
 * `faturaId` é a fatura do parcelamento (`payment_plans.invoice_id`);
 * `stripeInvoice`, o id da invoice do Stripe.
 */
export async function amarrarCobrancaAParcela(
  db: any, faturaId: string, stripeInvoice: string,
): Promise<DestinoDaCobranca> {
  const jaAmarrada = async (): Promise<number | null> => {
    const { data, error } = await db.from('invoice_installments')
      .select('seq').eq('invoice_id', faturaId).eq('stripe_invoice', stripeInvoice)
      .order('seq').limit(1)
    if (error) throw new Error(`amarrarCobrancaAParcela: falhou ao ler a parcela desta cobrança: ${error.message}`)
    return data?.length ? Number(data[0].seq) : null
  }

  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const antes = await jaAmarrada()
    if (antes != null) return { acao: 'ja_amarrada', seq: antes }

    const { data: aberta, error: erroAberta } = await db.from('invoice_installments')
      .select('seq').eq('invoice_id', faturaId)
      .in('status', STATUS_AMARRAVEIS as unknown as string[]).is('stripe_invoice', null)
      .order('seq').limit(1)
    if (erroAberta) throw new Error(`amarrarCobrancaAParcela: falhou ao ler o cronograma: ${erroAberta.message}`)

    if (!aberta?.length) {
      // Outra entrega do mesmo evento pode ter amarrado ENTRE as duas leituras.
      const depois = await jaAmarrada()
      return depois != null ? { acao: 'ja_amarrada', seq: depois } : { acao: 'sem_parcela' }
    }

    const seq = Number(aberta[0].seq)
    const { data: feita, error: erroUpdate } = await db.from('invoice_installments')
      .update({ stripe_invoice: stripeInvoice })
      .eq('invoice_id', faturaId).eq('seq', seq).is('stripe_invoice', null)
      .select('seq')
    if (erroUpdate) throw new Error(`amarrarCobrancaAParcela: falhou ao amarrar a parcela ${seq}: ${erroUpdate.message}`)
    if (feita?.length) return { acao: 'amarrada', seq }
    // Outra cobrança levou esta parcela no meio do caminho: lê tudo de novo.
  }
  throw new Error('amarrarCobrancaAParcela: a parcela mudou de mão três vezes seguidas; o Stripe reenvia o evento')
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
