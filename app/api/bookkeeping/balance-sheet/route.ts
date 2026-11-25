// GET /api/bookkeeping/balance-sheet?clientId=...&asOf=YYYY-MM-DD
//   (ou year=YYYY, como sempre aceitou: vale 31 de dezembro daquele ano)
// O Balanço Patrimonial (cash basis), no formato do QuickBooks: ASSETS,
// LIABILITIES AND EQUITY, coluna TOTAL. A conta é de lib/balanco.ts (partidas
// dobradas: o ativo fecha com passivo + patrimônio ao centavo); o desenho é
// de lib/demonstrativo.ts (o mesmo do P&L). O demonstrativo é DO CLIENTE: a
// empresa dele no topo e a Peace on Tax só no rodapé (decisão do sócio).
// Quem pode: a equipe com acesso ao cliente, ou o próprio cliente (empresa)
// pelo portal. As notas da equipe (de onde veio o saldo de cada conta, o que
// ainda está na fila) só aparecem na tela da equipe — nunca no impresso nem
// no portal.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { getUser } from '@/lib/supabase-server'
import { barraDoRelatorio, META_RELATORIO, voltarDosRelatoriosContabeis } from '@/lib/relatorio-barra'
import { idDaFirma } from '@/lib/caixa-firma'
import { dataDeCorteDosParametros, dataPorExtensoEN } from '@/lib/periodo-relatorio'
import { todasAsLinhas } from '@/lib/paginar'
import { montarBalanco, type LinhaDeValor, type Referencia } from '@/lib/balanco'
import { htmlDoDemonstrativo, linhasDasContas, valorDoTotal, type LinhaDoDemonstrativo } from '@/lib/demonstrativo'

export const dynamic = 'force-dynamic'
// Lê todos os lançamentos do cliente (a referência de saldo pode ser
// posterior à data do Balanço), em páginas de mil.
export const maxDuration = 60

