// lib/balanco.ts — o Balanço Patrimonial (cash basis), por partidas dobradas.
//
// O Balanço anterior era "simplificado" e não fechava, porque não era um
// balanço: o caixa era o saldo corrido do último extrato (conta do Plaid,
// que não traz saldo corrido, nem aparecia), o ativo somava só as compras do
// ANO e em valor absoluto (vender o equipamento AUMENTAVA o ativo), o
// empréstimo ficava fora do passivo e não havia patrimônio — no lugar dele,
// "Assets − Liabilities". Não dava para pôr no formato do QuickBooks, que
// termina em TOTAL LIABILITIES AND EQUITY = TOTAL ASSETS.
//
// Aqui cada lançamento tem as duas pernas: a conta bancária (ou o cartão)
// em que o dinheiro passou e a conta do plano em que ele foi classificado.
//   · Caixa de cada conta = saldo de abertura + todos os lançamentos até a
//     data (qualquer situação, menos o excluído): é o que o BANCO mostra.
//   · Cartão = a mesma conta, com o sinal trocado (dívida positiva).
//   · Conta de ativo do plano: o que saiu do banco para ela (-valor),
//     acumulado desde o começo — não só no ano.
//   · Conta de passivo do plano: o que entrou dela (+valor), acumulado. Pagar
//     o empréstimo DIMINUI a dívida; sem o saldo inicial do empréstimo
//     lançado, ela fica negativa — exatamente como o QuickBooks mostra.
//   · Patrimônio: as contas "fora do resultado" do plano (retirada, aporte do
//     sócio), o Retained Earnings e o resultado do ano até a data (Net
//     Income) — a MESMA conta do P&L (grupoNoResultado, só o livro aprovado),
//     senão o Net Income do Balanço diverge do P&L do mesmo ano.
//
// RETAINED EARNINGS JUNTA QUATRO COISAS (decisão do sócio, 11/2026: o
// Balanço não mostra Opening Balance Equity nem Transfers in Transit):
//   · o resultado dos anos anteriores (o P&L aprovado antes de 1º de janeiro);
//   · a conta "Retained Earnings" do plano, se houver lançamento nela;
//   · o SALDO DE ABERTURA das contas (o deduzido da referência, abaixo, e a
//     conta "Opening Balance Equity" do plano, que a importação do QuickBooks
//     traz) — é o que o contador faz no QuickBooks ao zerar o OBE;
//   · as TRANSFERÊNCIAS SEM PAR até a data: transferência ou pagamento de
//     cartão com uma ponta só (a outra caiu depois da data, ou está numa conta
//     ou num período que não está no sistema). Aqui o caixa vem do banco, e no
//     QuickBooks a transferência é UM lançamento com as duas pontas: lá isso
//     não existe.
// Apagar as duas linhas sem levar o valor a lugar nenhum deixaria o ativo
// diferente do passivo + patrimônio. A composição vai em `composicaoDosLucros`
// e aparece nas notas da equipe — saldo de abertura alto ou transferência sem
// par grande é sinal de histórico faltando ou de conta cadastrada em dobro.
// A linha que FICA é "Transactions Awaiting Review": o líquido do que está na
// fila (pending/auto) até a data — o dinheiro passou pelo banco, a
// classificação ainda não. Some quando a fila é revisada.
// Com tudo isso o Balanço fecha por construção, ao centavo.
//
// SALDO DE ABERTURA. O sistema não tem um "saldo inicial" digitado por conta;
// ele é deduzido de uma REFERÊNCIA: um saldo conhecido numa data. São três, e
// vale a mais próxima da data do Balanço (as outras dependem de todos os
// lançamentos entre elas e a data estarem no sistema):
//   1. a conciliação concluída (o saldo final do extrato que a equipe digitou);
//   2. o saldo corrido do extrato importado (CSV, PDF, QuickBooks), no FIM do
//      dia — a ordem das linhas dentro do dia não é conhecida, então o fim do
//      dia é o saldo que não é o "anterior" de nenhuma outra linha;
//   3. o saldo que o banco informou na última sincronização (Plaid).
// Abertura = referência − lançamentos do banco até a data dela. Lançamento
// MANUAL (cheque ainda não compensado, ajuste) e a conta de passagem do caixa
// da firma não passam pelo saldo do banco: ficam fora dessa conta e entram no
// caixa por cima, como no QuickBooks. Conta sem referência abre em zero e a
// tela da equipe avisa.

