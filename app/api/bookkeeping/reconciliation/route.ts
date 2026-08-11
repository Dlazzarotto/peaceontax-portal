// /api/bookkeeping/reconciliation
//
// Reconciliação bancária estilo QuickBooks.
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

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

const round2 = (n: number) => Math.round(n * 100) / 100

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  const accountId = sp.get('accountId')
  const statementDate = sp.get('statementDate')
  if (!clientId || !accountId) return NextResponse.json({ error: 'clientId e accountId obrigatórios' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()

  // Histórico + última fechada (saldo inicial sugerido)
  const { data: historico } = await db
    .from('bank_reconciliations')
    .select('id, statement_date, beginning_balance, ending_balance, cleared_count, status, completed_at')
    .eq('client_id', clientId).eq('account_id', accountId)
    .order('statement_date', { ascending: false })
    .limit(24)

  const ultima = (historico || []).find((r: any) => r.status === 'completed')
  const emAberto = (historico || []).find((r: any) => r.status === 'in_progress')

  let elegiveis: any[] = []
  let pendentesNaoAprovados = 0

  if (statementDate) {
    // Só o que está NO REGISTRO (aprovado/revisado) — concilia-se o livro, não a fila
    const { data: txs } = await db
      .from('bank_transactions')
      .select('id, tx_date, description, amount, payee, category, reconciliation_id, status')
      .eq('client_id', clientId).eq('account_id', accountId)
      .in('status', ['approved', 'reviewed'])
      .lte('tx_date', statementDate)
      .order('tx_date', { ascending: true })
      .limit(5000)

    elegiveis = (txs || []).filter((t: any) =>
      !t.reconciliation_id || (emAberto && t.reconciliation_id === emAberto.id))

    const { count } = await db
      .from('bank_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId).eq('account_id', accountId)
      .in('status', ['pending', 'auto'])
      .lte('tx_date', statementDate)
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
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const beginning = round2(Number(b.beginningBalance) || 0)
  const ending = round2(Number(b.endingBalance) || 0)
  const ids: string[] = Array.isArray(clearedIds) ? clearedIds : []

  // Soma dos marcados (valores já vêm com sinal)
  let clearedTotal = 0
  if (ids.length) {
    const { data: marcados } = await db
      .from('bank_transactions')
      .select('id, amount')
      .eq('client_id', clientId).eq('account_id', accountId)
      .in('id', ids.slice(0, 5000))
    clearedTotal = round2((marcados || []).reduce((acc: number, t: any) => acc + Number(t.amount), 0))
  }

  const difference = round2(beginning + clearedTotal - ending)

  if (action === 'finish' && Math.abs(difference) > 0.005) {
    return NextResponse.json({
      error: `Ainda há diferença de $${difference.toFixed(2)}. A conciliação só fecha com diferença zero.`,
      difference,
    }, { status: 400 })
  }

  // Conciliação em aberto desta conta (ou cria)
  const { data: existente } = await db
    .from('bank_reconciliations')
    .select('id')
    .eq('client_id', clientId).eq('account_id', accountId)
    .eq('status', 'in_progress')
    .limit(1).maybeSingle()

  const payload: any = {
    client_id: clientId,
    account_id: accountId,
    statement_date: statementDate,
    beginning_balance: beginning,
    ending_balance: ending,
    cleared_total: clearedTotal,
    cleared_count: ids.length,
    difference,
    status: action === 'finish' ? 'completed' : 'in_progress',
    updated_at: new Date().toISOString(),
    created_by: auth.userId,
    ...(action === 'finish' ? { completed_at: new Date().toISOString() } : {}),
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

  // Solta os que foram desmarcados e marca os atuais
  await db.from('bank_transactions')
    .update({ reconciliation_id: null, reconciled_at: null })
    .eq('reconciliation_id', recId)

  if (ids.length) {
    for (let i = 0; i < ids.length; i += 500) {
      const { error } = await db.from('bank_transactions')
        .update({
          reconciliation_id: recId,
          reconciled_at: action === 'finish' ? new Date().toISOString() : null,
        })
        .in('id', ids.slice(i, i + 500))
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  return NextResponse.json({
    ok: true,
    reconciliationId: recId,
    clearedTotal,
    difference,
    status: payload.status,
  })
}

export async function DELETE(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: rec } = await db.from('bank_reconciliations')
    .select('id, client_id').eq('id', id).single()
  if (!rec) return NextResponse.json({ error: 'Conciliação não encontrada' }, { status: 404 })
  if (!(await canAccessClient(auth, rec.client_id))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  await db.from('bank_transactions')
    .update({ reconciliation_id: null, reconciled_at: null })
    .eq('reconciliation_id', id)
  const { error } = await db.from('bank_reconciliations').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
