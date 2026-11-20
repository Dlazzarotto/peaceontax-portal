// GET    /api/bookkeeping/transactions?clientId=&year=&accountId=&grupo=
//        — a lista de UMA aba (grupo: recognized · unrecognized · register ·
//          excluded), até LIMITE_DA_LISTA, e os números da tela contados
//          sobre TUDO: abas, resumo, cartões das contas, anos e extratos já
//          importados (lib/lista-de-lancamentos.ts)
// PATCH  /api/bookkeeping/transactions { id, category?, status?, notes? } — edita (equipe)
// DELETE /api/bookkeeping/transactions?documentId=...  — apaga transações de um extrato (reprocessar)
//
// A lista pedia `.limit(8000)` e o PostgREST corta em MIL, sem avisar; a tela
// tirava dela as abas, o total, os cartões, os anos do seletor e os extratos
// importados. Com 24 meses de Plaid, "não carrega antes de 20/05/2025" era o
// corte — e o ano anterior nem aparecia para escolher. Agora o teto é
// declarado, os números saem de uma leitura leve e paginada de tudo, e a
// resposta diz quantas há (`lista.total`), para a tela avisar.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { todasAsLinhas } from '@/lib/paginar'
import {
  STATUS_DO_GRUPO, LIMITE_DA_LISTA, ehGrupo, resumirLancamentos, anosEntre, cartaoVazio, type LinhaLeve,
} from '@/lib/lista-de-lancamentos'

// A leitura leve de um cliente com anos de extrato são várias páginas de mil.
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const accountId = sp.get('accountId')
  const year = sp.get('year')
  const ano = year ? parseInt(year, 10) : null
  if (year && !Number.isFinite(ano)) return NextResponse.json({ error: 'Ano inválido' }, { status: 400 })
  const grupo = sp.get('grupo')
  if (grupo && !ehGrupo(grupo)) return NextResponse.json({ error: 'Aba inválida' }, { status: 400 })
  const status = sp.get('status')

  const db = serviceDb()

  // 1. A lista de UMA aba, até o teto — mais recentes primeiro.
  let q = db.from('bank_transactions').select('*').eq('client_id', clientId)
  if (accountId) q = q.eq('account_id', accountId)
  if (ano) q = q.eq('fiscal_year', ano)
  if (grupo && ehGrupo(grupo)) q = q.in('status', [...STATUS_DO_GRUPO[grupo]])
  else if (status) q = q.eq('status', status)
  q = q.order('tx_date', { ascending: false }).order('id', { ascending: false }).limit(LIMITE_DA_LISTA)

  // 2. Os números da tela, sobre TUDO do ano (todas as contas): leve e paginado.
  const leve = () => {
    let x = db.from('bank_transactions').select('account_id, status, amount, tx_date, balance').eq('client_id', clientId)
    if (ano) x = x.eq('fiscal_year', ano)
    return x
  }
  // 3. Os anos que EXISTEM — não os da lista que a tela recebe.
  const ponta = (ascending: boolean) => db.from('bank_transactions').select('fiscal_year')
    .eq('client_id', clientId).not('fiscal_year', 'is', null)
    .order('fiscal_year', { ascending }).limit(1)
  // 4. Extratos já importados, de todos os anos (o "✓ Importado" da aba Extratos).
  const extratos = () => db.from('bank_transactions').select('statement_document_id')
    .eq('client_id', clientId).not('statement_document_id', 'is', null)

  const [lista, linhas, primeiro, ultimo, docs, contas] = await Promise.all([
    q,
    todasAsLinhas<LinhaLeve>(leve),
    ponta(true),
    ponta(false),
    todasAsLinhas<{ statement_document_id: string }>(extratos),
    db.from('bank_accounts').select('id, name, type').eq('client_id', clientId).eq('active', true).order('name'),
  ])
  // Consulta que falha não vira lista vazia nem contagem zero: é o número que
  // a tela mostraria como verdade.
  const falhou = ([['a lista', lista.error], ['as contagens', linhas.error], ['os anos', primeiro.error || ultimo.error],
    ['os extratos importados', docs.error], ['as contas', contas.error]] as const).find(([, e]) => e)
  if (falhou) return NextResponse.json({ error: `Falhou ao ler ${falhou[0]}: ${(falhou[1] as any).message}` }, { status: 500 })

  const resumo = resumirLancamentos(linhas.data, accountId)
  const txs = lista.data || []
  // O total da aba pedida, com os mesmos filtros da lista.
  const total = grupo && ehGrupo(grupo) ? resumo.contagens[grupo]
    : status ? (linhas.data || []).filter(t => (!accountId || t.account_id === accountId) && t.status === status).length
    : resumo.contagens.total

  return NextResponse.json({
    transactions: txs,
    lista: { mostrando: txs.length, total, limite: LIMITE_DA_LISTA, maisAntiga: txs.length ? txs[txs.length - 1].tx_date : null },
    contagens: resumo.contagens,
    summary: resumo.summary,
    accounts: (contas.data || []).map((a: any) => ({ id: a.id, name: a.name, type: a.type, ...(resumo.cartoes[a.id] || cartaoVazio()) })),
    anos: anosEntre(primeiro.data?.[0]?.fiscal_year, ultimo.data?.[0]?.fiscal_year),
    extratosImportados: Array.from(new Set((docs.data || []).map(d => d.statement_document_id).filter(Boolean))),
  })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const { ids, action } = await req.json()
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000) {
    return NextResponse.json({ error: 'ids (1-1000) obrigatório' }, { status: 400 })
  }
  if (!['approve','unmatch','exclude','restore','reopen'].includes(action)) {
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
  if (action === 'reopen') update.status = 'auto'                       // registro → revisão (mantém categoria)
  if (action === 'unmatch') {                                               // não aceitar sugestão
    update.status = 'pending'
    update.category = null; update.category_confidence = null; update.categorized_by = null
  }

  let q = db.from('bank_transactions').update(update, { count: 'exact' }).in('id', ids).eq('client_id', sample.client_id)
  if (action === 'approve') q = q.not('category', 'is', null)   // só aprova o que tem categoria
  const { error, count } = await q

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
