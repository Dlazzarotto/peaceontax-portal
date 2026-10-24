// lib/relatorio-1099.ts — quem entra na lista do 1099, e por quanto.
//
// A lista fixa no código (Contract Labor e Subcontractors) virou uma MARCA em
// cada conta de despesa do plano de contas (`bookkeeping_categories.form_1099`,
// migração sql/plano-de-contas-1099-v1.sql). Quem decide quais contas vão para
// o 1099 é o sócio, num botão da tela Plano de contas, e TODA despesa paga
// numa conta marcada entra na apuração. O plano de contas é um só para a
// carteira inteira, então a marca vale para todos os clientes.
//
// Três regras que a lista antiga não tinha. São de lei, não de gosto:
//
//  1. O LIMITE MUDA COM O ANO. Até o ano-calendário de 2025, US$ 600 por
//     prestador e por formulário. Para pagamentos a partir de 1º de janeiro
//     de 2026, US$ 2.000 (One Big Beautiful Bill Act, julho de 2025), com
//     correção pela inflação a partir de 2027. Quando o IRS publicar o valor
//     corrigido, ele entra em LIMITES; até lá vale o último da tabela.
//
//  2. PAGAMENTO POR CARTÃO OU POR PLATAFORMA NÃO VAI NO 1099-NEC/MISC. Quem
//     informa é a processadora, no 1099-K (instruções do 1099-NEC). Despesa
//     paga numa conta de cartão de crédito do cliente, ou por PayPal, Venmo ou
//     Cash App, aparece no relatório à parte e fica fora do total. Zelle NÃO é
//     plataforma para esse fim: pagamento por Zelle continua no 1099.
//
//  3. O MESMO PRESTADOR COM GRAFIA DIFERENTE É UM SÓ. "JOHN SMITH" e
//     "John Smith." somados em separado deixam cada metade abaixo do limite, e
//     o 1099 não sai. A chave é a mesma do cadastro de clientes
//     (`chaveDoNome`), e o relatório mostra a grafia mais usada.
//
// Puro, sem banco: a rota lê, este módulo decide. Testado em
// testes/relatorio-1099.mts. Trabalha em CENTAVOS para não acumular erro de
// ponto flutuante numa soma de centenas de pagamentos.

import { chaveDoNome } from './import-clientes.ts'

export const FORMULARIOS_1099 = ['NEC', 'MISC'] as const
export type Formulario1099 = (typeof FORMULARIOS_1099)[number]

/** Grupos do plano de contas em que o botão do 1099 aparece. */
export const GRUPOS_DE_DESPESA = ['expense', 'cogs', 'other_expense'] as const

export function ehContaDeDespesa(kind: unknown): boolean {
  return (GRUPOS_DE_DESPESA as readonly string[]).includes(String(kind ?? ''))
}

/**
 * O formulário pedido para uma conta: 'NEC', 'MISC' ou null (fora do 1099).
 * Devolve undefined quando o valor não é nenhum dos três, para a rota recusar
 * em vez de gravar lixo.
 */
export function formularioDoPedido(v: unknown): Formulario1099 | null | undefined {
  if (v === null || v === '' || v === false) return null
  if (v === undefined) return undefined
  const s = String(v).trim().toUpperCase()
  return (FORMULARIOS_1099 as readonly string[]).includes(s) ? (s as Formulario1099) : undefined
}

/** Limite por prestador e por formulário, do ano mais novo para o mais antigo. */
export const LIMITES: { desde: number; valor: number }[] = [
  { desde: 2026, valor: 2000 },
  { desde: 0, valor: 600 },
]

export function limiteDo1099(ano: number): number {
  for (const l of LIMITES) if (ano >= l.desde) return l.valor
  return LIMITES[LIMITES.length - 1].valor
}

/** PayPal, Venmo e Cash App informam no 1099-K. Zelle não. */
export const PLATAFORMA_1099K = /\b(paypal|venmo|cash\s?app)\b/i

export interface Lancamento1099 {
  payee: string | null
  category: string | null
  amount: number | string
  account_id?: string | null
  description?: string | null
}

export interface Linha1099 {
  /** A grafia mais usada do prestador. */
  prestador: string
  formulario: Formulario1099
  /** Saídas pelo banco, em dólar. */
  pago: number
  /** Entradas do mesmo prestador nas contas do 1099 (reembolso). */
  devolvido: number
  /** pago − devolvido, nunca negativo. É o que se compara com o limite. */
  total: number
  /** Pago no cartão de crédito: fora do NEC/MISC, vai no 1099-K. */
  porCartao: number
  /** Pago por PayPal, Venmo ou Cash App: idem. */
  porPlataforma: number
  /** Quantas saídas pelo banco. */
  pagamentos: number
  /** As contas do 1099 em que o prestador apareceu. */
  contas: string[]
  candidato: boolean
}

