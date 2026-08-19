// /api/billing/invoices
//
// GET    ?doc=&status=&clientId=   → lista + clientes + suas permissões
// POST   { clientId, docType, dueDate, paymentPlan, expectedMethod, discount, notes, items[] }
// PATCH  { id, action: 'send' | 'cancel' | 'duplicate' }
// DELETE ?id=
//
// Permissões (lib/billing-perms):
//   assistente → SÓ cria (nasce rascunho)
//   gerente    → envia, recebe, duplica, cancela, apaga
//   sócio      → tudo + relatórios

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { permissoesFinanceiro, RECUSA } from '@/lib/billing-perms'

export const dynamic = 'force-dynamic'

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)

  const sp = req.nextUrl.searchParams
  const db = serviceDb()

  // Uma fatura específica, com itens — usado pela tela de edição
  const umId = sp.get('id')
  if (umId) {
    const [{ data: doc }, { data: itens }] = await Promise.all([
      db.from('invoices').select('*').eq('id', umId).single(),
      db.from('invoice_items').select('*').eq('invoice_id', umId).order('sort'),
    ])
    if (!doc) return NextResponse.json({ error: 'Documento não encontrado' }, { status: 404 })
    return NextResponse.json({ invoice: doc, items: itens || [], perms })
  }

  let q = db.from('invoices')
    .select('id, client_id, doc_type, number, status, issue_date, due_date, total, paid_total, payment_plan, expected_method, financier, notes, clients(business_name, name)')
    .order('issue_date', { ascending: false })
    .order('number', { ascending: false })
    .limit(400)

  if (sp.get('doc')) q = q.eq('doc_type', sp.get('doc'))
  if (sp.get('status')) q = q.eq('status', sp.get('status'))
  if (sp.get('clientId')) q = q.eq('client_id', sp.get('clientId'))

  const [{ data: invoices, error }, { data: clients }, { data: services }] = await Promise.all([
    q,
    db.from('clients').select('id, business_name, name').eq('active', true).order('name'),
    db.from('pricing_items').select('id, code, label, amount, kind').eq('active', true).order('sort').order('label'),
  ])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    invoices: (invoices || []).map((i: any) => ({
      ...i,
      cliente: i.clients?.business_name || i.clients?.name || '—',
      saldo: round2(Number(i.total) - Number(i.paid_total)),
    })),
    clients: (clients || []).map((c: any) => ({ id: c.id, nome: c.business_name || c.name })),
    // Catálogo de preços (tela Preços) — fonte única para os itens da fatura
    services: (services || []).map((x: any) => ({
      id: x.id, nome: x.label, preco: Number(x.amount) || 0, code: x.code, kind: x.kind,
    })),
    perms,
  })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)

  const b = await req.json()
  const itens = Array.isArray(b.items) ? b.items.filter((i: any) => String(i.description || '').trim()) : []
  if (!b.clientId) return NextResponse.json({ error: 'Escolha o cliente.' }, { status: 400 })
  if (itens.length === 0) return NextResponse.json({ error: 'Inclua ao menos um item.' }, { status: 400 })

  const docType = b.docType === 'estimate' ? 'estimate' : 'invoice'
  const desconto = perms.darDesconto ? round2(b.discount) : 0
  if (!perms.darDesconto && Number(b.discount) > 0) {
    return NextResponse.json({ error: RECUSA.desconto }, { status: 403 })
  }

  const subtotal = round2(itens.reduce((s: number, i: any) =>
    s + (Number(i.qty) || 1) * (Number(i.unitPrice) || 0), 0))
  const total = round2(subtotal - desconto)
  if (total < 0) return NextResponse.json({ error: 'O desconto é maior que o valor dos itens.' }, { status: 400 })

  const db = serviceDb()
  const { data: num, error: numErr } = await db.rpc('next_invoice_number', { p_kind: docType })
  if (numErr) return NextResponse.json({ error: `Numeração: ${numErr.message}` }, { status: 500 })

  const { data: inv, error } = await db.from('invoices').insert({
    client_id: b.clientId,
    doc_type: docType,
    number: num,
    status: 'draft',                       // nasce rascunho, sempre
    due_date: b.dueDate || null,
    subtotal, discount: desconto, total,
    payment_plan: b.paymentPlan || 'full',
    expected_method: b.expectedMethod || null,
    financier: b.financier || null,
    notes: b.notes || null,
    created_by: auth.userId,
  }).select('id, number').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // O item guarda descrição e preço praticados. A referência ao catálogo é
  // apenas informativa — se o id não existir mais, gravamos sem ela em vez
  // de derrubar a fatura inteira por integridade referencial.
  const idsPedidos = itens.map((i: any) => i.serviceId).filter(Boolean)
  let idsValidos = new Set<string>()
  if (idsPedidos.length) {
    const { data: cat } = await db.from('pricing_items').select('id').in('id', idsPedidos)
    idsValidos = new Set((cat || []).map((c: any) => c.id))
  }

  const linhas = itens.map((i: any, idx: number) => ({
    invoice_id: inv.id,
    service_id: i.serviceId && idsValidos.has(i.serviceId) ? i.serviceId : null,
    description: String(i.description).trim(),
    qty: Number(i.qty) || 1,
    unit_price: round2(i.unitPrice),
    amount: round2((Number(i.qty) || 1) * (Number(i.unitPrice) || 0)),
    sort: idx,
  }))
  const { error: itErr } = await db.from('invoice_items').insert(linhas)
  if (itErr) {
    // Sem itens a fatura não serve para nada: desfaz para não sobrar documento vazio
    await db.from('invoices').delete().eq('id', inv.id)
    return NextResponse.json({ error: `Itens: ${itErr.message}` }, { status: 500 })
  }

  // ── Parcelamento: gera o cronograma ──
  let parcelas = 0
  if (b.paymentPlan === 'installments') {
    const n = Math.max(2, Math.min(36, Number(b.installments) || 0))
    if (!b.firstDueDate) {
      return NextResponse.json({ error: 'Informe o vencimento da primeira parcela.' }, { status: 400 })
    }
    if (!['card', 'ach'].includes(String(b.expectedMethod || ''))) {
      return NextResponse.json({
        error: 'Parcelamento exige cartão ou débito em conta (ACH). Dinheiro, Zelle e Venmo são à vista.',
      }, { status: 400 })
    }

    const base = Math.floor((total / n) * 100) / 100
    const linhas: any[] = []
    for (let i = 0; i < n; i++) {
      const d = new Date(`${b.firstDueDate}T12:00:00Z`)
      d.setMonth(d.getMonth() + i)
      linhas.push({
        invoice_id: inv.id,
        seq: i + 1,
        due_date: d.toISOString().slice(0, 10),
        // a última parcela absorve o centavo da divisão
        amount: i === n - 1 ? round2(total - base * (n - 1)) : base,
      })
    }
    const { error: pErr } = await db.from('invoice_installments').insert(linhas)
    if (pErr) return NextResponse.json({ error: `Parcelas: ${pErr.message}` }, { status: 500 })
    parcelas = n
    await db.from('invoices').update({ due_date: linhas[0].due_date }).eq('id', inv.id)
  }

  await db.from('invoice_audit').insert({
    invoice_id: inv.id, action: 'created', performed_by: auth.userId,
    staff_level: perms.nivel, next: { number: inv.number, total },
  }).then(() => null, () => null)

  return NextResponse.json({
    ok: true, id: inv.id, number: inv.number,
    message: `${docType === 'estimate' ? 'Orçamento' : 'Fatura'} ${inv.number} criado como rascunho`
      + (parcelas ? ` · ${parcelas} parcelas geradas` : '') + '.',
  })
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)

  // Ler o corpo UMA vez: depois de consumido não dá para clonar
  const corpo = (await req.json()) as any
  const { id, action } = corpo
  if (!id || !action) return NextResponse.json({ error: 'id e action obrigatórios' }, { status: 400 })

  const db = serviceDb()
  const { data: inv } = await db.from('invoices').select('*').eq('id', id).single()
  if (!inv) return NextResponse.json({ error: 'Documento não encontrado' }, { status: 404 })

  if (action === 'send') {
    if (!perms.cancelar) return NextResponse.json({ error: 'Enviar ao cliente é de gerente ou sócio.' }, { status: 403 })
    if (inv.status !== 'draft') return NextResponse.json({ error: 'Só rascunho pode ser enviado.' }, { status: 400 })
    await db.from('invoices').update({ status: 'sent', updated_at: new Date().toISOString() }).eq('id', id)
    await db.from('invoice_audit').insert({ invoice_id: id, action: 'sent', performed_by: auth.userId, staff_level: perms.nivel }).then(() => null, () => null)
    return NextResponse.json({ ok: true, message: `${inv.number} marcado como enviado.` })
  }

  if (action === 'cancel') {
    if (!perms.cancelar) return NextResponse.json({ error: RECUSA.cancelar }, { status: 403 })
    if (Number(inv.paid_total) > 0) {
      return NextResponse.json({ error: 'Já há pagamento registrado. Estorne o pagamento antes de cancelar.' }, { status: 409 })
    }
    await db.from('invoices').update({ status: 'void', updated_at: new Date().toISOString() }).eq('id', id)
    await db.from('invoice_audit').insert({ invoice_id: id, action: 'canceled', performed_by: auth.userId, staff_level: perms.nivel, previous: { status: inv.status } }).then(() => null, () => null)
    return NextResponse.json({ ok: true, message: `${inv.number} cancelado (permanece no histórico).` })
  }

  if (action === 'edit') {
    if (!perms.editar) return NextResponse.json({ error: RECUSA.editar }, { status: 403 })
    if (Number(inv.paid_total) > 0) {
      return NextResponse.json({
        error: 'Fatura com pagamento registrado não pode ser editada. Estorne o pagamento ou emita nota de ajuste.',
      }, { status: 409 })
    }
    if (inv.status === 'void') {
      return NextResponse.json({ error: 'Fatura cancelada não pode ser editada.' }, { status: 409 })
    }

    const b2 = corpo
    const motivo = String(b2.reason || '').trim()

    // Gerente confirma com senha e justifica; sócio edita direto
    if (perms.senhaNaEdicao) {
      if (motivo.length < 5) {
        return NextResponse.json({ error: 'Descreva o motivo da alteração (mínimo 5 caracteres).' }, { status: 400 })
      }
      if (!b2.password) return NextResponse.json({ error: 'Confirme com a sua senha.' }, { status: 400 })

      const { data: quem } = await db.auth.admin.getUserById(auth.userId)
      const email = quem?.user?.email
      if (!email) return NextResponse.json({ error: 'Não foi possível identificar seu login.' }, { status: 400 })

      const sbAuth = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      )
      const { error: pwErr } = await sbAuth.auth.signInWithPassword({
        email, password: String(b2.password).trim(),
      })
      if (pwErr) {
        const m = pwErr.message || ''
        if (/rate|too many|429/i.test(m)) {
          return NextResponse.json({ error: 'Muitas tentativas. Aguarde 1 minuto.' }, { status: 429 })
        }
        return NextResponse.json({ error: `Senha não confere para ${email}.` }, { status: 401 })
      }
    }

    const itens2 = Array.isArray(b2.items)
      ? b2.items.filter((i: any) => String(i.description || '').trim()) : []
    if (itens2.length === 0) return NextResponse.json({ error: 'A fatura precisa de ao menos um item.' }, { status: 400 })

    const desconto2 = perms.darDesconto ? round2(b2.discount) : Number(inv.discount)
    const subtotal2 = round2(itens2.reduce((s2: number, i: any) =>
      s2 + (Number(i.qty) || 1) * (Number(i.unitPrice) || 0), 0))
    const total2 = round2(subtotal2 - desconto2)
    if (total2 < 0) return NextResponse.json({ error: 'O desconto é maior que o valor dos itens.' }, { status: 400 })

    const anterior = { total: Number(inv.total), discount: Number(inv.discount), due_date: inv.due_date, notes: inv.notes }

    const { error: upErr } = await db.from('invoices').update({
      due_date: b2.dueDate || null,
      subtotal: subtotal2, discount: desconto2, total: total2,
      expected_method: b2.expectedMethod || null,
      notes: b2.notes ?? inv.notes,
      updated_at: new Date().toISOString(),
    }).eq('id', id)
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

    // Itens são reescritos: mais simples e sem risco de sobra
    await db.from('invoice_items').delete().eq('invoice_id', id)
    const idsPedidos2 = itens2.map((i: any) => i.serviceId).filter(Boolean)
    let validos2 = new Set<string>()
    if (idsPedidos2.length) {
      const { data: cat } = await db.from('pricing_items').select('id').in('id', idsPedidos2)
      validos2 = new Set((cat || []).map((c: any) => c.id))
    }
    await db.from('invoice_items').insert(itens2.map((i: any, idx: number) => ({
      invoice_id: id,
      service_id: i.serviceId && validos2.has(i.serviceId) ? i.serviceId : null,
      description: String(i.description).trim(),
      qty: Number(i.qty) || 1,
      unit_price: round2(i.unitPrice),
      amount: round2((Number(i.qty) || 1) * (Number(i.unitPrice) || 0)),
      sort: idx,
    })))

    await db.from('invoice_audit').insert({
      invoice_id: id, action: 'edited', performed_by: auth.userId,
      staff_level: perms.nivel, reason: motivo || null,
      previous: anterior, next: { total: total2, discount: desconto2, due_date: b2.dueDate || null },
    }).then(() => null, () => null)

    return NextResponse.json({ ok: true, message: `${inv.number} atualizada (${total2.toFixed(2)}).` })
  }

  if (action === 'duplicate') {
    if (!perms.duplicar) return NextResponse.json({ error: RECUSA.duplicar }, { status: 403 })
    const { data: num } = await db.rpc('next_invoice_number', { p_kind: inv.doc_type })
    const { data: novo, error } = await db.from('invoices').insert({
      client_id: inv.client_id, doc_type: inv.doc_type, number: num, status: 'draft',
      due_date: null, subtotal: inv.subtotal, discount: inv.discount, total: inv.total,
      payment_plan: inv.payment_plan, expected_method: inv.expected_method,
      financier: inv.financier, notes: inv.notes, converted_from: inv.id, created_by: auth.userId,
    }).select('id, number').single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const { data: itens } = await db.from('invoice_items').select('*').eq('invoice_id', id)
    if (itens && itens.length) {
      await db.from('invoice_items').insert(itens.map((i: any) => ({
        invoice_id: novo.id, service_id: i.service_id, description: i.description,
        qty: i.qty, unit_price: i.unit_price, amount: i.amount, sort: i.sort,
      })))
    }
    return NextResponse.json({ ok: true, message: `Cópia criada: ${novo.number} (rascunho).` })
  }

  return NextResponse.json({ error: 'Ação desconhecida' }, { status: 400 })
}

export async function DELETE(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  if (!perms.apagar) return NextResponse.json({ error: RECUSA.apagar }, { status: 403 })

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: inv } = await db.from('invoices').select('number, paid_total').eq('id', id).single()
  if (!inv) return NextResponse.json({ error: 'Documento não encontrado' }, { status: 404 })
  if (Number(inv.paid_total) > 0) {
    return NextResponse.json({ error: 'Documento com pagamento não pode ser apagado — cancele.' }, { status: 409 })
  }

  const { error } = await db.from('invoices').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, message: `${inv.number} apagado.` })
}