import { grupoNoResultado, MOVIMENTOS_DE_BALANCO, CONTA_SEM_NOME } from './grupo-do-resultado.ts'
import { ORIGENS_DE_PASSAGEM } from './fluxo-de-caixa.ts'
import { dataDaFirma } from './dia-da-firma.ts'

/** O livro: o que o P&L soma. */
export const STATUS_DO_LIVRO: readonly string[] = ['approved', 'reviewed']
/** Fora de tudo: a linha excluída não é movimento (duplicata, linha de resumo do extrato). */
export const STATUS_FORA: readonly string[] = ['excluded']
/** Não passam pelo saldo do banco: o lançamento manual e a conta de passagem. */
export const ORIGENS_FORA_DO_BANCO: readonly string[] = ['manual', ...ORIGENS_DE_PASSAGEM]

/** A conta do plano com este nome (a importação do QuickBooks a traz) entra no saldo de abertura — que compõe o Retained Earnings. */
export const CONTA_DE_ABERTURA = 'Opening Balance Equity'
export const CONTA_DE_LUCROS_ACUMULADOS = 'Retained Earnings'

/**
 * Cartão de crédito. A importação do QuickBooks gravava 'credit' (o resto do
 * sistema grava 'credit_card'): sem aceitar os dois, o cartão importado de lá
 * entraria no Balanço como DINHEIRO em banco, com a dívida somando no ativo.
 */
export function ehCartao(tipo: unknown): boolean {
  const t = String(tipo ?? '').trim().toLowerCase()
  return t === 'credit_card' || t === 'credit'
}

export interface ContaDoBalanco {
  id: string
  name?: string | null
  type?: string | null
  current_balance?: unknown
  balance_as_of?: unknown
}

export interface LancamentoDoBalanco {
  account_id?: string | null
  tx_date: unknown
  amount: unknown
  balance?: unknown
  category?: string | null
  status?: string | null
  source?: string | null
}

export interface ConciliacaoDoBalanco {
  account_id?: unknown
  statement_date: unknown
  ending_balance: unknown
  status?: unknown
}

export type FonteDoSaldo = 'conciliacao' | 'extrato' | 'banco'

/** Um saldo conhecido numa data, em centavos e com o sinal do livro (cartão: dívida negativa). */
export interface Referencia { data: string; saldo: number; fonte: FonteDoSaldo }

const DATA = /^\d{4}-\d{2}-\d{2}$/
const dia = (v: unknown) => String(v ?? '').slice(0, 10)

function centavos(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Math.round(Number(v) * 100)
  return Number.isFinite(n) ? n : null
}
const c0 = (v: unknown) => centavos(v) ?? 0

const doBanco = (l: LancamentoDoBalanco) => !ORIGENS_FORA_DO_BANCO.includes(String(l.source ?? ''))

/**
 * Em que sentido o saldo corrido do extrato anda: +1 quando sobe com a
 * entrada (conta corrente), -1 quando desce (fatura de cartão, em que o saldo
 * é a dívida). Decide pelos próprios dados — cada par de linhas seguidas vota
 * — e, sem votos suficientes, fica com o padrão do tipo da conta.
 */
