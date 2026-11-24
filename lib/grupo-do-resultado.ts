// lib/grupo-do-resultado.ts — o que entra no P&L, em que seção, e a conta dele.
//
// O P&L é o RESULTADO do período: receita, custo, despesa e os "outros" dos
// dois lados. O que é de BALANÇO — ativo, passivo, e o que o plano de contas
// marca como fora do resultado — não entra nele, nem como seção informativa
// (decisão do sócio, 11/2026). A rota mostrava, no fim do demonstrativo,
// "Balance Sheet / Non-P&L Items (informational)" com transferências entre
// contas, pagamentos de cartão, empréstimos e retiradas: dinheiro que mudou
// de lugar, não resultado. Quem quer ver saldo de conta abre o Balanço.
//
// Três regras que a leitura direta do plano não dá:
//  1. Os movimentos que o MOTOR grava pelo nome — transferência entre contas
//     do cliente, pagamento de cartão e a saída da conta de passagem do caixa
//     (CONTAS_DO_SISTEMA em lib/plano-de-contas.ts) — ficam fora SEMPRE,
//     mesmo que a conta falte no plano ou esteja com o grupo errado. Conta
//     fora do plano cai em despesa (regra 3), e era por aí que uma
//     transferência viraria DESPESA no P&L — o erro que mais distorce o
//     resultado, porque o mesmo dinheiro sai de uma conta e entra na outra.
//  2. Sub-conta ("Mãe: Filha") que falte no plano segue o grupo da MÃE: o
//     plano exige que a filha seja do mesmo grupo (lib/plano-de-contas.ts).
//  3. Conta fora do plano, que não é movimento do motor, entra como DESPESA,
//     como sempre entrou: aparecer no lugar errado se vê e se corrige; sumir
//     do demonstrativo não se vê.
//
// A soma é em CENTAVOS: em ponto flutuante, milhares de lançamentos deixam
// resto de 0,01 no total — e total que não fecha com as linhas é o primeiro
// sinal de erro que se procura num P&L.

import { CONTA_DO_DEPOSITO } from './deposito-match.ts'

export const GRUPOS_DO_RESULTADO = ['income', 'cogs', 'expense', 'other_income', 'other_expense'] as const
export type GrupoDoResultado = (typeof GRUPOS_DO_RESULTADO)[number]

/** Movimentos de balanço que o motor e o caixa gravam PELO NOME. */
export const MOVIMENTOS_DE_BALANCO: readonly string[] = ['Transfer', 'Credit Card Payment', CONTA_DO_DEPOSITO]

/** Lançamento aprovado sem conta: o P&L sempre o mostrou como "Other". */
export const CONTA_SEM_NOME = 'Other'

const ehDoResultado = (g: unknown): g is GrupoDoResultado =>
  typeof g === 'string' && (GRUPOS_DO_RESULTADO as readonly string[]).includes(g)

const tem = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** "Mãe: Filha" → "Mãe"; conta sem mãe → null. */
function maeDe(conta: string): string | null {
  const i = conta.indexOf(':')
  return i > 0 ? conta.slice(0, i).trim() : null
}

/**
 * A seção do P&L em que a conta entra, ou null quando ela é de balanço.
 * `grupoNoPlano` é o mapa nome → grupo (`bookkeeping_categories.kind`).
 */
export function grupoNoResultado(
  conta: string,
  grupoNoPlano: Readonly<Record<string, string | null | undefined>>,
): GrupoDoResultado | null {
  const nome = String(conta ?? '')
  const mae = maeDe(nome)
  if (MOVIMENTOS_DE_BALANCO.includes(nome.trim()) || (mae !== null && MOVIMENTOS_DE_BALANCO.includes(mae))) return null
  const grupo = tem(grupoNoPlano, nome) ? grupoNoPlano[nome]
    : mae !== null && tem(grupoNoPlano, mae) ? grupoNoPlano[mae]
    : undefined
  if (grupo === undefined || grupo === null || grupo === '') return 'expense'
  return ehDoResultado(grupo) ? grupo : null
}

const centavos = (v: unknown) => Math.round(Number(v) * 100)

/** Soma por conta, em centavos e devolvida em dólar. Conta vazia vira "Other". */
export function somarPorConta(linhas: readonly { category?: string | null; amount: number | string }[]): Record<string, number> {
  const c: Record<string, number> = {}
  for (const l of linhas) {
    const v = centavos(l.amount)
    if (!Number.isFinite(v)) continue
    const k = l.category || CONTA_SEM_NOME
    c[k] = (c[k] || 0) + v
  }
  const r: Record<string, number> = {}
  for (const [k, v] of Object.entries(c)) r[k] = v / 100
  return r
}

export interface LinhaDoResultado { conta: string; valor: number }
export type SecoesDoResultado = Record<GrupoDoResultado, LinhaDoResultado[]>

/** As cinco seções do P&L, em ordem alfabética; o que é de balanço fica de fora. */
export function secoesDoResultado(
  porConta: Readonly<Record<string, number>>,
  grupoNoPlano: Readonly<Record<string, string | null | undefined>>,
): SecoesDoResultado {
  const s: SecoesDoResultado = { income: [], cogs: [], expense: [], other_income: [], other_expense: [] }
  for (const [conta, valor] of Object.entries(porConta)) {
    const g = grupoNoResultado(conta, grupoNoPlano)
    if (g) s[g].push({ conta, valor })
  }
  for (const g of GRUPOS_DO_RESULTADO) s[g].sort((a, b) => a.conta.localeCompare(b.conta, undefined, { sensitivity: 'base' }))
  return s
}

/**
 * Os totais do demonstrativo. Os valores têm sinal (receita positiva, despesa
 * negativa), como no extrato: o lucro é a SOMA, não receita menos despesa.
 */
export function totaisDoResultado(s: SecoesDoResultado) {
  const soma = (g: GrupoDoResultado) => s[g].reduce((t, l) => t + centavos(l.valor), 0)
  const receita = soma('income'), custo = soma('cogs'), despesa = soma('expense')
  const outrasReceitas = soma('other_income'), outrasDespesas = soma('other_expense')
  const bruto = receita + custo
  const operacional = bruto + despesa
  const liquido = operacional + outrasReceitas + outrasDespesas
  const d = (v: number) => v / 100
  return {
    receita: d(receita), custo: d(custo), bruto: d(bruto), despesa: d(despesa), operacional: d(operacional),
    outrasReceitas: d(outrasReceitas), outrasDespesas: d(outrasDespesas), liquido: d(liquido),
  }
}
