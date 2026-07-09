// GET    /api/bookkeeping/transactions?clientId=&year=&status=   — lista
// PATCH  /api/bookkeeping/transactions { id, category?, status?, notes? } — edita (equipe)
// DELETE /api/bookkeeping/transactions?documentId=...  — apaga transações de um extrato (reprocessar)

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  let q = serviceDb()
    .from('bank_transactions')
    .select('*')
    .eq('client_id', clientId)
    .order('tx_date', { ascending: false })
    .limit(1000)

  const accountId = sp.get('accountId')
  const year = sp.get('year')
  if (accountId) q = q.eq('account_id', accountId)
  if (year) q = q.eq('fiscal_year', parseInt(year))
  const status = sp.get('status')
  if (status) q = q.eq('status', status)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Resumo
  const txs = data || []
  const summary = {
    total: txs.length,
    pending: txs.filter(t => t.status === 'pending').length,
    credits: txs.filter(t => Number(t.amount) > 0).reduce((s, t) => s + Number(t.amount), 0),
    debits: txs.filter(t => Number(t.amount) < 0).reduce((s, t) => s + Number(t.amount), 0),
  }

  // Resumo por conta (cards estilo QuickBooks)
  const { data: accounts } = await serviceDb().from('bank_accounts')
    .select('id, name, type').eq('client_id', clientId).eq('active', true).order('name')
  let allQ = serviceDb().from('bank_transactions')
    .select('account_id, status, tx_date, balance, fiscal_year')
    .eq('client_id', clientId).limit(10000)
  if (year) allQ = allQ.eq('fiscal_year', parseInt(year))
  const { data: allTx } = await allQ
  const accountCards = (accounts || []).map(a => {
    const list = (allTx || []).filter(t => t.account_id === a.id)
    const latest = list.filter(t => t.balance != null)
      .sort((x, y) => (y.tx_date as string).localeCompare(x.tx_date as string))[0]
    return {
      id: a.id, name: a.name, type: a.type,
      total: list.length,
      forReview: list.filter(t => ['pending','auto'].includes(t.status)).length,
      inRegister: list.filter(t => ['approved','reviewed'].includes(t.status)).length,
      lastBalance: latest?.balance ?? null,
      lastDate: latest?.tx_date ?? null,
    }
  })

  return NextResponse.json({ transactions: txs, summary, accounts: accountCards })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const { ids, action } = await req.json()
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000) {
    return NextResponse.json({ error: 'ids (1-1000) obrigatório' }, { status: 400 })
  }
  if (!['approve','unmatch','exclude','restore'].includes(action)) {
    return NextResponse.json({ error: 'action inválida' }, { status: 400 })
  }

  const db = serviceDb()
  const { data: sample } = await db.from('bank_transactions').select('client_id').eq('id', ids[0]).single()
  if (!sample || !(await canAccessClient(auth, sample.client_id))) {
    return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (action === 'approve') update.status = 'approved'                      // → registro
  if (action === 'exclude') update.status = 'excluded'                      // fora dos livros
  if (action === 'restore') update.status = 'pending'                       // volta p/ revisão
  if (action === 'unmatch') {                                               // não aceitar sugestão
    update.status = 'pending'
    update.category = null; update.category_confidence = null; update.categorized_by = null
  }

  let q = db.from('bank_transactions').update(update).in('id', ids).eq('client_id', sample.client_id)
  if (action === 'approve') q = q.not('category', 'is', null)   // só aprova o que tem categoria
  const { error, count } = await q.select('id', { count: 'exact' }) as any

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, affected: count ?? ids.length })
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const { id, category, status, notes, payee } = await req.json()
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: tx } = await db.from('bank_transactions').select('client_id').eq('id', id).single()
  if (!tx) return NextResponse.json({ error: 'Transação não encontrada' }, { status: 404 })
  if (!(await canAccessClient(auth, tx.client_id))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (category !== undefined) {
    update.category = category
    update.categorized_by = 'staff'
    update.status = 'reviewed'
    // Criação de regra agora é decisão explícita do usuário (modal estilo QuickBooks)
  }
  if (status && ['pending','auto','reviewed','excluded'].includes(status)) update.status = status
  if (notes !== undefined) update.notes = notes
  if (payee !== undefined) {
    const cleanPayee = String(payee).trim().slice(0, 120) || null
    update.payee = cleanPayee
    if (cleanPayee) {
      const { data: txFull } = await db.from('bank_transactions').select('amount').eq('id', id).single()
      await db.from('payees').upsert(
        { client_id: tx.client_id, name: cleanPayee, type: Number(txFull?.amount ?? -1) > 0 ? 'customer' : 'vendor' },
        { onConflict: 'client_id,name' }
      ).then(() => null, () => null)
    }
  }

  const { error } = await db.from('bank_transactions').update(update).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const documentId = req.nextUrl.searchParams.get('documentId')
  if (!documentId) return NextResponse.json({ error: 'documentId obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: sample } = await db.from('bank_transactions')
    .select('client_id').eq('statement_document_id', documentId).limit(1).maybeSingle()
  if (sample && !(await canAccessClient(auth, sample.client_id))) {
    return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
  }

  const { error, count } = await db.from('bank_transactions')
    .delete({ count: 'exact' })
    .eq('statement_document_id', documentId)
    .neq('status', 'reviewed')   // não apaga o que a equipe já revisou

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, deleted: count ?? 0 })
}
