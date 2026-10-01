// Fluxo de caixa da firma — o REALIZADO (o que o banco já mostrou) e o
// PROJETADO (o que está comprometido dos dois lados).
//
// Módulo puro: recebe `hoje` de fora, porque o dia é o do ESCRITÓRIO
// (`dataDaFirma`, America/New_York) e não o do servidor — às 20h de Malden o
// UTC já virou amanhã, e uma conta venceria um dia antes.
//
// ===========================================================================
// 1. POR QUE O REALIZADO NÃO É "A SOMA DOS LANÇAMENTOS"
// ===========================================================================
// O livro da firma guarda, na MESMA tabela, duas coisas de naturezas
// diferentes (ver `lib/deposito-match.ts`):
//
//   a) o EXTRATO: o que o banco de fato movimentou;
//   b) a CONTA DE PASSAGEM ("Recebimentos a depositar", o Undeposited Funds):
//      `recebimento` (+bruto, quando a fatura é recebida), `deposito`
//      (−valor, a transferência que esvazia a passagem) e `taxa` (−taxa
//      retida no repasse do Stripe).
//
// A passagem existe para a RECEITA fechar pelo bruto — é a bruta que vai no
// 1099-K. Mas ela não é dinheiro no banco: o cheque recebido hoje e
// depositado na semana que vem já está lançado como `recebimento` e ainda
// não entrou em conta nenhuma. Somar tudo conta o mesmo depósito duas vezes
// (uma no crédito do extrato, outra no `recebimento`) e antecipa dinheiro
// que não chegou.
//
// Então o realizado lê SÓ O EXTRATO. A taxa do Stripe não some: ela já está
// embutida no crédito líquido do repasse, que é exatamente o que entrou.
//
// ===========================================================================
// 2. TRANSFERÊNCIA ENTRE CONTAS DA PRÓPRIA FIRMA NÃO É FLUXO
// ===========================================================================
// Mandar $10.000 da corrente para a poupança não é entrada nem saída — o
// líquido já dá zero, mas as COLUNAS de entradas e saídas incham, e é por
// elas que se olha "quanto a firma gasta por mês". As duas pernas são
// ligadas por `transfer_match_id`, então o par sai fora.
//
// Com uma exceção que precisa ficar: no depósito conciliado, o crédito do
// extrato também tem `transfer_match_id` — mas apontando para a linha da
// PASSAGEM, não para outra linha do extrato. Esse crédito É entrada de
// dinheiro e tem de ficar. Por isso a regra olha o PAR, não a coluna: só sai
// quando as duas pernas são do extrato.
//
// ===========================================================================
// 3. O REALIZADO NÃO ESPERA CLASSIFICAÇÃO
// ===========================================================================
// O P&L só conta o que está `approved`/`reviewed`, e com razão: lucro é
// resultado contábil e depende da conta certa. Caixa não. O débito de $4.000
// saiu da conta mesmo sem ninguém ter dito em que categoria ele entra.
// Exigir aprovação aqui mostraria um caixa que não existe — e hoje a firma
// tem centenas de linhas na fila. O fluxo conta TUDO o que é extrato.
//
// ===========================================================================
// 4. A PROJEÇÃO É CONSERVADORA DE PROPÓSITO
// ===========================================================================
// Entrada projetada é fatura em aberto; saída projetada é conta a pagar em
// aberto. Três decisões:
//
//   · Fatura VENCIDA fica FORA da projeção. Dinheiro que já era para ter
//     entrado não é previsão, é cobrança — e justamente quando o caixa
//     aperta é que o atrasado não chega. Ela aparece à parte, somada, para
//     ninguém achar que foi esquecida.
//   · Conta a pagar vencida fica DENTRO, na primeira faixa. Atrasada ou
//     não, ela vai ser paga, e o caixa precisa contar com isso.
//   · Mensalidade ainda não faturada fica de fora. Contrato recorrente é
//     expectativa, não compromisso de data; misturar previsão de venda com
//     caixa comprometido é como um fluxo deixa de servir para decidir.
//
// O erro aqui não é simétrico: superestimar entrada faz a firma gastar o que
// não tem. Na dúvida, de fora.

export const round2 = (n: number) => Math.round(n * 100) / 100