export function sentidoDoSaldoCorrido(
  linhas: readonly { tx_date: unknown; amount: unknown; balance?: unknown }[],
  padrao: 1 | -1,
): 1 | -1 {
  const ls = linhas
    .map((l, i) => ({ d: dia(l.tx_date), a: c0(l.amount), b: centavos(l.balance), i }))
    .filter(l => l.b !== null)
    .sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : x.i - y.i))
  let mesmo = 0, inverso = 0
  for (let k = 1; k < ls.length; k++) {
    const delta = (ls[k].b as number) - (ls[k - 1].b as number), a = ls[k].a
    if (a === 0) continue
    if (delta === a) mesmo++
    else if (delta === -a) inverso++
  }
  if (mesmo >= 2 && mesmo > inverso) return 1
  if (inverso >= 2 && inverso > mesmo) return -1
  return padrao
}

/**
 * O saldo no FIM do dia, pelas linhas do extrato daquele dia. A ordem delas
 * dentro do dia não é conhecida (o id é aleatório, a importação grava tudo no
 * mesmo instante); mas cada linha diz o saldo depois dela, e o saldo ANTES
 * dela é esse menos o valor. O último saldo do dia é o único que não é o
 * "antes" de nenhuma outra linha. Mais de um candidato (ou nenhum) é
 * ambíguo: aquele dia não serve de referência.
 */
export function saldoNoFimDoDia(linhas: readonly { amount: unknown; balance?: unknown }[], sentido: 1 | -1): number | null {
  const ls = linhas
    .map(l => ({ a: c0(l.amount), b: centavos(l.balance) }))
    .filter((l): l is { a: number; b: number } => l.b !== null)
  if (!ls.length) return null
  const antes = ls.map(l => l.b - sentido * l.a)
  const candidatos = new Set<number>()
  ls.forEach((l, i) => {
    if (!antes.some((p, j) => j !== i && p === l.b)) candidatos.add(l.b)
  })
  return candidatos.size === 1 ? Array.from(candidatos)[0] : null
}

/** As referências de saldo de UMA conta: conciliações, extrato e banco. */
export function referenciasDaConta(o: {
  cartao: boolean
  /** Os lançamentos da conta, já sem os excluídos. */
  lancamentos: readonly LancamentoDoBalanco[]
  conciliacoes?: readonly ConciliacaoDoBalanco[]
  saldoDoBanco?: unknown
  /** Data (do escritório) em que o banco informou o saldo. */
  saldoDoBancoEm?: string | null
}): Referencia[] {
  const refs: Referencia[] = []
  for (const c of o.conciliacoes || []) {
    // Só a concluída: a em andamento ainda não fechou com o extrato.
    if (String(c.status ?? '') !== 'completed') continue
    const d = dia(c.statement_date), s = centavos(c.ending_balance)
    if (DATA.test(d) && s !== null) refs.push({ data: d, saldo: s, fonte: 'conciliacao' })
  }
  const comSaldo = o.lancamentos.filter(l => doBanco(l) && centavos(l.balance) !== null && DATA.test(dia(l.tx_date)))
  if (comSaldo.length) {
    const sentido = sentidoDoSaldoCorrido(comSaldo, o.cartao ? -1 : 1)
    const porDia = new Map<string, LancamentoDoBalanco[]>()
    for (const l of comSaldo) {
      const d = dia(l.tx_date)
      const lista = porDia.get(d)
      if (lista) lista.push(l)
      else porDia.set(d, [l])
    }
    porDia.forEach((ls, d) => {
      const fim = saldoNoFimDoDia(ls, sentido)
      if (fim !== null) refs.push({ data: d, saldo: sentido * fim, fonte: 'extrato' })
    })
  }
  const sb = centavos(o.saldoDoBanco), db = dia(o.saldoDoBancoEm)
  // O banco informa a dívida do cartão como número positivo.
  if (sb !== null && DATA.test(db)) refs.push({ data: db, saldo: o.cartao ? -sb : sb, fonte: 'banco' })
  return refs
}

const PRIORIDADE: Record<FonteDoSaldo, number> = { conciliacao: 0, extrato: 1, banco: 2 }

