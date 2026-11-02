// lib/aviso-de-falha.ts — o que a equipe e o cliente leem quando um débito
// automático falha (NSF, cartão recusado).
//
// A mensagem antiga PROMETIA nova tentativa: "O Stripe fará novas tentativas
// automáticas" para a equipe e "Uma nova tentativa será feita
// automaticamente" para o cliente — sem saber se ela existia. No débito em
// conta (ACH) o Stripe NÃO tenta de novo por padrão: só com a opção ligada
// no painel, no máximo 2 vezes em 40 dias e só por falta de fundos. Com a
// promessa falsa, o cliente esperava um débito que não vinha, a equipe
// esperava o Stripe, e a parcela ficava parada sem ninguém agir.
//
// Quem diz se haverá nova tentativa é a própria invoice do evento:
// `next_payment_attempt` (unix, em segundos) é o instante da próxima tentativa
// automática, e vem NULO quando não há nenhuma marcada — tentativas
// esgotadas, ou débito em conta sem a nova tentativa ligada. Campo AUSENTE é
// outra coisa: payload fora do esperado, e aí a mensagem não afirma nada.
// Módulo puro, testável.

import { dataDaFirma } from './dia-da-firma.ts'
import { fmtUS, money } from './format.ts'

const TELEFONE = '(833) 732-2327'

export type NovaTentativa = 'agendada' | 'nenhuma' | 'desconhecida'

/** Lê `next_payment_attempt` como o Stripe o manda. */
export function novaTentativa(
  proxima: unknown, agora: Date = new Date(),
): { situacao: NovaTentativa; data: string | null } {
  if (proxima === null) return { situacao: 'nenhuma', data: null }
  const n = typeof proxima === 'number' ? proxima : NaN
  if (!Number.isFinite(n) || n <= 0) return { situacao: 'desconhecida', data: null }
  // Instante já passado (evento atrasado): a tentativa é "agora", não ontem.
  const quando = new Date(Math.max(n * 1000, agora.getTime()))
  return { situacao: 'agendada', data: dataDaFirma(quando) }
}

export function mensagensDaFalha(args: {
  /** Valor da cobrança, em dólar. */
  valor: number
  /** Nome do cliente — só na mensagem da equipe. */
  cliente: string
  /** O que falhou: "parcela 2/6" ou "mensalidade: Bookkeeping". */
  oQue: string
  /** Motivo da recusa — só na mensagem da equipe. */
  motivo: string
  /** `invoice.next_payment_attempt` exatamente como veio (número, null ou ausente). */
  proximaTentativa: unknown
  /** `invoice.attempt_count`. */
  tentativasFeitas?: unknown
  agora?: Date
}): { equipe: string; cliente: string; situacao: NovaTentativa; dataDaTentativa: string | null } {
  const { situacao, data } = novaTentativa(args.proximaTentativa, args.agora)
  const feitas = Number(args.tentativasFeitas)
  const valor = money(args.valor)
  const cabeca = `⚠️ Débito de ${valor} de ${args.cliente} FALHOU (${args.oQue}): ${args.motivo || 'recusado pelo banco'}.`
  const jaFeitas = Number.isFinite(feitas) && feitas > 0 ? ` Tentativas feitas: ${feitas}.` : ''

  if (situacao === 'agendada') {
    return {
      situacao, dataDaTentativa: data,
      equipe: `${cabeca}${jaFeitas} O Stripe tenta de novo em ${fmtUS(data)}. Se falhar outra vez, fale com o cliente.`,
      cliente: `⚠️ Não conseguimos processar seu pagamento de ${valor}. Vamos tentar de novo automaticamente em ${fmtUS(data)} — deixe o valor disponível na conta. Dúvidas: ${TELEFONE}.`,
    }
  }
  if (situacao === 'nenhuma') {
    return {
      situacao, dataDaTentativa: null,
      equipe: `${cabeca}${jaFeitas} O Stripe NÃO vai tentar de novo. Fale com o cliente: use "Cobrar de novo", receba por fora (Zelle, cheque) ou peça outro cartão ou conta.`,
      cliente: `⚠️ Não conseguimos processar seu pagamento de ${valor}, e não haverá nova tentativa automática. Para regularizar, fale conosco: ${TELEFONE}.`,
    }
  }
  return {
    situacao, dataDaTentativa: null,
    equipe: `${cabeca}${jaFeitas} Não deu para saber se o Stripe vai tentar de novo (a invoice veio sem a próxima tentativa): confira no painel do Stripe antes de prometer qualquer coisa ao cliente.`,
    cliente: `⚠️ Não conseguimos processar seu pagamento de ${valor}. Para regularizar, fale conosco: ${TELEFONE}.`,
  }
}
