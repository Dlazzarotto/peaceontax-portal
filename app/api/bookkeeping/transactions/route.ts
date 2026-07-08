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

  const year = sp.get('year')
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

  return NextResponse.json({ transactions: txs, summary })
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

    // Aprendizado: cria regra do cliente com o "merchant" da descrição
    const { data: full } = await db.from('bank_transactions').select('description').eq('id', id).single()
    if (full?.description && category) {
      const merchant = full.description
        .replace(/\d{2}\/\d{2}/g, '')            // datas
        .replace(/#?\d{4,}/g, '')                  // números longos/conf
        .replace(/x{4,}/gi, '')                    // máscaras de cartão
        .replace(/\s+/g, ' ').trim().toLowerCase()
        .split(' ').slice(0, 3).join(' ')          // 3 primeiras palavras significativas
      if (merchant.length >= 4) {
        await db.from('bookkeeping_rules').insert({
          client_id: tx.client_id, pattern: merchant, category,
          priority: 40, created_by: 'system',
        }).then(() => null, () => null)
      }
    }
  }
  if (status && ['pending','auto','reviewed','excluded'].includes(status)) update.status = status
  if (notes !== undefined) update.notes = notes
  if (payee !== undefined) update.payee = String(payee).trim().slice(0, 120) || null

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
