// /api/bookkeeping/transfer-match
//
// Conciliação de transferências entre contas do mesmo cliente (estilo QuickBooks).
//
//  GET  ?txId=&accountId=   → lançamentos candidatos na conta da outra ponta
//  POST { txId, matchId, category? }  → liga as duas pontas
//  DELETE ?txId=            → desfaz a conciliação
//
// A ligação marca as DUAS transações com a mesma categoria (Transfer ou
// Credit Card Payment) e status 'auto' — reconhecidas, aguardando aprovação.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

const JANELA_DIAS = 7   // diferença máxima de data entre as duas pontas

async function loadTx(db: any, txId: string) {
  const { data } = await db.from('bank_transactions')
    .select('id, client_id, account_id, tx_date, description, amount, category, status, transfer_match_id')
    .eq('id', txId).single()
  return data
}

// ─────────────── GET: candidatos na outra conta ───────────────
export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const txId = sp.get('txId')
  const accountId = sp.get('accountId')
  if (!txId || !accountId) return NextResponse.json({ error: 'txId e accountId obrigatórios' }, { status: 400 })

  const db = serviceDb()
  const tx = await loadTx(db, txId)
  if (!tx) return NextResponse.json({ error: 'Lançamento não encontrado' }, { status: 404 })
  if (!(await canAccessClient(auth, tx.client_id))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const d0 = new Date(tx.tx_date)
  const de = new Date(d0); de.setDate(de.getDate() - JANELA_DIAS)
  const ate = new Date(d0); ate.setDate(ate.getDate() + JANELA_DIAS)

  const { data: cand } = await db.from('bank_transactions')
    .select('id, tx_date, description, amount, category, status, transfer_match_id')
    .eq('client_id', tx.client_id)
    .eq('account_id', accountId)
    .eq('amount', -Number(tx.amount))          // espelho exato
    .gte('tx_date', de.toISOString().slice(0, 10))
    .lte('tx_date', ate.toISOString().slice(0, 10))
    .neq('status', 'excluded')
    .is('transfer_match_id', null)
    .limit(20)

  const candidatos = (cand || [])
    .map((c: any) => ({
      ...c,
      dias: Math.abs(Math.round((new Date(c.tx_date).getTime() - d0.getTime()) / 86400000)),
    }))
    .sort((a: any, b: any) => a.dias - b.dias)

  return NextResponse.json({ ok: true, candidatos, valor: Number(tx.amount), data: tx.tx_date })
}

// ─────────────── POST: ligar as duas pontas ───────────────
export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const { txId, matchId, category } = await req.json()
  if (!txId || !matchId) return NextResponse.json({ error: 'txId e matchId obrigatórios' }, { status: 400 })
  if (txId === matchId) return NextResponse.json({ error: 'Não é possível conciliar com o próprio lançamento' }, { status: 400 })

  const db = serviceDb()
  const [a, b] = await Promise.all([loadTx(db, txId), loadTx(db, matchId)])
  if (!a || !b) return NextResponse.json({ error: 'Lançamento não encontrado' }, { status: 404 })
  if (a.client_id !== b.client_id) return NextResponse.json({ error: 'Lançamentos de clientes diferentes' }, { status: 400 })
  if (!(await canAccessClient(auth, a.client_id))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
  if (Math.abs(Number(a.amount) + Number(b.amount)) > 0.005) {
    return NextResponse.json({ error: 'Os valores não se anulam — não parece a outra ponta da transferência' }, { status: 400 })
  }
  if (a.transfer_match_id || b.transfer_match_id) {
    return NextResponse.json({ error: 'Um dos lançamentos já está conciliado — desfaça antes' }, { status: 409 })
  }

  const cat = category === 'Credit Card Payment' ? 'Credit Card Payment' : 'Transfer'
  const base = {
    category: cat,
    category_confidence: 100,
    categorized_by: 'staff',
    status: 'auto',                    // reconhecida, aguardando sua aprovação
    updated_at: new Date().toISOString(),
  }

  const { error: e1 } = await db.from('bank_transactions')
    .update({ ...base, transfer_match_id: b.id, counterparty_account_id: b.account_id }).eq('id', a.id)
  const { error: e2 } = await db.from('bank_transactions')
    .update({ ...base, transfer_match_id: a.id, counterparty_account_id: a.account_id }).eq('id', b.id)
  if (e1 || e2) return NextResponse.json({ error: (e1 || e2)!.message }, { status: 500 })

  return NextResponse.json({ ok: true, category: cat, matched: { id: b.id, tx_date: b.tx_date, amount: b.amount } })
}

// ─────────────── DELETE: desfazer ───────────────
export async function DELETE(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const txId = req.nextUrl.searchParams.get('txId')
  if (!txId) return NextResponse.json({ error: 'txId obrigatório' }, { status: 400 })

  const db = serviceDb()
  const tx = await loadTx(db, txId)
  if (!tx) return NextResponse.json({ error: 'Lançamento não encontrado' }, { status: 404 })
  if (!(await canAccessClient(auth, tx.client_id))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const ids = [tx.id, tx.transfer_match_id].filter(Boolean)
  const { error } = await db.from('bank_transactions')
    .update({ transfer_match_id: null, counterparty_account_id: null, updated_at: new Date().toISOString() })
    .in('id', ids)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, desfeitos: ids.length })
}
