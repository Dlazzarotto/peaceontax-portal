// Conciliação de DEPÓSITO: o que entrou no banco × os recebimentos que o
// compõem. Módulo puro — a conta é dinheiro com arredondamento.
//
// O DESENHO (decidido com o sócio)
// A contabilidade fiscal da firma é por REGIME DE CAIXA e a despesa vem
// direto do extrato. A receita não vem: ela nasce no RECEBIMENTO da fatura
// (cheque, Zelle, espécie, cartão/ACH pelo Stripe) e fica numa conta de
// passagem — "Recebimentos a depositar", o Undeposited Funds do QuickBooks.
// O depósito no banco apenas ESVAZIA essa conta.
//
// POR QUE NÃO LER A RECEITA DO EXTRATO
// Porque na mesma conta caem duas coisas diferentes: o depósito de cheque e
// Zelle (um a um) e o REPASSE do Stripe, que junta vários pagamentos e chega
// LÍQUIDO da taxa. Lendo só o extrato, a receita bruta nunca fecha — e é a
// bruta que o Stripe informa ao IRS no 1099-K. Aqui o repasse de $970 vira
// $1.000 de receita (que já entrou no recebimento) e $30 de taxa, despesa
// dedutível.
//
// A CONTA DE PASSAGEM FECHA EM ZERO, e é isso que prova a conciliação:
//   + recebimentos (bruto)   − taxa   − transferência para o banco  =  0
//
// O que NÃO se faz aqui: absorver diferença em silêncio. Depósito MAIOR que
// os recebimentos escolhidos é dinheiro que entrou sem recebimento lançado —
// não é taxa negativa, é fatura recebida e não registrada.

/** Um centavo é a menor unidade; abaixo disso é ruído de ponto flutuante. */
export const TOLERANCIA = 0.005

/** Acima disto a "taxa" provavelmente é seleção errada, não taxa. */
export const TAXA_SUSPEITA = 0.10   // 10% do bruto

export const round2 = (n: number) => Math.round(n * 100) / 100

export interface Recebimento {
  id: string
  amount: number
}

export type SituacaoDoDeposito = 'exato' | 'taxa' | 'falta_recebimento' | 'sem_selecao'

export interface ConferenciaDoDeposito {
  soma: number
  diferenca: number          // bruto − depósito. Positivo = taxa retida.
  situacao: SituacaoDoDeposito
  alerta: string | null
  mensagem: string
  podeConciliar: boolean
}

/**
 * Confere um depósito contra os recebimentos escolhidos.
 *
 * O sinal importa: `diferenca > 0` é taxa (o banco recebeu MENOS que o bruto);
 * `diferenca < 0` é recebimento faltando (entrou mais do que se sabe explicar).
 */
export function conferirDeposito(
  deposito: number,
  recebimentos: Recebimento[]
): ConferenciaDoDeposito {
  const soma = round2((recebimentos || []).reduce((s, r) => s + Number(r.amount || 0), 0))
  const dep = round2(Number(deposito) || 0)
  const diferenca = round2(soma - dep)

  if (!recebimentos || recebimentos.length === 0) {
    return {
      soma: 0, diferenca: round2(-dep), situacao: 'sem_selecao', alerta: null,
      mensagem: 'Escolha os recebimentos que compõem este depósito.',
      podeConciliar: false,
    }
  }

  if (Math.abs(diferenca) < TOLERANCIA) {
    return {
      soma, diferenca: 0, situacao: 'exato', alerta: null,
      mensagem: 'Fecha exato.', podeConciliar: true,
    }
  }

  if (diferenca < 0) {
    return {
      soma, diferenca, situacao: 'falta_recebimento', alerta: null,
      mensagem: `Entraram ${dinheiro(dep)} e os recebimentos escolhidos somam ${dinheiro(soma)}. ` +
        `Faltam ${dinheiro(-diferenca)} — há pagamento neste depósito que não está lançado em nenhuma fatura. ` +
        'Lance o recebimento antes de conciliar; depósito não vira receita sozinho.',
      podeConciliar: false,
    }
  }

  const alerta = diferenca > soma * TAXA_SUSPEITA
    ? `A retenção de ${dinheiro(diferenca)} é ${(diferenca / soma * 100).toFixed(1)}% do bruto — ` +
      'taxa de cartão fica perto de 3%. Confira se não falta recebimento nesta seleção.'
    : null

  return {
    soma, diferenca, situacao: 'taxa', alerta,
    mensagem: `Bruto ${dinheiro(soma)} − taxa ${dinheiro(diferenca)} = ${dinheiro(dep)} no banco.`,
    podeConciliar: true,
  }
}

