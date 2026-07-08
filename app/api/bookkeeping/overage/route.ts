// GET  /api/bookkeeping/overage?clientId=...&month=YYYY-MM — calcula o excedente do mês
// POST /api/bookkeeping/overage { clientId, month } — cobra o excedente na PRÓXIMA fatura
//   do contrato de bookkeeping (InvoiceItem no Stripe, entra no débito do dia 5).
//   SÓ manager/owner cobram.

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'

async function calcOverage(db: any, clientId: string, month: string) {
  // Plano de bookkeeping ativo
  const { data: plan } = await db.from('payment_plans')
    .select('id, included_transactions, overage_rate, stripe_customer_id, stripe_subscription_id, status')
    .eq('client_id', clientId).eq('kind', 'bookkeeping')
    .in('status', ['active', 'paused', 'payment_failed'])
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle()

  if (!plan) return { error: 'Sem contrato de bookkeeping ativo para este cliente' }
  if (!plan.included_transactions) return { error: 'Contrato sem limite de transações definido' }

  const [y, m] = month.split('-').map(Number)
  const start = `${month}-01`
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10) // 1º do mês seguinte

  const { count } = await db.from('bank_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .gte('tx_date', start).lt('tx_date', end)
    .neq('status', 'excluded')

  const total = count ?? 0
  const included = plan.included_transactions
  const overage = Math.max(0, total - included)
  const rate = Number(plan.overage_rate ?? 1.25)
  const charge = Math.round(overage * rate * 100) / 100

  return { plan, total, included, overage, rate, charge }
}

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const clientId = req.nextUrl.searchParams.get('clientId')
  const month = req.nextUrl.searchParams.get('month')   // YYYY-MM
  if (!clientId || !month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: 'clientId e month (YYYY-MM) obrigatórios' }, { status: 400 })
  }
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const result = await calcOverage(serviceDb(), clientId, month)
  if ('error' in result) return NextResponse.json(result, { status: 404 })
  const { plan, ...rest } = result as any
  return NextResponse.json(rest)
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return NextResponse.json({ error: 'Somente manager/owner' }, { status: 403 })
  }

  const { clientId, month } = await req.json()
  if (!clientId || !month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: 'clientId e month (YYYY-MM) obrigatórios' }, { status: 400 })
  }
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const result = await calcOverage(db, clientId, month)
  if ('error' in result) return NextResponse.json(result, { status: 404 })
  const { plan, overage, rate, charge, total, included } = result as any

  if (overage <= 0) return NextResponse.json({ error: 'Sem excedente neste mês' }, { status: 409 })
  if (!plan.stripe_customer_id || !plan.stripe_subscription_id) {
    return NextResponse.json({ error: 'Contrato sem assinatura Stripe ativa' }, { status: 409 })
  }

  // Idempotência: já cobrado este mês?
  const { data: prior } = await db.from('plan_audit')
    .select('id').eq('plan_id', plan.id)
    .eq('action', `overage_charged_${month}`).maybeSingle()
  if (prior) return NextResponse.json({ error: `Excedente de ${month} já foi cobrado` }, { status: 409 })

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-06-24.dahlia' as Stripe.LatestApiVersion,
  })

  try {
    // Item entra na PRÓXIMA fatura da assinatura (débito do dia 5)
    await stripe.invoiceItems.create({
      customer: plan.stripe_customer_id,
      subscription: plan.stripe_subscription_id,
      amount: Math.round(charge * 100),
      currency: 'usd',
      description: `Transaction overage ${month}: ${overage} × $${rate.toFixed(2)} (${total} of ${included} included)`,
    })

    await db.from('plan_audit').insert({
      plan_id: plan.id, action: `overage_charged_${month}`,
      performed_by: auth.userId,
      snapshot: { month, total, included, overage, rate, charge },
    })

    return NextResponse.json({ ok: true, overage, charge, message: `$${charge.toFixed(2)} adicionado à próxima fatura (dia 5)` })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
