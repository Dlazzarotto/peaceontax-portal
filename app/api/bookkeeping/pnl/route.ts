// GET /api/bookkeeping/pnl?clientId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
//   (ou year=YYYY[&month=M], como sempre aceitou — lib/periodo-relatorio.ts converte)
// Gera o P&L (cash-basis) em HTML pronto para imprimir/salvar PDF, no formato
// do QuickBooks (lib/demonstrativo.ts, o mesmo desenho do Balanço): Income,
// Cost of Goods Sold, GROSS PROFIT, Expenses, NET OPERATING INCOME, Other
// Income/Expenses, NET INCOME; despesa positiva na coluna. O demonstrativo é
// DO CLIENTE: a empresa dele no topo e a Peace on Tax só no rodapé, pequeno,
// sem logo (decisão do sócio, 11/2026).
// Cada conta é um link para o detalhe (category-detail), na mesma aba.
// Baseado no registro já aprovado (status approved/reviewed): o que ainda
// está na fila de classificação (pending/auto) não entra — a tela avisa.
// Só RESULTADO: o que é de balanço (transferência, pagamento de cartão,
// ativo, passivo) não aparece — lib/grupo-do-resultado.ts.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { getUser } from '@/lib/supabase-server'
import { barraDoRelatorio, META_RELATORIO, voltarDosRelatoriosContabeis } from '@/lib/relatorio-barra'
import { periodoDosParametros, periodoNoPadraoQB } from '@/lib/periodo-relatorio'
import { todasAsLinhas } from '@/lib/paginar'
import { somarPorConta, secoesDoResultado, totaisDoResultado, type LinhaDoResultado } from '@/lib/grupo-do-resultado'
import { idDaFirma } from '@/lib/caixa-firma'
import { htmlDoDemonstrativo, linhasDasContas, type LinhaDoDemonstrativo } from '@/lib/demonstrativo'

// Mapa categoria → grupo, carregado do banco. Leitura que falha NÃO vira mapa
// vazio: sem o plano, toda conta cai em despesa (lib/grupo-do-resultado.ts) e
// a receita sairia como gasto — o P&L errado com cara de certo.
async function loadKindMap(db: any): Promise<{ mapa: Record<string, string>; erro: string | null }> {
  const { data, error } = await todasAsLinhas<{ name: string; kind: string }>(() =>
    db.from('bookkeeping_categories').select('name, kind'))
  if (error) return { mapa: {}, erro: error.message }
  const mapa: Record<string, string> = {}
  for (const c of data) mapa[c.name] = c.kind
  return { mapa, erro: null }
}

export const dynamic = 'force-dynamic'

const centavos = (v: number) => Math.round(v * 100)

