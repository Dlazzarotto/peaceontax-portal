// lib/stripe-formas.ts — a conta do Stripe manda nas formas de pagamento.
//
// Cartão, débito em conta (ACH) e Klarna só funcionam se estiverem ATIVADOS
// no painel do Stripe (Settings → Payment methods). ACH e Klarna exigem
// habilitação à parte, e cada um pode ser desligado a qualquer momento.
//
// Quando o código pede uma forma que a conta não tem, o Stripe recusa a
// sessão INTEIRA — não é que a opção apareça apagada: o link não nasce. Era
// o que acontecia no cadastro de débito do parcelamento, que sempre pedia
// cartão + ACH: sem ACH ativo, nenhum cliente conseguia pagar a entrada nem
// autorizar as parcelas, e a rota respondia "tente de novo" sem dizer o
// motivo. O cliente não tinha saída e a equipe não tinha diagnóstico.
//
// Aqui a regra é: pede tudo, e o que a conta recusar sai da lista e tenta de
// novo. Cartão é o piso — se nem ele passar, o erro sobe com o motivo real.

import type Stripe from 'stripe'

export const FORMAS_DO_CLIENTE = ['card', 'us_bank_account', 'klarna'] as const

/** Formas que o Stripe reconhece e que este sistema oferece. */
const CONHECIDAS = ['klarna', 'us_bank_account', 'card', 'link', 'affirm', 'afterpay_clearpay', 'cashapp']

const NOME: Record<string, string> = {
  card: 'cartão', us_bank_account: 'débito em conta (ACH)', klarna: 'Klarna',
}

/** Nome legível de uma forma, para a mensagem à equipe. */
export function nomeDaForma(f: string): string {
  return NOME[f] || f
}

/**
 * A mensagem de erro do Stripe diz que alguma forma não está ativada na conta?
 * Devolve qual, ou null se o erro é outro (aí não adianta tentar de novo).
 */
export function formaNaoAtivada(e: any, pedidas: string[]): string | null {
  const msg = String(e?.raw?.message || e?.message || '')
  if (!/payment_method_type|not activated|not available|invalid/i.test(msg)) return null
  // A mensagem cita a forma; procura primeiro entre as que foram pedidas
  for (const f of CONHECIDAS) {
    if (pedidas.includes(f) && msg.includes(f)) return f
  }
  return null
}

/**
 * Cria a sessão com as formas pedidas. Cada forma que a conta recusar sai da
 * lista e a sessão é tentada de novo, até sobrar só o cartão.
 *
 * `montar` recebe as formas que sobraram e devolve os parâmetros da sessão —
 * assim serve para `payment`, `setup` e `subscription` sem duplicar regra.
 */
export async function sessaoComFormasDisponiveis(
  stripe: Stripe,
  formas: string[],
  montar: (formas: string[]) => any,
): Promise<{ session: Stripe.Checkout.Session; formas: string[]; recusadas: string[] }> {
  let tentar = [...formas]
  const recusadas: string[] = []

  // No máximo uma tentativa por forma, mais a inicial
  for (let i = 0; i <= formas.length; i++) {
    try {
      const session = await stripe.checkout.sessions.create(montar(tentar))
      if (recusadas.length) {
        console.error('stripe-formas: conta recusou', recusadas.join(', '), '— sessão criada com', tentar.join(', '))
      }
      return { session, formas: tentar, recusadas }
    } catch (e: any) {
      const fora = formaNaoAtivada(e, tentar)
      if (!fora) throw e          // outro problema: sobe inteiro, sem mascarar
      recusadas.push(fora)
      if (tentar.length <= 1) {
        // Acabaram as formas: o erro tem de dizer o que a conta recusou, senão
        // a equipe recebe o nome da última e acha que é só aquela.
        throw new Error(
          `A conta do Stripe não tem nenhuma forma de pagamento ativada entre as pedidas `
          + `(${recusadas.map(nomeDaForma).join(', ')}). Ative em Settings → Payment methods.`)
      }
      tentar = tentar.filter(f => f !== fora)
    }
  }
  throw new Error('Nenhuma forma de pagamento disponível na conta do Stripe.')
}

/** Aviso à equipe quando alguma forma ficou de fora — vai para a trilha e para a resposta. */
export function avisoDeFormasRecusadas(recusadas: string[]): string {
  if (!recusadas.length) return ''
  const lista = recusadas.map(nomeDaForma).join(' e ')
  return ` ⚠️ ${lista} não está ativado na conta do Stripe (Settings → Payment methods) e ficou de fora deste link.`
}
