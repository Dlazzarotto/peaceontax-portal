// lib/recebimento-stripe.ts — o mesmo pagamento chega por mais de um evento.
//
// Um pagamento feito pelo Checkout gera DOIS eventos: `checkout.session.
// completed` e `payment_intent.succeeded`. O Stripe não garante a ordem. E no
// débito em conta ainda entra um terceiro, `async_payment_succeeded`, quando o
// banco confirma.
//
// Se cada caminho procurasse só pela sua própria chave, o recebimento entraria
// duas vezes: o do intent gravaria pelo intent, o da sessão não acharia nada
// procurando pela sessão, e lançaria de novo. O cliente aparece pagando o
// dobro e a fatura fica com crédito que não existe.
//
// A regra é uma só: procura-se por TODAS as chaves conhecidas do pagamento,
// nas duas colunas onde elas podem ter sido gravadas.

/** Identificador do Stripe (sessão, intent, cobrança) — sem espaço nem vírgula. */
function valido(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_]+$/.test(id)
}

/**
 * Filtro `.or()` do PostgREST que acha o recebimento por qualquer uma das
 * chaves, em `stripe_object` ou em `reference`. Devolve null quando não há
 * chave nenhuma — aí não se procura (e não se grava).
 */
export function filtroDeRecebimento(...ids: (string | null | undefined)[]): string | null {
  const limpos = Array.from(new Set(ids.filter(valido)))
  if (!limpos.length) return null
  return limpos.flatMap(id => [`stripe_object.eq.${id}`, `reference.eq.${id}`]).join(',')
}

/**
 * Lança no livro (invoice_payments) um recebimento que veio do Stripe — UMA
 * vez, procurando por TODAS as chaves do pagamento nas duas colunas.
 *
 * Uma função só para o webhook e para a equipe (agendar o parcelamento que
 * travou): duas cópias da regra divergiriam, e a cópia que procurasse só pela
 * própria chave lançaria o mesmo dinheiro de novo.
 *
 * `recebidoEm` é a hora em que o dinheiro ENTROU — quando o lançamento chega
 * dias depois (o agendamento travado), a data de hoje poria a receita no dia
 * errado do caixa. Não lança erro: devolve o que houve, e quem chama decide.
 */
export async function lancarRecebimentoStripe(db: any, r: {
  invoiceId: string | null | undefined
  clientId: string
  valor: number
  metodo: string
  referencia: string | null | undefined
  objetoStripe: string
  recebidoEm?: Date | null
}): Promise<{ ok: true; lancado: boolean } | { ok: false; motivo: string }> {
  if (!r.invoiceId || !(Number(r.valor) > 0)) return { ok: true, lancado: false }
  const filtro = filtroDeRecebimento(r.objetoStripe, r.referencia)
  if (!filtro) return { ok: false, motivo: 'pagamento sem identificação do Stripe' }
  const { data: ja, error } = await db.from('invoice_payments').select('id').or(filtro).limit(1)
  // Consulta que falha não é "não existe": gravar no escuro é o recebimento em dobro.
  if (error) return { ok: false, motivo: `não deu para conferir se já estava lançado: ${error.message}` }
  if (ja?.length) return { ok: true, lancado: false }
  const { error: errIns } = await db.from('invoice_payments').insert({
    invoice_id: r.invoiceId, client_id: r.clientId, amount: r.valor,
    method: r.metodo, reference: r.referencia || null, stripe_object: r.objetoStripe,
    received_at: (r.recebidoEm || new Date()).toISOString(),
  })
  if (errIns) return { ok: false, motivo: errIns.message }
  return { ok: true, lancado: true }
}
