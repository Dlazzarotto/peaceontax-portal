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