export interface Apuracao1099 {
  ano: number
  limite: number
  candidatos: Linha1099[]
  abaixoDoLimite: Linha1099[]
  /** Saídas pelo banco em conta do 1099 sem prestador identificado. */
  semPrestador: { total: number; lancamentos: number }
  /** O que ficou fora do formulário, somado na carteira daquele cliente. */
  foraDoFormulario: { cartao: number; plataforma: number }
}

const centavos = (v: unknown) => Math.round(Number(v) * 100)
const dolares = (c: number) => Math.round(c) / 100

export function apurar1099(p: {
  lancamentos: Lancamento1099[]
  /** Nome da conta do plano → formulário. Conta ausente não entra. */
  formularioDaConta: Record<string, Formulario1099>
  /** Contas bancárias do cliente que são cartão de crédito. */
  contasDeCartao: Iterable<string>
  ano: number
}): Apuracao1099 {
  const cartoes = new Set(p.contasDeCartao)
  type Grupo = {
    formulario: Formulario1099; pago: number; devolvido: number; porCartao: number
    porPlataforma: number; pagamentos: number; contas: Set<string>; grafias: Map<string, number>
  }
  const grupos = new Map<string, Grupo>()
  let semTotal = 0, semLancamentos = 0, foraCartao = 0, foraPlataforma = 0

  for (const l of p.lancamentos || []) {
    const formulario = l.category ? p.formularioDaConta[l.category] : undefined
    if (!formulario) continue
    const valor = centavos(l.amount)
    if (!Number.isFinite(valor) || valor === 0) continue
    const viaCartao = !!l.account_id && cartoes.has(l.account_id)
    const viaPlataforma = !viaCartao &&
      (PLATAFORMA_1099K.test(String(l.description || '')) || PLATAFORMA_1099K.test(String(l.payee || '')))

    const nome = String(l.payee || '').trim()
    if (!nome) {
      if (viaCartao) foraCartao -= valor
      else if (viaPlataforma) foraPlataforma -= valor
      else if (valor < 0) { semTotal -= valor; semLancamentos++ }
      continue
    }

    const chave = `${formulario}|${chaveDoNome(nome)}`
    let g = grupos.get(chave)
    if (!g) {
      g = { formulario, pago: 0, devolvido: 0, porCartao: 0, porPlataforma: 0, pagamentos: 0,
            contas: new Set(), grafias: new Map() }
      grupos.set(chave, g)
    }
    g.grafias.set(nome, (g.grafias.get(nome) || 0) + 1)
    g.contas.add(l.category as string)

    if (viaCartao) { g.porCartao -= valor; foraCartao -= valor; continue }
    if (viaPlataforma) { g.porPlataforma -= valor; foraPlataforma -= valor; continue }
    if (valor < 0) { g.pago -= valor; g.pagamentos++ } else g.devolvido += valor
  }

  const limite = limiteDo1099(p.ano)
  const limiteC = limite * 100
  const linhas: Linha1099[] = []
  for (const g of Array.from(grupos.values())) {
    let prestador = '', maior = -1
    for (const [grafia, n] of Array.from(g.grafias.entries())) if (n > maior) { prestador = grafia; maior = n }
    const total = Math.max(0, g.pago - g.devolvido)
    linhas.push({
      prestador, formulario: g.formulario,
      pago: dolares(g.pago), devolvido: dolares(g.devolvido), total: dolares(total),
      porCartao: dolares(Math.max(0, g.porCartao)), porPlataforma: dolares(Math.max(0, g.porPlataforma)),
      pagamentos: g.pagamentos, contas: Array.from(g.contas).sort(),
      candidato: total >= limiteC,
    })
  }
  const ordem = (a: Linha1099, b: Linha1099) =>
    b.total - a.total || a.prestador.localeCompare(b.prestador, undefined, { sensitivity: 'base' })

  return {
    ano: p.ano, limite,
    candidatos: linhas.filter(l => l.candidato).sort(ordem),
    abaixoDoLimite: linhas.filter(l => !l.candidato && l.total > 0).sort(ordem),
    semPrestador: { total: dolares(semTotal), lancamentos: semLancamentos },
    foraDoFormulario: { cartao: dolares(Math.max(0, foraCartao)), plataforma: dolares(Math.max(0, foraPlataforma)) },
  }
}
