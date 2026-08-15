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

  const linhas = itens.map((i: any, idx: number) => ({
    invoice_id: inv.id,
    service_id: i.serviceId || null,
    description: String(i.description).trim(),
    qty: Number(i.qty) || 1,
    unit_price: round2(i.unitPrice),
    amount: round2((Number(i.qty) || 1) * (Number(i.unitPrice) || 0)),
    sort: idx,
  }))
  const { error: itErr } = await db.from('invoice_items').insert(linhas)
  if (itErr) return NextResponse.json({ error: itErr.message }, { status: 500 })

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

  const { id, action } = await req.json()
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