const mmddyyyy = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`
const soma = (ls: readonly LinhaDeValor[]) => ls.reduce((s, l) => s + l.valor, 0)

function deOndeVeio(r: Referencia | null): string {
  if (!r) return 'Nenhuma: abertura considerada zero'
  if (r.fonte === 'conciliacao') return `Conciliação concluída, extrato de ${mmddyyyy(r.data)}`
  if (r.fonte === 'extrato') return `Saldo corrido do extrato importado, em ${mmddyyyy(r.data)}`
  return `Saldo informado pelo banco em ${mmddyyyy(r.data)}`
}

export async function GET(req: NextRequest) {
  const auth = await getAuth()

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  // Balanço é "em tal data": asOf (ou to), ou year → 31/12 — lib/periodo-relatorio.ts
  const cutoff = dataDeCorteDosParametros(k => sp.get(k))
  if (!clientId || !cutoff) return NextResponse.json({ error: 'clientId e asOf (ou year) obrigatórios' }, { status: 400 })
  // Acesso: equipe (com permissão neste cliente) OU o próprio cliente business, pelo portal
  let isClient = false
  if (auth?.isStaff) {
    if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
  } else {
    const user = await getUser()
    if (!user) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
    const { data: own } = await serviceDb().from('clients').select('id, type').eq('user_id', user.id)
    const mine = (own || []).find(c => c.id === clientId)
    if (!mine || mine.type !== 'business') return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
    isClient = true
  }

  const db = serviceDb()
  // Balanço com lançamento faltando é demonstrativo ERRADO, não incompleto:
  // qualquer leitura que falhe recusa o relatório.
  const [
    { data: client, error: errCliente },
    { data: contas, error: errContas },
    { data: txs, error: errTxs },
    { data: cats, error: errCats },
  ] = await Promise.all([
    db.from('clients').select('name, business_name').eq('id', clientId).single(),
    // Todas, ativas ou não: a conta encerrada depois da data tinha saldo nela.
    // `*` porque current_balance e balance_as_of só existem depois de
    // sql/caixa-saldo-da-conta-v1.sql — sem elas, a referência do banco falta.
    db.from('bank_accounts').select('*').eq('client_id', clientId),
    // TODOS os lançamentos, de qualquer data: a referência de saldo pode ser
    // posterior à data do Balanço. Em páginas (o PostgREST para em mil).
    todasAsLinhas<any>(() => db.from('bank_transactions')
      .select('account_id, tx_date, amount, balance, category, status, source')
      .eq('client_id', clientId)),
    // O plano INTEIRO, ativo ou não, como o P&L lê: com planos diferentes o
    // Net Income do Balanço não bateria com o do P&L do mesmo ano.
    todasAsLinhas<{ name: string; kind: string }>(() => db.from('bookkeeping_categories').select('name, kind')),
  ])
  for (const [oque, err] of [['o cliente', errCliente], ['as contas bancárias', errContas], ['os lançamentos', errTxs],
                             ['o plano de contas', errCats]] as const) {
    if (err) return NextResponse.json({ error: `Balanço não gerado — falhou ao ler ${oque}: ${err.message}` }, { status: 500 })
  }
  // Conciliações: a tabela nasceu no painel e se lê só com `*`. Se a leitura
  // falhar, o Balanço sai com a referência do extrato ou do banco, e a nota
  // da equipe diz que a da conciliação ficou de fora — não é lista vazia calada.
  const { data: concs, error: errConcs } = await db.from('bank_reconciliations').select('*').eq('client_id', clientId)

  const plano: Record<string, string> = {}
  for (const c of cats) plano[c.name] = c.kind
  const b = montarBalanco({ contas: contas || [], lancamentos: txs, conciliacoes: errConcs ? [] : (concs || []), plano, corte: cutoff })
  // Por construção fecha sempre. Se não fechar, é defeito do cálculo — e um
  // Balanço que não fecha não sai.
  if (!b.fecha) {
    return NextResponse.json({
      error: `Balanço não gerado — ativo (${valorDoTotal(b.totais.ativo)}) diferente de passivo + patrimônio (${valorDoTotal(b.totais.passivoEPatrimonio)}).`,
    }, { status: 500 })
  }

  // ── As linhas, na ordem do QuickBooks ──────────────────────────────────
  const L: LinhaDoDemonstrativo[] = []
  const titulo = (rotulo: string, nivel: number) => L.push({ tipo: 'titulo', rotulo, nivel })
  const conta = (rotulo: string, nivel: number, valor: number) => L.push({ tipo: 'conta', rotulo, nivel, valor })
  const total = (rotulo: string, nivel: number, valor: number, geral = false) => L.push({ tipo: geral ? 'totalGeral' : 'total', rotulo, nivel, valor })

  const totalBancos = soma(b.bancos) + b.semConta.valor
  titulo('ASSETS', 0)
  if (b.bancos.length || b.semConta.valor || b.emTransito) {
    titulo('Current Assets', 1)
    if (b.bancos.length || b.semConta.valor) {
      titulo('Bank Accounts', 2)
      for (const x of b.bancos) conta(x.conta, 3, x.valor)
      if (b.semConta.valor) conta('Transactions Without a Bank Account', 3, b.semConta.valor)
      total('Total Bank Accounts', 2, totalBancos)
    }
    if (b.emTransito) {
      titulo('Other Current Assets', 2)
      conta('Transfers in Transit', 3, b.emTransito)
      total('Total Other Current Assets', 2, b.emTransito)
    }
    total('Total Current Assets', 1, totalBancos + b.emTransito)
  }
  if (b.outrosAtivos.length) {
    titulo('Other Assets', 1)
    L.push(...linhasDasContas(b.outrosAtivos, 2))
    total('Total Other Assets', 1, soma(b.outrosAtivos))
  }
  total('TOTAL ASSETS', 0, b.totais.ativo, true)

  titulo('LIABILITIES AND EQUITY', 0)
  if (b.cartoes.length || b.outrosPassivos.length) {
    titulo('Liabilities', 1)
    titulo('Current Liabilities', 2)
    if (b.cartoes.length) {
      titulo('Credit Cards', 3)
      for (const x of b.cartoes) conta(x.conta, 4, x.valor)
      total('Total Credit Cards', 3, soma(b.cartoes))
    }
    if (b.outrosPassivos.length) {
      titulo('Other Current Liabilities', 3)
      L.push(...linhasDasContas(b.outrosPassivos, 4))
      total('Total Other Current Liabilities', 3, soma(b.outrosPassivos))
    }
    total('Total Current Liabilities', 2, b.totais.passivo)
    total('Total Liabilities', 1, b.totais.passivo)
  }
  titulo('Equity', 1)
  L.push(...linhasDasContas(b.patrimonio, 2))
  conta('Retained Earnings', 2, b.lucrosAcumulados)
  if (b.aguardandoRevisao.valor) conta('Transactions Awaiting Review', 2, b.aguardandoRevisao.valor)
  conta('Net Income', 2, b.resultadoDoExercicio)
  total('Total Equity', 1, b.totais.patrimonio)
  total('TOTAL LIABILITIES AND EQUITY', 0, b.totais.passivoEPatrimonio, true)

  // ── O que só a tela mostra ─────────────────────────────────────────────
  const avisos: string[] = []
  if (b.aguardandoRevisao.quantidade > 0) {
    avisos.push(`${b.aguardandoRevisao.quantidade} transaction(s) up to ${dataPorExtensoEN(cutoff)} are still awaiting review — this balance sheet is preliminary.`)
  }
  const frases: string[] = []
  if (b.aguardandoRevisao.quantidade > 0) {
    frases.push(`${b.aguardandoRevisao.quantidade} lançamento(s) até ${mmddyyyy(cutoff)} ainda estão na fila (pendentes ou reconhecidos, sem aprovação), líquido de ${valorDoTotal(b.aguardandoRevisao.valor)}. O caixa já os inclui, porque o dinheiro passou pelo banco; o resultado ainda não — por isso a linha "Transactions Awaiting Review". Aprovados, eles vão para o Net Income (ou para a conta de balanço deles) e a linha some.`)
  }
  if (b.emTransito) {
    frases.push(`"Transfers in Transit" (${valorDoTotal(b.emTransito)}): transferência entre contas ou pagamento de cartão com uma ponta só até ${mmddyyyy(cutoff)}. Ou a outra ponta caiu depois da data (dinheiro em trânsito, normal na virada do mês), ou ela está numa conta que não foi importada.`)
  }
  if (b.semConta.quantidade > 0) {
    frases.push(`${b.semConta.quantidade} lançamento(s) sem conta bancária (${valorDoTotal(b.semConta.valor)}) — aparecem em "Transactions Without a Bank Account". Atribua a conta no lançamento.`)
  }
  const semReferencia = b.contas.filter(c => !c.referencia && c.saldo !== 0).map(c => c.nome)
  if (semReferencia.length) {
    frases.push(`Sem saldo de referência (o saldo de abertura foi considerado zero): ${semReferencia.join(', ')}. Concluir uma conciliação da conta, ou importar um extrato com a coluna de saldo, resolve.`)
  }
  if (errConcs) frases.push(`Não foi possível ler as conciliações (${errConcs.message}): o saldo de abertura saiu do extrato ou do banco.`)
  const linhasDasNotas = b.contas
    .filter(c => c.saldo !== 0 || c.referencia)
    .sort((x, y) => x.nome.localeCompare(y.nome, 'en', { sensitivity: 'base' }))
    .map(c => [
      c.cartao ? `${c.nome} (cartão)` : c.nome,
      valorDoTotal(c.cartao ? -c.saldo : c.saldo),
      deOndeVeio(c.referencia),
    ])

  const name = client?.business_name || client?.name || 'Client'
  // Voltar sem histórico nem aba para fechar: a tela de relatórios de onde ele
  // saiu. `from` não entra no balanço (que é "em tal data"); a tela o manda só
  // para a volta cair no período em que estava.
  const firmaId = isClient ? null : await idDaFirma(db)
  const barra = barraDoRelatorio({
    voltarPara: voltarDosRelatoriosContabeis({ isClient, clientId, ehFirma: firmaId === clientId, de: sp.get('from'), ate: cutoff }),
    painelPara: isClient ? '/portal' : '/dashboard',
  })
  const html = htmlDoDemonstrativo({
    empresa: name,
    titulo: 'Balance Sheet',
    periodo: `As of ${dataPorExtensoEN(cutoff)}`,
    linhas: L,
    agora: new Date(),
    regime: 'Cash Basis',
    meta: META_RELATORIO,
    barra,
    avisos,
    notas: isClient ? undefined : {
      titulo: 'Notas da equipe — não saem na impressão nem no portal do cliente',
      frases,
      tabela: { cabecalho: ['Conta', 'Saldo na data', 'Saldo de abertura deduzido de'], linhas: linhasDasNotas },
    },
  })
  return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0' } })
}
