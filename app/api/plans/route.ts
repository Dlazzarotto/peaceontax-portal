// GET    /api/plans?clientId=...        — lista planos do cliente (equipe)
// POST   /api/plans                     — cria plano (SÓ manager/owner)
//   Parcelamento: { clientId, kind:'installment', total, entryPct, frequency, installments, description }
//   Bookkeeping:  { clientId, kind:'bookkeeping', monthlyAmount, description }
// DELETE /api/plans?id=...&reason=...   — cancela plano (manager/owner, motivo obrigatório)

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { calcInstallmentPlan } from '@/lib/plans'

async function requireManagerOrOwner(userId: string) {
  const level = await getStaffLevel(userId)
  return level === 'owner' || level === 'manager' ? level : null
}

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })

  const { data, error } = await serviceDb()
    .from('payment_plans')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const level = await getStaffLevel(auth.userId)
  return NextResponse.json({ plans: data || [], level })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const level = await requireManagerOrOwner(auth.userId)
  if (!level) return NextResponse.json({ error: 'Somente manager/owner criam planos' }, { status: 403 })

  const body = await req.json()
  const { clientId, kind, description } = body
  if (!clientId || !kind) return NextResponse.json({ error: 'clientId e kind obrigatórios' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  let payload: Record<string, unknown>

  if (kind === 'installment') {
    // Vinculado a uma cotação (Estimate)? Usa o total dela.
    let quoteId: string | null = null
    let quoteTotal: number | null = null
    let quoteDesc: string | null = null
    if (body.quoteId) {
      const { data: quote } = await db.from('quotes')
        .select('id, total, status, est_number, fiscal_year')
        .eq('id', body.quoteId).eq('client_id', clientId).single()
      if (!quote) return NextResponse.json({ error: 'Cotação não encontrada' }, { status: 404 })
      if (!['draft','sent'].includes(quote.status)) {
        return NextResponse.json({ error: `Cotação em status '${quote.status}' não pode ser parcelada` }, { status: 409 })
      }
      if (Number(quote.total) <= 0) return NextResponse.json({ error: 'Cotação sem valor' }, { status: 400 })
      // Já existe plano ativo vinculado?
      const { data: existingPlan } = await db.from('payment_plans')
        .select('id, status').eq('quote_id', quote.id)
        .not('status', 'in', '(cancelled,completed)').maybeSingle()
      if (existingPlan) return NextResponse.json({ error: 'Já existe parcelamento ativo para esta cotação' }, { status: 409 })
      quoteId = quote.id
      quoteTotal = Number(quote.total)
      quoteDesc = `Estimate ${quote.est_number || ''} — Ano fiscal ${quote.fiscal_year}`.trim()
    }

    const total = quoteTotal ?? Number(body.total)
    const entryPct = Number(body.entryPct)
    const installments = Number(body.installments)
    const frequency = body.frequency
    if (!total || total <= 0 || total > 500000) return NextResponse.json({ error: 'Total inválido' }, { status: 400 })
    if (isNaN(entryPct) || entryPct < 0 || entryPct > 90) return NextResponse.json({ error: 'Entrada deve ser 0–90%' }, { status: 400 })
    if (!installments || installments < 1 || installments > 60) return NextResponse.json({ error: 'Parcelas: 1 a 60' }, { status: 400 })
    if (!['weekly','biweekly','monthly'].includes(frequency)) return NextResponse.json({ error: 'Frequência inválida' }, { status: 400 })
    if (entryPct === 0) return NextResponse.json({ error: 'Parcelamento exige entrada — defina a % (a autorização ACH é coletada no pagamento da entrada).' }, { status: 400 })

    const calc = calcInstallmentPlan(total, entryPct, installments)
    if (calc.perInstallment < 1) return NextResponse.json({ error: 'Parcela abaixo de $1 — reduza a quantidade' }, { status: 400 })

    payload = {
      client_id: clientId, kind, total,
      entry_pct: entryPct, entry_amount: calc.entry,
      frequency, installments, installment_amount: calc.perInstallment,
      description: description || quoteDesc || null,
      quote_id: quoteId,
      status: 'draft', created_by: auth.userId,
    }
  } else if (kind === 'bookkeeping') {
    const monthlyAmount = Number(body.monthlyAmount)
    if (!monthlyAmount || monthlyAmount <= 0 || monthlyAmount > 100000) {
      return NextResponse.json({ error: 'Valor mensal inválido' }, { status: 400 })
    }
    const includedTx = Number(body.includedTransactions)
    if (!includedTx || includedTx < 1 || includedTx > 100000) {
      return NextResponse.json({ error: 'Informe a quantidade de transações incluídas no contrato' }, { status: 400 })
    }
    payload = {
      client_id: clientId, kind, monthly_amount: monthlyAmount, due_day: 5,
      included_transactions: includedTx, overage_rate: 1.25,
      description: description || 'Bookkeeping mensal',
      status: 'draft', created_by: auth.userId,
    }
  } else {
    return NextResponse.json({ error: 'kind inválido' }, { status: 400 })
  }

  const { data: plan, error } = await db.from('payment_plans').insert(payload).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await db.from('plan_audit').insert({
    plan_id: plan.id, action: 'created', performed_by: auth.userId, snapshot: payload,
  })

  return NextResponse.json({ ok: true, plan })
}

export async function DELETE(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const level = await requireManagerOrOwner(auth.userId)
  if (!level) return NextResponse.json({ error: 'Somente manager/owner cancelam planos' }, { status: 403 })

  const id = req.nextUrl.searchParams.get('id')
  const reason = req.nextUrl.searchParams.get('reason')
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })
  if (!reason?.trim()) return NextResponse.json({ error: 'Motivo do cancelamento é obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: plan } = await db.from('payment_plans').select('*').eq('id', id).single()
  if (!plan) return NextResponse.json({ error: 'Plano não encontrado' }, { status: 404 })
  if (plan.status === 'cancelled') return NextResponse.json({ error: 'Já cancelado' }, { status: 409 })

  // Cancela no Stripe se houver assinatura/agendamento ativos
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' as Stripe.LatestApiVersion })
    if (plan.stripe_schedule_id) {
      await stripe.subscriptionSchedules.cancel(plan.stripe_schedule_id).catch(() => null)
    } else if (plan.stripe_subscription_id) {
      await stripe.subscriptions.cancel(plan.stripe_subscription_id).catch(() => null)
    }
  } catch (e) {
    console.error('Stripe cancel error:', e)
  }

  await db.from('payment_plans').update({
    status: 'cancelled', cancel_reason: reason, updated_at: new Date().toISOString(),
  }).eq('id', id)

  await db.from('plan_audit').insert({
    plan_id: id, action: 'cancelled', reason, performed_by: auth.userId,
    snapshot: { previous_status: plan.status },
  })

  return NextResponse.json({ ok: true })
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await requireManagerOrOwner(auth.userId)
  if (!level) return NextResponse.json({ error: 'Somente manager/owner' }, { status: 403 })

  const body = await req.json()
  const { planId } = body
  if (!planId) return NextResponse.json({ error: 'planId obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: plan } = await db.from('payment_plans').select('*').eq('id', planId).single()
  if (!plan) return NextResponse.json({ error: 'Plano não encontrado' }, { status: 404 })
  if (!['draft','awaiting_entry','awaiting_setup'].includes(plan.status) || plan.entry_paid_at) {
    return NextResponse.json({ error: 'Plano já ativado não pode ser editado — cancele e crie outro' }, { status: 409 })
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (plan.kind === 'installment') {
    const entryPct = body.entryPct !== undefined ? Number(body.entryPct) : Number(plan.entry_pct)
    const installments = body.installments !== undefined ? Number(body.installments) : plan.installments
    const frequency = body.frequency ?? plan.frequency
    if (isNaN(entryPct) || entryPct < 1 || entryPct > 90) return NextResponse.json({ error: 'Entrada 1–90%' }, { status: 400 })
    if (!installments || installments < 1 || installments > 60) return NextResponse.json({ error: 'Parcelas 1–60' }, { status: 400 })
    if (!['weekly','biweekly','monthly'].includes(frequency)) return NextResponse.json({ error: 'Frequência inválida' }, { status: 400 })
    const calc = calcInstallmentPlan(Number(plan.total), entryPct, installments)
    Object.assign(update, {
      entry_pct: entryPct, entry_amount: calc.entry,
      frequency, installments, installment_amount: calc.perInstallment,
      status: 'draft', stripe_session_id: null,   // sessão antiga invalida
    })
  } else {
    if (body.monthlyAmount !== undefined) {
      const m = Number(body.monthlyAmount)
      if (!m || m <= 0 || m > 100000) return NextResponse.json({ error: 'Valor mensal inválido' }, { status: 400 })
      update.monthly_amount = m
    }
    if (body.includedTransactions !== undefined) {
      const tx = Number(body.includedTransactions)
      if (!tx || tx < 1) return NextResponse.json({ error: 'Transações incluídas inválido' }, { status: 400 })
      update.included_transactions = tx
    }
    update.status = 'draft'
    update.stripe_session_id = null
  }

  const { error } = await db.from('payment_plans').update(update).eq('id', planId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await db.from('plan_audit').insert({
    plan_id: planId, action: 'edited', performed_by: auth.userId, snapshot: update,
  })
  return NextResponse.json({ ok: true })
}
