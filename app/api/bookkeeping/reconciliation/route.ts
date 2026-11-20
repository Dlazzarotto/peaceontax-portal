// /api/bookkeeping/reconciliation
//
// Reconciliação bancária estilo QuickBooks. Só a equipe, com acesso ao cliente
// (`canAccessClient`).
//
//  GET  ?clientId=&accountId=&statementDate=   → saldo inicial sugerido,
//       lançamentos elegíveis (do registro, até a data), conciliação em aberto
//       e histórico das conciliações fechadas
//
//  POST { action:'save'|'finish', clientId, accountId, statementDate,
//         beginningBalance, endingBalance, clearedIds[] }
//       save   → guarda o progresso (pode continuar depois)
//       finish → só fecha se a diferença for zero
//
//  DELETE ?id=   → reabre/desfaz uma conciliação (libera os lançamentos)
//
// A diferença é a de lib/conciliacao-bancaria.ts, a MESMA conta da tela. A
// rota pedia os marcados ao banco pelos ids numa URL só: com 965 lançamentos o
// pedido passava do tamanho que o Supabase aceita, a consulta falhava, o erro
// era ignorado e a soma virava zero — a tela dizia "diferença 0.00" e a rota
// recusava com saldo inicial menos saldo final. Agora a rota lê os elegíveis
// pelo FILTRO (conta, data, situação), em páginas (`todasAsLinhas`: o
// `.limit(5000)` parava em mil e cortava os lançamentos mais recentes), e toda
// consulta que falha vira erro, nunca "zero" ou "nenhum".
//
// Depois disso a tela parou de CARREGAR (ver lib/conciliacao-bancaria.ts):
// o histórico pedia colunas de uma tabela nascida no painel — faltando uma, o
// erro agora conferido derrubava tudo antes de ler os lançamentos — e, lendo
// tudo, a resposta podia passar do que a Vercel entrega. Agora o histórico é
// `select('*')`; os elegíveis vêm filtrados NA CONSULTA (livres + os da
// conciliação em andamento), só com as colunas que a tela usa; e acima do
// teto a rota diz quantos são e o que fazer, em vez de uma página de erro.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { todasAsLinhas } from '@/lib/paginar'
import { colunaAusente } from '@/lib/caixa-firma'
import {
  apurarConciliacao, emLotes, normalizarConciliacao, juntarElegiveis, mensagemDeExcesso, linhaParaATela,
  gravarSemColunasAusentes, avisoDeColunas, TETO_DA_RESPOSTA, TETO_DE_LANCAMENTOS,
} from '@/lib/conciliacao-bancaria'

export const dynamic = 'force-dynamic'
// Conta com anos de extrato são várias páginas de mil: o padrão de 10-15 s da
// Vercel não pode ser o que decide se a tela carrega.
export const maxDuration = 60

const DATA = /^\d{4}-\d{2}-\d{2}$/

/** As colunas que a tela mostra e a conta usa. `category` e `status` iam e voltavam à toa. */
const COLUNAS_DA_TELA = 'id, tx_date, description, amount, payee, reconciliation_id'

/**
 * O que pode ser conciliado nesta conta até a data: o REGISTRO, não a fila —
 * os ainda livres e os da conciliação em andamento. O filtro vai NA CONSULTA:
 * antes vinham também todos os já conciliados, para serem jogados fora aqui.
 */
async function elegiveisDaConta(db: any, clientId: string, accountId: string, statementDate: string, emAbertoId: string | null) {
  const consulta = () => db
    .from('bank_transactions')
    .select(COLUNAS_DA_TELA)
    .eq('client_id', clientId).eq('account_id', accountId)
    .in('status', ['approved', 'reviewed'])
    .lte('tx_date', statementDate)
  const livres = await todasAsLinhas<any>(() => consulta().is('reconciliation_id', null).order('tx_date', { ascending: true }))
  if (livres.error) return { error: livres.error }
  if (!emAbertoId) return { elegiveis: livres.data, error: null }
  const daAberta = await todasAsLinhas<any>(() => consulta().eq('reconciliation_id', emAbertoId).order('tx_date', { ascending: true }))
  if (daAberta.error) return { error: daAberta.error }
  return { elegiveis: juntarElegiveis(livres.data, daAberta.data), error: null }
}

