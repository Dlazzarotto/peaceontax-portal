// /api/bookkeeping/payees
//
// GET    ?clientId=            → fornecedores/clientes com uso real
//                                (quantos lançamentos, total, conta mais usada)
// POST   { clientId, name, type }                 → cria/atualiza (como antes)
// PATCH  { clientId, name, newName?, type?, category? }
//          category → reclassifica os lançamentos DESTE payee para a conta
//          newName  → renomeia o payee nos lançamentos também
// DELETE ?clientId=&name=&limpar=1
//          remove do cadastro; com limpar=1 apaga o payee dos lançamentos
//
// Registro aprovado nunca é alterado por aqui — só o que aguarda aprovação.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

async function todasTransacoes(db: any, clientId: string) {
  const linhas: any[] = []
  for (let i = 0; ; i += 10000) {
    const { data } = await db.from('bank_transactions')
      .select('payee, category, amount, status')
      .eq('client_id', clientId)
      .not('payee', 'is', null)
      .range(i, i + 9999)
    if (!data || data.length === 0) break
    linhas.push(...data)
    if (data.length < 10000) break
  }
  return linhas
}

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const clientId = req.nextUrl.searchParams.get('clientId')

  // Lista geral (tela Listas → Fornecedores e clientes): todos os clientes
  if (!clientId && req.nextUrl.searchParams.get('all') === '1') {
    const dbAll = serviceDb()
    const { data, error } = await dbAll.from('payees')
      .select('id, name, type, client_id, clients(business_name, name)')
      .eq('active', true)
      .order('name')
      .limit(5000)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({
      payees: (data || []).map((p: any) => ({
        id: p.id, name: p.name, type: p.type, clientId: p.client_id,
        cliente: p.clients?.business_name || p.clients?.name || '—',
      })),
    })
  }

  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const { data, error } = await db.from('payees')
    .select('id, name, type').eq('client_id', clientId).eq('active', true)
    .order('type').order('name')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Uso real de cada payee
  const linhas = await todasTransacoes(db, clientId)
  const uso = new Map<string, { total: number; soma: number; aprovados: number; contas: Record<string, number> }>()
  for (const t of linhas) {
    const k = String(t.payee).trim().toLowerCase()
    if (!uso.has(k)) uso.set(k, { total: 0, soma: 0, aprovados: 0, contas: {} })
    const u = uso.get(k)!
    u.total++
    u.soma += Number(t.amount) || 0
    if (t.status === 'approved' || t.status === 'reviewed') u.aprovados++
    if (t.category) u.contas[t.category] = (u.contas[t.category] || 0) + 1
  }

  const payees = (data || []).map((p: any) => {
    const u = uso.get(String(p.name).trim().toLowerCase())
    const contaMaisUsada = u
      ? Object.entries(u.contas).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      : null
    return {
      ...p,
      total: u?.total ?? 0,
      soma: u ? Math.round(u.soma * 100) / 100 : 0,
      aprovados: u?.aprovados ?? 0,
      contaMaisUsada,
      contasDiferentes: u ? Object.keys(u.contas).length : 0,
    }
  })

  return NextResponse.json({ payees })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const { clientId, name, type } = await req.json()
  const clean = String(name || '').trim()
  if (!clientId || clean.length < 2) return NextResponse.json({ error: 'clientId e name obrigatórios' }, { status: 400 })
  if (!['vendor', 'customer'].includes(type)) return NextResponse.json({ error: 'type: vendor ou customer' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const { error } = await serviceDb().from('payees')
    .upsert({ client_id: clientId, name: clean, type }, { onConflict: 'client_id,name' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const { clientId, name, newName, type, category } = await req.json()
  const nome = String(name || '').trim()
  if (!clientId || !nome) return NextResponse.json({ error: 'clientId e name obrigatórios' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const partes: string[] = []

  // Trocar a conta contábil dos lançamentos deste payee
  if (category) {
    const { data: cat } = await db.from('bookkeeping_categories')
      .select('name').eq('name', category).eq('active', true).maybeSingle()
    if (!cat) return NextResponse.json({ error: 'Conta não encontrada no plano de contas.' }, { status: 400 })

    const { data: mudou } = await db.from('bank_transactions')
      .update({
        category, category_confidence: 100, categorized_by: 'staff',
        status: 'auto', updated_at: new Date().toISOString(),
      })
      .eq('client_id', clientId).ilike('payee', nome)
      .in('status', ['pending', 'auto'])
      .select('id')

    const { count: aprovados } = await db.from('bank_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId).ilike('payee', nome)
      .in('status', ['approved', 'reviewed'])

    partes.push(`${(mudou || []).length} lançamento(s) movidos para "${category}"`)
    if ((aprovados ?? 0) > 0) {
      partes.push(`${aprovados} já no registro não foram tocados (use a reclassificação com senha)`)
    }
  }

  if (type && ['vendor', 'customer'].includes(type)) {
    await db.from('payees').update({ type }).eq('client_id', clientId).ilike('name', nome)
    partes.push(`tipo alterado para ${type === 'vendor' ? 'Vendor' : 'Customer'}`)
  }

  if (newName && String(newName).trim() && String(newName).trim() !== nome) {
    const novo = String(newName).trim()
    await db.from('payees').update({ name: novo }).eq('client_id', clientId).ilike('name', nome)
    const { data: renomeados } = await db.from('bank_transactions')
      .update({ payee: novo, updated_at: new Date().toISOString() })
      .eq('client_id', clientId).ilike('payee', nome).select('id')
    await db.from('bookkeeping_rules').update({ payee: novo })
      .eq('client_id', clientId).ilike('payee', nome)
    partes.push(`renomeado para "${novo}" em ${(renomeados || []).length} lançamento(s)`)
  }

  if (partes.length === 0) return NextResponse.json({ error: 'Nada para alterar.' }, { status: 400 })
  return NextResponse.json({ ok: true, message: partes.join(' · ') })
}

export async function DELETE(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  const nome = (sp.get('name') || '').trim()
  const limpar = sp.get('limpar') === '1'
  if (!clientId || !nome) return NextResponse.json({ error: 'clientId e name obrigatórios' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const { count } = await db.from('bank_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId).ilike('payee', nome)

  if ((count ?? 0) > 0 && !limpar) {
    return NextResponse.json({
      error: `"${nome}" está em ${count} lançamento(s). Confirme se quer apagar também o nome deles.`,
      emUso: count,
    }, { status: 409 })
  }

  let limpos = 0
  if (limpar && (count ?? 0) > 0) {
    const { data } = await db.from('bank_transactions')
      .update({ payee: null, updated_at: new Date().toISOString() })
      .eq('client_id', clientId).ilike('payee', nome)
      .in('status', ['pending', 'auto']).select('id')
    limpos = (data || []).length
  }

  const { error } = await db.from('payees')
    .delete().eq('client_id', clientId).ilike('name', nome)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    message: `"${nome}" removido do cadastro`
      + (limpos ? ` · nome apagado de ${limpos} lançamento(s) em aberto` : ''),
  })
}
