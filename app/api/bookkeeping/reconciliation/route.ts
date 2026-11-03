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

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { todasAsLinhas } from '@/lib/paginar'
import { apurarConciliacao, emLotes } from '@/lib/conciliacao-bancaria'

export const dynamic = 'force-dynamic'

const DATA = /^\d{4}-\d{2}-\d{2}$/

/** O que pode ser conciliado nesta conta até a data: o REGISTRO, não a fila. */
async function elegiveisDaConta(db: any, clientId: string, accountId: string, statementDate: string, emAbertoId: string | null) {
  const { data, error } = await todasAsLinhas<any>(() => db
    .from('bank_transactions')
    .select('id, tx_date, description, amount, payee, category, reconciliation_id, status')
    .eq('client_id', clientId).eq('account_id', accountId)
    .in('status', ['approved', 'reviewed'])
    .lte('tx_date', statementDate)
    .order('tx_date', { ascending: true }))
  if (error) return { error }
  return {
    elegiveis: (data || []).filter((t: any) => !t.reconciliation_id || (emAbertoId && t.reconciliation_id === emAbertoId)),
    error: null,
  }
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

  // Histórico + última fechada (saldo inicial sugerido)
  const { data: historico, error: errHistorico } = await db
    .from('bank_reconciliations')
    .select('id, statement_date, beginning_balance, ending_balance, cleared_count, status, completed_at')
    .eq('client_id', clientId).eq('account_id', accountId)
    .order('statement_date', { ascending: false })
    .limit(24)
  if (errHistorico) return NextResponse.json({ error: `Falhou ao ler as conciliações desta conta: ${errHistorico.message}` }, { status: 500 })

  const ultima = (historico || []).find((r: any) => r.status === 'completed')
  const emAberto = (historico || []).find((r: any) => r.status === 'in_progress')

  let elegiveis: any[] = []
  let pendentesNaoAprovados = 0

  if (statementDate) {
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

  return NextResponse.json({
    ok: true,
    historico: historico || [],
    saldoInicialSugerido: ultima ? Number(ultima.ending_balance) : 0,
    ultimaConciliacao: ultima || null,
    emAberto: emAberto || null,
    elegiveis,
    jaMarcados: emAberto ? elegiveis.filter((t: any) => t.reconciliation_id === emAberto.id).map((t: any) => t.id) : [],
    pendentesNaoAprovados,
  })
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

  // Conciliação em aberto desta conta (os lançamentos dela continuam elegíveis)
  const { data: existente, error: errExistente } = await db
    .from('bank_reconciliations')
    .select('id')
    .eq('client_id', clientId).eq('account_id', accountId)
    .eq('status', 'in_progress')
    .limit(1).maybeSingle()
  if (errExistente) return NextResponse.json({ error: `Falhou ao ler a conciliação em andamento: ${errExistente.message}` }, { status: 500 })

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

  let recId = existente?.id
  if (recId) {
    const { error } = await db.from('bank_reconciliations').update(payload).eq('id', recId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { data, error } = await db.from('bank_reconciliations').insert(payload).select('id').single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    recId = data.id
  }

  // Solta os que foram desmarcados e marca os atuais — em lotes pequenos: o
  // `in (ids)` vai na URL, e o lote de 500 passava do tamanho aceito.
  const { error: errSolta } = await db.from('bank_transactions')
    .update({ reconciliation_id: null, reconciled_at: null })
    .eq('reconciliation_id', recId)
  if (errSolta) return NextResponse.json({ error: `Falhou ao soltar os lançamentos desmarcados: ${errSolta.message}` }, { status: 500 })

  for (const lote of emLotes(ids)) {
    const { error } = await db.from('bank_transactions')
      .update({ reconciliation_id: recId, reconciled_at: null })
      .eq('client_id', clientId).eq('account_id', accountId)
      .in('id', lote)
    if (error) {
      return NextResponse.json({
        error: `Falhou ao marcar os lançamentos (${error.message}). A conciliação ficou EM ANDAMENTO — salve de novo.`,
      }, { status: 500 })
    }
  }

  if (action === 'finish') {
    const agora = new Date().toISOString()
    const { error: errData } = await db.from('bank_transactions')
      .update({ reconciled_at: agora }).eq('reconciliation_id', recId)
    if (errData) return NextResponse.json({ error: `Falhou ao datar os lançamentos conciliados (${errData.message}). A conciliação ficou EM ANDAMENTO.` }, { status: 500 })
    const { error: errFecha } = await db.from('bank_reconciliations')
      .update({ status: 'completed', completed_at: agora, updated_at: agora }).eq('id', recId)
    if (errFecha) return NextResponse.json({ error: `Falhou ao fechar a conciliação (${errFecha.message}). Ela ficou EM ANDAMENTO.` }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    reconciliationId: recId,
    clearedTotal: conta.total,
    difference: conta.diferenca,
    status: action === 'finish' ? 'completed' : 'in_progress',
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
  const { error: errSolta } = await db.from('bank_transactions')
    .update({ reconciliation_id: null, reconciled_at: null })
    .eq('reconciliation_id', id)
  if (errSolta) return NextResponse.json({ error: `Falhou ao soltar os lançamentos: ${errSolta.message}` }, { status: 500 })
  const { error } = await db.from('bank_reconciliations').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