function diasEntre(a: string, b: string): number {
  const t = (x: string) => Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, +x.slice(8, 10))
  return Math.round(Math.abs(t(a) - t(b)) / 86_400_000)
}

/**
 * A referência que vale para a data do Balanço: a mais PRÓXIMA dela (as
 * outras dependem de todos os lançamentos do meio estarem no sistema); no
 * empate, a de antes da data; depois, conciliação, extrato e banco.
 */
export function escolherReferencia(refs: readonly Referencia[], corte: string): Referencia | null {
  let melhor: Referencia | null = null
  let km: [number, number, number] | null = null
  for (const r of refs) {
    const k: [number, number, number] = [diasEntre(r.data, corte), r.data <= corte ? 0 : 1, PRIORIDADE[r.fonte]]
    if (!km || k[0] < km[0] || (k[0] === km[0] && (k[1] < km[1] || (k[1] === km[1] && k[2] < km[2])))) { melhor = r; km = k }
  }
  return melhor
}

/** Onde a conta do plano entra no Balanço. */
export type LadoNoBalanco = 'resultado' | 'ativo' | 'passivo' | 'patrimonio' | 'movimento'

const tem = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/**
 * 'resultado' é EXATAMENTE o que o P&L soma (grupoNoResultado: conta fora do
 * plano é despesa); 'movimento' são as contas que o motor grava pelo nome
 * (transferência, pagamento de cartão, depósito da passagem); o resto segue o
 * grupo do plano, e o que não é ativo nem passivo é patrimônio.
 */
export function ladoNoBalanco(conta: string, plano: Readonly<Record<string, string | null | undefined>>): LadoNoBalanco {
  const nome = String(conta ?? '').trim()
  const i = nome.indexOf(':')
  const mae = i > 0 ? nome.slice(0, i).trim() : null
  if (MOVIMENTOS_DE_BALANCO.includes(nome) || (mae !== null && MOVIMENTOS_DE_BALANCO.includes(mae))) return 'movimento'
  if (grupoNoResultado(String(conta ?? ''), plano) !== null) return 'resultado'
  const grupo = tem(plano, String(conta)) ? plano[String(conta)] : mae !== null && tem(plano, mae) ? plano[mae] : undefined
  if (grupo === 'asset') return 'ativo'
  if (grupo === 'liability') return 'passivo'
  return 'patrimonio'
}

export interface SaldoDeConta {
  id: string
  nome: string
  cartao: boolean
  /** Na data, em centavos e com o sinal do livro (cartão: dívida negativa). */
  saldo: number
  abertura: number
  referencia: Referencia | null
}

export interface LinhaDeValor { conta: string; valor: number }

export interface Balanco {
  corte: string
  inicioDoExercicio: string
  /** Todas as contas bancárias e cartões, com ou sem saldo (para as notas da equipe). */
  contas: SaldoDeConta[]
  /** Ativo: contas bancárias com saldo ≠ 0, em ordem alfabética. */
  bancos: LinhaDeValor[]
  /** Ativo: lançamentos sem conta bancária (o caixa deles não tem onde ficar). */
  semConta: { quantidade: number; valor: number }
  /** Ativo: contas de ativo do plano. */
  outrosAtivos: LinhaDeValor[]
  /** Passivo: cartões, dívida positiva. */
  cartoes: LinhaDeValor[]
  /** Passivo: contas de passivo do plano. */
  outrosPassivos: LinhaDeValor[]
  /** Patrimônio: as contas do plano (retirada, aporte), em ordem alfabética — sem a de abertura nem a de lucros acumulados. */
  patrimonio: LinhaDeValor[]
  /** Retained Earnings como sai no Balanço: a soma das quatro partes de `composicaoDosLucros`. */
  lucrosAcumulados: number
  /** De onde vem o Retained Earnings — para as notas da equipe. */
  composicaoDosLucros: {
    /** P&L aprovado antes de 1º de janeiro do ano da data. */
    resultadoAnterior: number
    /** Lançamentos na conta "Retained Earnings" do plano. */
    contaDoPlano: number
    /** Saldo de abertura das contas (deduzido da referência) + a conta "Opening Balance Equity" do plano. */
    saldoDeAbertura: number
    /** Transferências e pagamentos de cartão com uma ponta só até a data (líquido). */
    transferenciasSemPar: number
  }
  aguardandoRevisao: { quantidade: number; valor: number }
  resultadoDoExercicio: number
  totais: { ativo: number; passivo: number; patrimonio: number; passivoEPatrimonio: number }
  /** Ativo = passivo + patrimônio, ao centavo. Por construção é sempre verdade; a rota confere. */
  fecha: boolean
}