/** Quantos livres há até a data — para recusar ANTES de ler dezenas de páginas. */
async function contarLivres(db: any, clientId: string, accountId: string, statementDate: string) {
  const { count, error } = await db
    .from('bank_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId).eq('account_id', accountId)
    .in('status', ['approved', 'reviewed'])
    .lte('tx_date', statementDate)
    .is('reconciliation_id', null)
  return { total: count ?? 0, error }
}

/**
 * A conciliação em andamento desta conta — a MESMA consulta no GET e no POST,
 * senão a tela mostraria os marcados de uma e a rota gravaria em outra.
 * `select('*')`: a tabela nasceu no painel, e pedir coluna por nome é apostar
 * que o painel a criou. Com duas em andamento (o Salvar antigo podia deixar),
 * a ordem decide sempre a mesma.
 */
async function conciliacaoEmAndamento(db: any, clientId: string, accountId: string) {
  const { data, error } = await db
    .from('bank_reconciliations')
    .select('*')
    .eq('client_id', clientId).eq('account_id', accountId)
    .eq('status', 'in_progress')
    .order('statement_date', { ascending: false }).order('id', { ascending: true })
    .limit(1).maybeSingle()
  return { emAberto: data ? normalizarConciliacao(data) : null, error }
}

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  const accountId = sp.get('accountId')
  const statementDate = sp.get('statementDate')
  if (!clientId || !accountId) return NextResponse.json({ error: 'clientId e accountId obrigatórios' }, { status: 400 })
  if (statementDate && !DATA.test(statementDate)) return NextResponse.json({ error: 'Data final do extrato inválida' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()

  // Histórico + última fechada (saldo inicial sugerido). `select('*')`: a
  // tabela nasceu no painel — pedir `completed_at` por nome derrubava a tela
  // inteira se o painel não a criou.
  const { data: linhas, error: errHistorico } = await db
    .from('bank_reconciliations')
    .select('*')
    .eq('client_id', clientId).eq('account_id', accountId)
    .order('statement_date', { ascending: false })
    .limit(24)
  if (errHistorico) return NextResponse.json({ error: `Falhou ao ler as conciliações desta conta: ${errHistorico.message}` }, { status: 500 })
  const historico = (linhas || []).map(normalizarConciliacao)
  const ultima = historico.find(r => r.status === 'completed')

  const andamento = await conciliacaoEmAndamento(db, clientId, accountId)
  if (andamento.error) return NextResponse.json({ error: `Falhou ao ler a conciliação em andamento: ${andamento.error.message}` }, { status: 500 })
  const emAberto = andamento.emAberto

  let elegiveis: any[] = []
  let pendentesNaoAprovados = 0

  if (statementDate) {
    // Volume: recusar com a contagem ANTES de ler é dizer o que fazer em vez
    // de deixar a resposta passar do que a Vercel entrega.
    const livres = await contarLivres(db, clientId, accountId, statementDate)
    if (livres.error) return NextResponse.json({ error: `Falhou ao contar os lançamentos: ${livres.error.message}` }, { status: 500 })
    if (livres.total > TETO_DE_LANCAMENTOS) {
      return NextResponse.json({ error: mensagemDeExcesso(livres.total, statementDate), excesso: { total: livres.total, teto: TETO_DE_LANCAMENTOS } }, { status: 422 })
    }

    const lidos = await elegiveisDaConta(db, clientId, accountId, statementDate, emAberto?.id ?? null)
    if (lidos.error) return NextResponse.json({ error: `Falhou ao ler os lançamentos: ${lidos.error.message}` }, { status: 500 })
    elegiveis = lidos.elegiveis || []

    const { count, error: errPendentes } = await db
      .from('bank_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId).eq('account_id', accountId)
      .in('status', ['pending', 'auto'])
      .lte('tx_date', statementDate)
    // Contagem que falha não é "nenhum pendente": é o aviso que deixaria de aparecer.
    if (errPendentes) return NextResponse.json({ error: `Falhou ao contar os lançamentos ainda não aprovados: ${errPendentes.message}` }, { status: 500 })
    pendentesNaoAprovados = count ?? 0
  }

  const corpo = JSON.stringify({
    ok: true,
    historico,
    saldoInicialSugerido: ultima?.ending_balance ?? 0,
    ultimaConciliacao: ultima || null,
    emAberto: emAberto || null,
    elegiveis: elegiveis.map(linhaParaATela),
    jaMarcados: emAberto ? elegiveis.filter((t: any) => t.reconciliation_id === emAberto.id).map((t: any) => t.id) : [],
    pendentesNaoAprovados,
  })
  // O teto de verdade é o tamanho: descrição comprida pesa mais que a contagem
  // prevê, e acima de 4,5 MB a Vercel troca a resposta por uma página de erro.
  if (statementDate && Buffer.byteLength(corpo) > TETO_DA_RESPOSTA) {
    return NextResponse.json({ error: mensagemDeExcesso(elegiveis.length, statementDate), excesso: { total: elegiveis.length, teto: TETO_DE_LANCAMENTOS } }, { status: 422 })
  }
  return new NextResponse(corpo, { headers: { 'content-type': 'application/json' } })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const b = await req.json()
  const { action, clientId, accountId, statementDate, clearedIds } = b
  if (!clientId || !accountId || !statementDate) {
    return NextResponse.json({ error: 'clientId, accountId e statementDate obrigatórios' }, { status: 400 })
  }
  if (action !== 'save' && action !== 'finish') return NextResponse.json({ error: 'Ação inválida' }, { status: 400 })
  if (!DATA.test(String(statementDate))) return NextResponse.json({ error: 'Data final do extrato inválida' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const ids: string[] = Array.from(new Set((Array.isArray(clearedIds) ? clearedIds : []).map(String)))

  // Conciliação em aberto desta conta (os lançamentos dela continuam
  // elegíveis) — a mesma consulta do GET.
  const andamento = await conciliacaoEmAndamento(db, clientId, accountId)
  if (andamento.error) return NextResponse.json({ error: `Falhou ao ler a conciliação em andamento: ${andamento.error.message}` }, { status: 500 })
  const existente = andamento.emAberto

  // A soma sai do banco, pelo filtro — nunca de uma lista de ids na URL, e
  // nunca do número que o navegador mandou.
  const lidos = await elegiveisDaConta(db, clientId, accountId, statementDate, existente?.id ?? null)
  if (lidos.error) return NextResponse.json({ error: `Falhou ao ler os lançamentos: ${lidos.error.message}` }, { status: 500 })

  const conta = apurarConciliacao({
    saldoInicial: b.beginningBalance, saldoFinal: b.endingBalance,
    elegiveis: lidos.elegiveis || [], marcados: ids,
  })

  if (conta.naoElegiveis.length) {
    return NextResponse.json({
      error: `${conta.naoElegiveis.length} dos lançamentos marcados não estão mais disponíveis para esta conciliação `
        + '(foram apagados, voltaram para a fila de aprovação, mudaram de data ou já estão em outra conciliação fechada). '
        + 'Clique em "Carregar lançamentos" de novo e confira a diferença.',
      naoElegiveis: conta.naoElegiveis.length,
    }, { status: 409 })
  }

  if (action === 'finish' && !conta.fecha) {
    return NextResponse.json({
      error: `Ainda há diferença de ${conta.diferenca < 0 ? '−' : ''}$${Math.abs(conta.diferenca).toFixed(2)}. A conciliação só fecha com diferença zero.`,
      difference: conta.diferenca,
    }, { status: 400 })
  }

  // Grava como EM ANDAMENTO primeiro: se a marcação falhar no meio, a
  // conciliação não fica "fechada" com metade dos lançamentos.
  const payload: any = {
    client_id: clientId,
    account_id: accountId,
    statement_date: statementDate,
    beginning_balance: Math.round(Number(b.beginningBalance) * 100) / 100 || 0,
    ending_balance: Math.round(Number(b.endingBalance) * 100) / 100 || 0,
    cleared_total: conta.total,
    cleared_count: ids.length,
    difference: conta.diferenca,
    status: 'in_progress',
    updated_at: new Date().toISOString(),
    created_by: auth.userId,
  }

  // A tabela nasceu no painel: coluna OPCIONAL que ele não criou não pode
  // impedir de salvar — sai da gravação e vira aviso (rodar a migração).
  // A coluna que faltou uma vez não vai de novo (são até 150 lotes).
  const semColuna = new Set<string>()
  const semAs = (c: Record<string, unknown>) => Object.fromEntries(Object.entries(c).filter(([k]) => !semColuna.has(k)))
  let recId = existente?.id
  if (recId) {
    const g = await gravarSemColunasAusentes(payload, c => db.from('bank_reconciliations').update(c).eq('id', recId), colunaAusente)
    g.semColuna.forEach(c => semColuna.add(c))
    if (g.error) return NextResponse.json({ error: `Falhou ao gravar a conciliação: ${g.error.message}` }, { status: 500 })
  } else {
    const g = await gravarSemColunasAusentes<any>(payload, c => db.from('bank_reconciliations').insert(c).select('id').single(), colunaAusente)
    g.semColuna.forEach(c => semColuna.add(c))
    if (g.error || !g.data) return NextResponse.json({ error: `Falhou ao gravar a conciliação: ${g.error?.message || 'sem resposta do banco'}` }, { status: 500 })
    recId = g.data.id
  }

  // Solta os que foram desmarcados e marca os atuais — em lotes pequenos: o
  // `in (ids)` vai na URL, e o lote de 500 passava do tamanho aceito.
  // `reconciled_at` é data informativa; sem `reconciliation_id` não há marca.
  const SO_A_MARCA = ['reconciliation_id']
  const solta = await gravarSemColunasAusentes(semAs({ reconciliation_id: null, reconciled_at: null }),
    c => db.from('bank_transactions').update(c).eq('reconciliation_id', recId), colunaAusente, SO_A_MARCA)
  solta.semColuna.forEach(c => semColuna.add(c))
  if (solta.error) return NextResponse.json({ error: `Falhou ao soltar os lançamentos desmarcados: ${solta.error.message}` }, { status: 500 })

  for (const lote of emLotes(ids)) {
    const marca = await gravarSemColunasAusentes(semAs({ reconciliation_id: recId, reconciled_at: null }),
      c => db.from('bank_transactions').update(c).eq('client_id', clientId).eq('account_id', accountId).in('id', lote),
      colunaAusente, SO_A_MARCA)
    marca.semColuna.forEach(c => semColuna.add(c))
    if (marca.error) {
      return NextResponse.json({
        error: `Falhou ao marcar os lançamentos (${marca.error.message}). A conciliação ficou EM ANDAMENTO — salve de novo.`,
      }, { status: 500 })
    }
  }

  if (action === 'finish') {
    const agora = new Date().toISOString()
    const datar = await gravarSemColunasAusentes(semAs({ reconciled_at: agora }),
      c => db.from('bank_transactions').update(c).eq('reconciliation_id', recId), colunaAusente, SO_A_MARCA)
    datar.semColuna.forEach(c => semColuna.add(c))
    if (datar.error) return NextResponse.json({ error: `Falhou ao datar os lançamentos conciliados (${datar.error.message}). A conciliação ficou EM ANDAMENTO.` }, { status: 500 })
    const fecha = await gravarSemColunasAusentes(semAs({ status: 'completed', completed_at: agora, updated_at: agora }),
      c => db.from('bank_reconciliations').update(c).eq('id', recId), colunaAusente)
    fecha.semColuna.forEach(c => semColuna.add(c))
    if (fecha.error) return NextResponse.json({ error: `Falhou ao fechar a conciliação (${fecha.error.message}). Ela ficou EM ANDAMENTO.` }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    reconciliationId: recId,
    clearedTotal: conta.total,
    difference: conta.diferenca,
    status: action === 'finish' ? 'completed' : 'in_progress',
    aviso: avisoDeColunas(Array.from(semColuna)),
  })
}

export async function DELETE(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: rec, error: errRec } = await db.from('bank_reconciliations')
    .select('id, client_id').eq('id', id).maybeSingle()
  if (errRec) return NextResponse.json({ error: `Falhou ao ler a conciliação: ${errRec.message}` }, { status: 500 })
  if (!rec) return NextResponse.json({ error: 'Conciliação não encontrada' }, { status: 404 })
  if (!(await canAccessClient(auth, rec.client_id))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  // Solta os lançamentos ANTES de apagar: se soltar falhar, a conciliação
  // fica, e os lançamentos não ficam presos a uma conciliação que não existe.
  const solta = await gravarSemColunasAusentes({ reconciliation_id: null, reconciled_at: null },
    c => db.from('bank_transactions').update(c).eq('reconciliation_id', id), colunaAusente, ['reconciliation_id'])
  if (solta.error) return NextResponse.json({ error: `Falhou ao soltar os lançamentos: ${solta.error.message}` }, { status: 500 })
  const { error } = await db.from('bank_reconciliations').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
