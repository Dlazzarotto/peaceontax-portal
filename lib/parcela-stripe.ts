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

  // Leitura que falha LANÇA: o webhook responde 500 e o Stripe reenvia. Devolver
  // null aqui era dizer "não há parcela" — e, no invoice.paid, isso deixava o
  // pagamento sem lançamento e mandava a equipe REEMBOLSAR uma parcela legítima
  // (alerta de cobrado a mais).
  const { data: amarrada, error: erroAmarrada } = await db.from('invoice_installments')
    .select('seq, status').eq('invoice_id', plan.invoice_id)
    .eq('stripe_invoice', String(invoice.id)).order('seq').limit(1)
  if (erroAmarrada) throw new Error(`parcelaDaInvoice: falhou ao ler a parcela desta cobrança: ${erroAmarrada.message}`)
  if (amarrada?.length) return amarrada[0] as any

  const { data: aberta, error: erroAberta } = await db.from('invoice_installments')
    .select('seq, status').eq('invoice_id', plan.invoice_id)
    .in('status', ['scheduled', 'failed']).order('seq').limit(1)
  if (erroAberta) throw new Error(`parcelaDaInvoice: falhou ao ler o cronograma: ${erroAberta.message}`)
  if (aberta?.length) return aberta[0] as any

  console.error('parcelaDaInvoice: cronograma sem parcela em aberto', plan.id, invoice.id)
  return null
}

export type DestinoDaCobranca =
  | { acao: 'ja_amarrada'; seq: number }
  | { acao: 'amarrada'; seq: number }
  | { acao: 'sem_parcela' }

/**
 * Amarra a invoice que o Stripe acabou de emitir (`invoice.finalized`) à
 * parcela que ela cobra: a primeira em aberto do cronograma que ainda não tem
 * cobrança. `sem_parcela` é a ÚNICA resposta que autoriza o webhook a anular a
 * invoice (a régua sobrou uma cobrança porque alguma parcela foi paga por
 * fora) — e por isso ela só sai depois de três cuidados:
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
      .in('status', ['scheduled', 'failed']).is('stripe_invoice', null)
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