/**
 * As linhas que a conciliação grava na conta de passagem.
 *
 * Duas, no máximo: a transferência para o banco (não é despesa — `non_pnl`) e
 * a taxa (despesa dedutível). Somadas aos recebimentos, a conta zera; é essa
 * soma que `conferencia` devolve, e o teste a exige em ZERO.
 */
export function linhasDoDeposito(
  deposito: number,
  recebimentos: Recebimento[],
  contaDaTaxa = 'Taxas de processamento'
): {
  transferencia: { amount: number; category: string }
  taxa: { amount: number; category: string } | null
  conferencia: number
} {
  const soma = round2((recebimentos || []).reduce((s, r) => s + Number(r.amount || 0), 0))
  const dep = round2(Number(deposito) || 0)
  const diferenca = round2(soma - dep)
  const taxa = diferenca > TOLERANCIA ? { amount: round2(-diferenca), category: contaDaTaxa } : null
  return {
    transferencia: { amount: round2(-dep), category: CONTA_DO_DEPOSITO },
    taxa,
    conferencia: round2(soma + round2(-dep) + (taxa ? taxa.amount : 0)),
  }
}

/** Contas contábeis que esta rotina usa. Nomes fixos: a migração os cria. */
export const CONTA_DO_RECEBIMENTO = 'Receita de serviços'
export const CONTA_DA_TAXA        = 'Taxas de processamento'
export const CONTA_DO_DEPOSITO    = 'Depósito de recebimentos'

/** Nome da conta de passagem no plano de contas bancárias da firma. */
export const CONTA_DE_PASSAGEM = 'Recebimentos a depositar'

function dinheiro(v: number): string {
  return `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Casa um repasse do Stripe com os recebimentos lançados.
 *
 * O repasse traz os ids das cobranças (`ch_…`) e das intenções (`pi_…`); o
 * recebimento guarda o que o webhook viu (`stripe_object` e `reference`, que
 * podem ser sessão `cs_…`, intenção ou cobrança). Casa por QUALQUER um dos
 * dois lados — olhar só uma coluna já deixou recebimento passar batido.
 *
 * O que sobra dos dois lados é o que interessa: cobrança do repasse sem
 * recebimento lançado (fatura paga que ninguém baixou) e recebimento sem
 * cobrança no repasse (foi cheque, ou está em outro repasse).
 */
export function casarRepasse(
  chavesDoRepasse: string[],
  recebimentos: { id: string; stripe_object?: string | null; reference?: string | null }[]
): { casados: string[]; semRecebimento: string[]; naoCasados: string[] } {
  const doRepasse = new Set((chavesDoRepasse || []).filter(Boolean).map(String))
  const casados: string[] = []
  const naoCasados: string[] = []
  const usadas = new Set<string>()

  for (const r of recebimentos || []) {
    const chaves = [r.stripe_object, r.reference].filter(Boolean).map(String)
    const achou = chaves.find(c => doRepasse.has(c))
    if (achou) { casados.push(r.id); usadas.add(achou) }
    else naoCasados.push(r.id)
  }
  return {
    casados,
    semRecebimento: Array.from(doRepasse).filter(c => !usadas.has(c)),
    naoCasados,
  }
}