const DIA = 86400000
const emDias = (iso: string) => Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`)

/** Dias até a data: negativo é atraso. Meio-dia evita o pulo do verão. */
export function diasAte(data: string, hoje: string): number {
  return Math.round((emDias(data) - emDias(hoje)) / DIA)
}

// --- O extrato × a conta de passagem --------------------------------------

/**
 * Origens que NÃO são movimento de banco: são a conta de passagem.
 *
 * A lista espelha o que `conciliar_deposito` e `sincronizarRecebimentos`
 * gravam (e o que `sql/caixa-origens-v1.sql` admite no CHECK).
 */
export const ORIGENS_DE_PASSAGEM = ['recebimento', 'deposito', 'taxa'] as const

export interface Lancamento {
  id: string
  tx_date: string
  amount: number
  source?: string | null
  account_id?: string | null
  transfer_match_id?: string | null
  balance?: number | string | null
  description?: string | null
}

/** É linha do extrato (e não da conta de passagem)? */
export function ehDoExtrato(t: Pick<Lancamento, 'source'>): boolean {
  return !(ORIGENS_DE_PASSAGEM as readonly string[]).includes(String(t?.source || ''))
}

/**
 * O extrato, sem as transferências entre contas da própria firma.
 *
 * Tira o par só quando as DUAS pernas são do extrato — o crédito do depósito
 * conciliado aponta para a linha da passagem e precisa ficar (seção 2).
 */
export function movimentoDeBanco(txs: Lancamento[]): Lancamento[] {
  const lista = (txs || []).filter(ehDoExtrato)
  const doExtrato = new Set(lista.map(t => t.id))
  return lista.filter(t => !(t.transfer_match_id && doExtrato.has(t.transfer_match_id)))
}

// --- Realizado -------------------------------------------------------------

export interface MesDoFluxo {
  mes: string          // YYYY-MM
  entradas: number
  saidas: number       // positivo (quanto saiu)
  liquido: number
}

export interface Realizado {
  meses: MesDoFluxo[]
  entradas: number
  saidas: number
  liquido: number
  mediaLiquida: number    // média dos meses COM movimento
  lancamentos: number
}

/**
 * Agrupa o extrato por mês. `de`/`ate` são inclusivos (YYYY-MM-DD); sem eles,
 * tudo. Mês sem movimento não vira linha — inventar meses zerados num extrato
 * que começa no meio do ano faz a média despencar e mente sobre o gasto.
 */
export function fluxoRealizado(txs: Lancamento[], de?: string | null, ate?: string | null): Realizado {
  const dentro = movimentoDeBanco(txs).filter(t => {
    const d = String(t.tx_date || '').slice(0, 10)
    if (!d) return false
    if (de && d < de) return false
    if (ate && d > ate) return false
    return true
  })

  const porMes = new Map<string, MesDoFluxo>()
  for (const t of dentro) {
    const mes = String(t.tx_date).slice(0, 7)
    const v = Number(t.amount) || 0
    const m = porMes.get(mes) || { mes, entradas: 0, saidas: 0, liquido: 0 }
    if (v >= 0) m.entradas += v
    else m.saidas += -v
    m.liquido += v
    porMes.set(mes, m)
  }

  const meses = Array.from(porMes.values())
    .map(m => ({ mes: m.mes, entradas: round2(m.entradas), saidas: round2(m.saidas), liquido: round2(m.liquido) }))
    .sort((a, b) => a.mes.localeCompare(b.mes))

  const entradas = round2(meses.reduce((s, m) => s + m.entradas, 0))
  const saidas   = round2(meses.reduce((s, m) => s + m.saidas, 0))
  return {
    meses,
    entradas,
    saidas,
    liquido: round2(entradas - saidas),
    mediaLiquida: meses.length ? round2(meses.reduce((s, m) => s + m.liquido, 0) / meses.length) : 0,
    lancamentos: dentro.length,
  }
}

// --- Saldo em conta --------------------------------------------------------

export interface ContaBancaria {
  id: string
  name?: string | null
  type?: string | null
  current_balance?: number | string | null   // o que o banco informou
  balance_as_of?: string | null              // quando foi lido
}

export interface SaldoDaConta {
  id: string
  nome: string
  saldo: number | null
  em: string | null                 // data do saldo
  fonte: 'banco' | 'extrato' | null // de onde ele veio
}

export interface SaldoEmConta {
  total: number | null   // null = nenhuma conta tem saldo conhecido
  contas: SaldoDaConta[]
  semSaldo: string[]     // nomes das contas sem saldo
}

/**
 * Saldo por conta, em duas fontes e nesta ordem:
 *
 *   1. `bank_accounts.current_balance` — o que o BANCO informou, pelo
 *      `/accounts/get` do Plaid na última sincronização. É o saldo de hoje.
 *   2. o `balance` do lançamento mais recente que o traga — o saldo corrido
 *      que alguns extratos em CSV têm por linha. Serve para quem importa
 *      arquivo em vez de conectar o banco.
 *
 * A ordem não é preferência, é precisão: o saldo corrido do extrato só sabe
 * até a última linha importada, e um extrato de três semanas atrás
 * apresentado como "saldo hoje" é pior do que dizer que não se sabe.
 *
 * Isto NÃO duplica o balanço (`bookkeeping/balance-sheet`): lá a pergunta é
 * "quanto tinha em 31/12", que só o saldo corrido do extrato responde. São
 * perguntas diferentes, e é por isso que têm fontes diferentes.
 *
 * Cartão de crédito fica de fora: ali o saldo é DÍVIDA, e somá-lo ao caixa
 * daria um número que não é nem uma coisa nem outra.
 *
 * **Saldo desconhecido não é zero.** Conta sem saldo nenhum devolve `null` e
 * entra em `semSaldo`; se nenhuma tiver, o total é `null`. Zero, na tela, é
 * uma afirmação — e seria a pior possível aqui.
 */
/** Só o que o saldo precisa: a rota busca estas três colunas e mais nada. */
export type LinhaDeSaldo = Pick<Lancamento, 'account_id' | 'tx_date' | 'balance'>

export function saldoEmConta(contas: ContaBancaria[], txs: LinhaDeSaldo[]): SaldoEmConta {
  const emDinheiro = (contas || []).filter(c => c.type !== 'credit_card')
  const linhas: SaldoDaConta[] = emDinheiro.map(c => {
    // 1) o banco, quando ele disse.
    if (c.current_balance != null && c.current_balance !== '') {
      return {
        id: c.id,
        nome: c.name || 'Conta',
        saldo: round2(Number(c.current_balance)),
        em: c.balance_as_of ? String(c.balance_as_of).slice(0, 10) : null,
        fonte: 'banco' as const,
      }
    }
    // 2) senão, o saldo corrido do extrato importado.
    let melhor: LinhaDeSaldo | null = null
    for (const t of txs || []) {
      if (t.account_id !== c.id || t.balance == null) continue
      const d = String(t.tx_date || '').slice(0, 10)
      if (!melhor || d > String(melhor.tx_date).slice(0, 10)) melhor = t
    }
    return {
      id: c.id,
      nome: c.name || 'Conta',
      saldo: melhor ? round2(Number(melhor.balance)) : null,
      em: melhor ? String(melhor.tx_date).slice(0, 10) : null,
      fonte: melhor ? ('extrato' as const) : null,
    }
  })
  const comSaldo = linhas.filter(l => l.saldo != null)
  return {
    total: comSaldo.length ? round2(comSaldo.reduce((s, l) => s + (l.saldo || 0), 0)) : null,
    contas: linhas,
    semSaldo: linhas.filter(l => l.saldo == null).map(l => l.nome),
  }
}

// --- Projeção --------------------------------------------------------------

export const FAIXAS_DA_PROJECAO = [
  { id: 'vencido', rotulo: 'Vencido',        ate: -1 },
  { id: 'd7',      rotulo: 'Até 7 dias',     ate: 7 },
  { id: 'd30',     rotulo: '8 a 30 dias',    ate: 30 },
  { id: 'd60',     rotulo: '31 a 60 dias',   ate: 60 },
  { id: 'd60mais', rotulo: 'Mais de 60 dias', ate: Infinity },
] as const

export type FaixaId = typeof FAIXAS_DA_PROJECAO[number]['id']

/** Em que faixa cai um vencimento. Vence hoje conta como "até 7 dias". */
export function faixaDoVencimento(due: string | null | undefined, hoje: string): FaixaId {
  if (!due) return 'd60mais'   // sem data não se pode cobrar nem pagar hoje
  const d = diasAte(String(due), hoje)
  if (d < 0) return 'vencido'
  if (d <= 7) return 'd7'
  if (d <= 30) return 'd30'
  if (d <= 60) return 'd60'
  return 'd60mais'
}

export interface FaturaEmAberto {
  id?: string
  due_date?: string | null
  total: number | string
  paid_total?: number | string | null
}

export interface ContaEmAberto {
  id?: string
  due_date: string
  amount: number | string
  status?: string | null
}

export interface LinhaDaProjecao {
  faixa: FaixaId
  rotulo: string
  receber: number        // o que entra na projeção
  pagar: number
  liquido: number
  saldo: number | null   // acumulado; null se o saldo inicial é desconhecido
}

export interface Projecao {
  saldoInicial: number | null
  linhas: LinhaDaProjecao[]
  receber: number            // total projetado (SEM o vencido)
  pagar: number
  receberVencido: number     // fora da projeção, mostrado à parte
  saldoFinal: number | null
  menorSaldo: number | null  // o fundo do poço da projeção
  faixaDoAperto: FaixaId | null
  alerta: string | null
}

/**
 * A projeção: do saldo de hoje, descontando o que vence e somando o que está
 * para receber, como fica o caixa em cada faixa.
 *
 * Fatura vencida NÃO entra (vai em `receberVencido`); conta vencida entra, na
 * faixa `vencido`, porque ela vai ser paga de todo jeito. O porquê das duas
 * está no cabeçalho deste arquivo.
 */
export function projetarCaixa(opts: {
  saldoInicial: number | null
  faturas: FaturaEmAberto[]
  contas: ContaEmAberto[]
  hoje: string
}): Projecao {
  const { saldoInicial, hoje } = opts
  const vazio = () => ({ receber: 0, pagar: 0 })
  const porFaixa = new Map<FaixaId, { receber: number; pagar: number }>(
    FAIXAS_DA_PROJECAO.map(f => [f.id, vazio()])
  )

  let receberVencido = 0
  for (const f of opts.faturas || []) {
    const saldo = round2(Number(f.total || 0) - Number(f.paid_total || 0))
    if (saldo <= 0) continue
    const faixa = faixaDoVencimento(f.due_date, hoje)
    if (faixa === 'vencido') { receberVencido = round2(receberVencido + saldo); continue }
    porFaixa.get(faixa)!.receber += saldo
  }

  for (const c of opts.contas || []) {
    if (c.status && c.status !== 'aberta') continue
    const v = Number(c.amount || 0)
    if (v <= 0) continue
    porFaixa.get(faixaDoVencimento(c.due_date, hoje))!.pagar += v
  }

  let saldo = saldoInicial
  let menor: number | null = saldoInicial
  let faixaDoAperto: FaixaId | null = null
  const linhas: LinhaDaProjecao[] = FAIXAS_DA_PROJECAO.map(f => {
    const v = porFaixa.get(f.id)!
    const receber = round2(v.receber)
    const pagar = round2(v.pagar)
    const liquido = round2(receber - pagar)
    if (saldo != null) {
      saldo = round2(saldo + liquido)
      if (menor == null || saldo < menor) { menor = saldo; faixaDoAperto = f.id }
    }
    return { faixa: f.id, rotulo: f.rotulo, receber, pagar, liquido, saldo }
  })

  const receber = round2(linhas.reduce((s, l) => s + l.receber, 0))
  const pagar = round2(linhas.reduce((s, l) => s + l.pagar, 0))

  // O vencido a receber entra no aviso como RESSALVA, nunca somado: quem
  // decide precisa saber que existe, sem que a projecao conte com ele.
  const comVencido = receberVencido > 0
    ? ` — há ${dinheiro(receberVencido)} vencidos a receber, fora da projeção.`
    : '.'
  let alerta: string | null = null
  if (saldoInicial == null) {
    alerta = 'Sem o saldo da conta não dá para projetar — conecte o banco ou sincronize o extrato.'
  } else if (faixaDoAperto === null && menor != null && menor < 0) {
    // Nao e a projecao que aperta: a conta JA esta negativa hoje.
    alerta = `A conta já está negativa em ${dinheiro(-menor)} hoje${comVencido}`
  } else if (faixaDoAperto !== null && menor != null && menor < 0) {
    const f = FAIXAS_DA_PROJECAO.find(x => x.id === faixaDoAperto)
    alerta = `O caixa fica negativo em "${f?.rotulo}". Faltam ${dinheiro(-menor)}${comVencido}`
  }

  return {
    saldoInicial,
    linhas,
    receber,
    pagar,
    receberVencido,
    saldoFinal: saldo,
    menorSaldo: menor,
    faixaDoAperto: saldoInicial == null ? null : faixaDoAperto,
    alerta,
  }
}

function dinheiro(v: number): string {
  return `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