export async function GET(req: NextRequest) {
  const auth = await getAuth()

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  // O período vem de from/to (datas) ou de year[&month], como sempre; a
  // conversão é UMA (lib/periodo-relatorio.ts) e período que não faz sentido
  // é recusa, não "o ano todo".
  const periodo = periodoDosParametros(k => sp.get(k))
  if (!clientId || !periodo) return NextResponse.json({ error: 'clientId e período (from/to ou year[&month]) obrigatórios' }, { status: 400 })
  const { de, ate } = periodo
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
  const plano = await loadKindMap(db)
  if (plano.erro) return NextResponse.json({ error: `P&L não gerado — falhou ao ler o plano de contas: ${plano.erro}` }, { status: 500 })
  const kindMap = plano.mapa
  const { data: client } = await db.from('clients')
    .select('name, business_name').eq('id', clientId).single()

  // Filtro por DATA, não por fiscal_year: fiscal_year nasce de tx_date (toda
  // importação grava o ano da data), então no ano inteiro dá o mesmo — e num
  // trimestre ou mês só a data serve. Em páginas de 1000: `.limit(10000)` era
  // truncamento silencioso (teto do PostgREST), e o P&L saía ERRADO para
  // cliente com mais de mil lançamentos aprovados no período.
  const { data: txs, error: errTxs } = await todasAsLinhas<{ tx_date: string; category: string | null; amount: number; status: string }>(() =>
    db.from('bank_transactions')
      .select('tx_date, category, amount, status')
      .eq('client_id', clientId)
      .gte('tx_date', de).lte('tx_date', ate)
      .in('status', ['approved', 'reviewed']))
  // Consulta que falha não vira "No income recorded" — isso é uma afirmação.
  if (errTxs) return NextResponse.json({ error: `P&L não gerado — falhou ao ler os lançamentos: ${errTxs.message}` }, { status: 500 })

  // O que ainda está na fila no MESMO período — pendente (sem conta) e
  // reconhecido (com conta sugerida, sem aprovação): nenhum dos dois entra no
  // P&L. Contagem que falha não some: vira aviso, senão o P&L sairia como se
  // estivesse completo.
  const { count: pendingCount, error: errPend } = await db.from('bank_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId).gte('tx_date', de).lte('tx_date', ate).in('status', ['pending', 'auto'])

  // Soma por conta e separa as seções (lib/grupo-do-resultado.ts). O que é de
  // balanço — transferência, pagamento de cartão, ativo, passivo, retirada —
  // fica fora do demonstrativo, inclusive conta do motor que falte no plano
  // (antes ela caía em despesa).
  const secoes = secoesDoResultado(somarPorConta(txs), kindMap)
  const totais = totaisDoResultado(secoes)

  // Cada conta é um link para o detalhe, na mesma aba (o detalhe volta ao P&L
  // pelo Voltar ou pelo voltar do navegador).
  const detalhe = (conta: string) =>
    `/api/bookkeeping/category-detail?clientId=${encodeURIComponent(clientId)}&from=${de}&to=${ate}&category=${encodeURIComponent(conta)}`
  // Padrão QuickBooks: receita como vem; custo e despesa POSITIVOS na coluna
  // (o extrato os traz negativos); o sinal de menos fica para o que é negativo
  // de verdade (estorno maior que a despesa, prejuízo).
  const contas = (ls: LinhaDoResultado[], sinal: 1 | -1, nivel: number) =>
    linhasDasContas(ls.map(l => ({ conta: l.conta, valor: sinal * centavos(l.valor) })), nivel, detalhe)

  const L: LinhaDoDemonstrativo[] = []
  const titulo = (rotulo: string) => L.push({ tipo: 'titulo', rotulo, nivel: 0 })
  const total = (rotulo: string, valor: number, geral = false) => L.push({ tipo: geral ? 'totalGeral' : 'total', rotulo, nivel: 0, valor: centavos(valor) })

  titulo('Income')
  L.push(...contas(secoes.income, 1, 1))
  total('Total Income', totais.receita)
  if (secoes.cogs.length) {
    titulo('Cost of Goods Sold')
    L.push(...contas(secoes.cogs, -1, 1))
    total('Total Cost of Goods Sold', -totais.custo)
  }
  total('GROSS PROFIT', totais.bruto)
  titulo('Expenses')
  L.push(...contas(secoes.expense, -1, 1))
  total('Total Expenses', -totais.despesa)
  total('NET OPERATING INCOME', totais.operacional)
  if (secoes.other_income.length || secoes.other_expense.length) {
    if (secoes.other_income.length) {
      titulo('Other Income')
      L.push(...contas(secoes.other_income, 1, 1))
      total('Total Other Income', totais.outrasReceitas)
    }
    if (secoes.other_expense.length) {
      titulo('Other Expenses')
      L.push(...contas(secoes.other_expense, -1, 1))
      total('Total Other Expenses', -totais.outrasDespesas)
    }
    total('NET OTHER INCOME', totais.outrasReceitas + totais.outrasDespesas)
  }
  total('NET INCOME', totais.liquido, true)

  // Aviso só na tela (o impresso sai limpo; quem decide mandar é a equipe).
  const avisos = errPend
    ? [`Could not count the transactions still awaiting review (${errPend.message}) — treat this P&L as preliminary.`]
    : (pendingCount ?? 0) > 0 ? [`${pendingCount} transaction(s) in this period are still awaiting review — this P&L is preliminary.`] : []

  const displayName = client?.business_name || client?.name || ''
  const rotulo = periodoNoPadraoQB(de, ate)
  // Voltar sem histórico nem aba para fechar (app instalado, link salvo): a
  // tela de relatórios de onde ele saiu, no mesmo período — nunca a central.
  const firmaId = isClient ? null : await idDaFirma(db)
  const barra = barraDoRelatorio({
    voltarPara: voltarDosRelatoriosContabeis({ isClient, clientId, ehFirma: firmaId === clientId, de, ate }),
    painelPara: isClient ? '/portal' : '/dashboard',
  })
  const html = htmlDoDemonstrativo({
    empresa: displayName,
    titulo: 'Profit and Loss',
    periodo: rotulo,
    linhas: L,
    agora: new Date(),
    regime: 'Cash Basis',
    meta: META_RELATORIO,
    barra,
    avisos,
  })
  return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0' } })
}