const ordem = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })
const soma = (ls: readonly LinhaDeValor[]) => ls.reduce((s, l) => s + l.valor, 0)
const naoZeradas = (m: Map<string, number>) =>
  Array.from(m.entries()).filter(([, v]) => v !== 0).map(([conta, valor]) => ({ conta, valor })).sort((a, b) => ordem(a.conta, b.conta))

function diaDoBanco(instante: unknown): string | null {
  if (instante === null || instante === undefined || instante === '') return null
  const d = new Date(String(instante))
  return Number.isNaN(d.getTime()) ? null : dataDaFirma(d)
}

export function montarBalanco(e: {
  contas: readonly ContaDoBalanco[]
  /** TODOS os lançamentos do cliente, de qualquer data: a referência pode ser posterior à data do Balanço. */
  lancamentos: readonly LancamentoDoBalanco[]
  conciliacoes?: readonly ConciliacaoDoBalanco[]
  /** nome da conta → grupo (bookkeeping_categories.kind) */
  plano: Readonly<Record<string, string | null | undefined>>
  /** YYYY-MM-DD */
  corte: string
}): Balanco {
  const corte = e.corte
  const inicio = `${corte.slice(0, 4)}-01-01`
  const vivos = e.lancamentos.filter(l => !STATUS_FORA.includes(String(l.status ?? '')) && DATA.test(dia(l.tx_date)))

  // ── As contas bancárias e os cartões ───────────────────────────────────
  const porConta = new Map<string, LancamentoDoBalanco[]>()
  for (const l of vivos) {
    const k = String(l.account_id ?? '')
    const lista = porConta.get(k)
    if (lista) lista.push(l)
    else porConta.set(k, [l])
  }
  const concPorConta = new Map<string, ConciliacaoDoBalanco[]>()
  for (const c of e.conciliacoes || []) {
    const k = String(c.account_id ?? '')
    const lista = concPorConta.get(k)
    if (lista) lista.push(c)
    else concPorConta.set(k, [c])
  }
  const ids = new Set<string>()
  const contas: SaldoDeConta[] = e.contas.map(c => {
    const id = String(c.id)
    ids.add(id)
    const cartao = ehCartao(c.type)
    const ls = porConta.get(id) || []
    const ref = escolherReferencia(referenciasDaConta({
      cartao, lancamentos: ls, conciliacoes: concPorConta.get(id) || [],
      saldoDoBanco: c.current_balance, saldoDoBancoEm: diaDoBanco(c.balance_as_of),
    }), corte)
    let abertura = 0
    if (ref) abertura = ref.saldo - ls.filter(l => doBanco(l) && dia(l.tx_date) <= ref.data).reduce((s, l) => s + c0(l.amount), 0)
    const mov = ls.filter(l => dia(l.tx_date) <= corte).reduce((s, l) => s + c0(l.amount), 0)
    return { id, nome: String(c.name || 'Account'), cartao, saldo: abertura + mov, abertura, referencia: ref }
  })

  // ── As duas pernas de cada lançamento até a data ───────────────────────
  let semContaValor = 0, semContaQtd = 0
  let movimento = 0, aguardando = 0, aguardandoQtd = 0, lucros = 0, resultado = 0
  const ativos = new Map<string, number>(), passivos = new Map<string, number>(), patrimonio = new Map<string, number>()
  const somar = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) || 0) + v)
  for (const l of vivos) {
    const d = dia(l.tx_date)
    if (d > corte) continue
    const a = c0(l.amount)
    if (!ids.has(String(l.account_id ?? ''))) { semContaValor += a; semContaQtd++ }
    const conta = l.category || CONTA_SEM_NOME
    const lado = ladoNoBalanco(conta, e.plano)
    // Transferência e pagamento de cartão: regra do motor, qualquer situação
    // (as duas pontas se anulam; o que sobra é a ponta sem par até a data).
    if (lado === 'movimento') { movimento += a; continue }
    if (!STATUS_DO_LIVRO.includes(String(l.status ?? ''))) { aguardando += a; aguardandoQtd++; continue }
    if (lado === 'resultado') { if (d < inicio) lucros += a; else resultado += a }
    else if (lado === 'ativo') somar(ativos, conta, -a)
    else if (lado === 'passivo') somar(passivos, conta, a)
    else somar(patrimonio, conta, a)
  }

  // ── Patrimônio ──────────────────────────────────────────────────────────
  // O saldo de abertura e as transferências sem par compõem o Retained
  // Earnings (decisão do sócio — ver o cabeçalho). A conta "Opening Balance
  // Equity" e a "Retained Earnings" do plano saem da lista e entram nele.
  const aberturaDeContas = contas.reduce((s, c) => s + c.abertura, 0)
  let aberturaDoPlano = 0, lucrosDoPlano = 0
  patrimonio.forEach((v, k) => {
    const nome = k.trim().toLowerCase()
    if (nome === CONTA_DE_ABERTURA.toLowerCase()) { aberturaDoPlano += v; patrimonio.delete(k) }
    else if (nome === CONTA_DE_LUCROS_ACUMULADOS.toLowerCase()) { lucrosDoPlano += v; patrimonio.delete(k) }
  })
  const composicaoDosLucros = {
    resultadoAnterior: lucros,
    contaDoPlano: lucrosDoPlano,
    saldoDeAbertura: aberturaDeContas + aberturaDoPlano,
    transferenciasSemPar: movimento,
  }
  const lucrosAcumulados = composicaoDosLucros.resultadoAnterior + composicaoDosLucros.contaDoPlano
    + composicaoDosLucros.saldoDeAbertura + composicaoDosLucros.transferenciasSemPar
  const contasDePatrimonio = naoZeradas(patrimonio)

  const bancos = contas.filter(c => !c.cartao && c.saldo !== 0).map(c => ({ conta: c.nome, valor: c.saldo })).sort((a, b) => ordem(a.conta, b.conta))
  const cartoes = contas.filter(c => c.cartao && c.saldo !== 0).map(c => ({ conta: c.nome, valor: -c.saldo })).sort((a, b) => ordem(a.conta, b.conta))
  const outrosAtivos = naoZeradas(ativos), outrosPassivos = naoZeradas(passivos)

  const ativo = soma(bancos) + semContaValor + soma(outrosAtivos)
  const passivo = soma(cartoes) + soma(outrosPassivos)
  const pl = soma(contasDePatrimonio) + lucrosAcumulados + aguardando + resultado
  return {
    corte, inicioDoExercicio: inicio, contas,
    bancos, semConta: { quantidade: semContaQtd, valor: semContaValor }, outrosAtivos,
    cartoes, outrosPassivos,
    patrimonio: contasDePatrimonio, lucrosAcumulados, composicaoDosLucros,
    aguardandoRevisao: { quantidade: aguardandoQtd, valor: aguardando }, resultadoDoExercicio: resultado,
    totais: { ativo, passivo, patrimonio: pl, passivoEPatrimonio: passivo + pl },
    fecha: ativo === passivo + pl,
  }
}
