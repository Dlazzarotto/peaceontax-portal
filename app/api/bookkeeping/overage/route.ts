// GET  /api/bookkeeping/overage?clientId=...&year=YYYY — contador ANUAL de transações
//   (soma de TODAS as contas/bancos do cliente) vs limite anual do contrato
// POST /api/bookkeeping/overage { clientId, year } — cobra o excedente do ano na
//   PRÓXIMA fatura do contrato (débito do dia 5). Idempotente por ano. SÓ manager/owner.

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'

async function calcOverage(db: any, clientId: string, year: number) {
  // Plano de bookkeeping ativo
  const { data: plan } = await db.from('payment_plans')
    .select('id, included_transactions, overage_rate, stripe_customer_id, stripe_subscription_id, status')
    .eq('client_id', clientId).eq('kind', 'bookkeeping')
    .in('status', ['active', 'paused', 'payment_failed'])
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle()

  // Contador anual: TODAS as contas (checking, savings, cartões), ano fiscal inteiro
  const { count } = await db.from('bank_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('fiscal_year', year)
    .neq('status', 'excluded')

  if (!plan) return { total: count ?? 0, included: null, overage: 0, rate: null, charge: 0, plan: null }
  if (!plan.included_transactions) return { total: count ?? 0, included: null, overage: 0, rate: null, charge: 0, plan }

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
  const year = parseInt(req.nextUrl.searchParams.get('year') || '')
  if (!clientId || !year) {
    return NextResponse.json({ error: 'clientId e year obrigatórios' }, { status: 400 })
  }
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const result = await calcOverage(serviceDb(), clientId, year)
  if ('error' in result) return NextResponse.json(result, { status: 404 })
  const { plan, ...rest } = result as any
  return NextResponse.json({ ...rest, hasPlan: !!plan })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return NextResponse.json({ error: 'Somente manager/owner' }, { status: 403 })
  }

  const { clientId, year } = await req.json()
  if (!clientId || !year) {
    return NextResponse.json({ error: 'clientId e year obrigatórios' }, { status: 400 })
  }
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const result = await calcOverage(db, clientId, year)
  if ('error' in result) return NextResponse.json(result, { status: 404 })
  const { plan, overage, rate, charge, total, included } = result as any

  if (!plan) return NextResponse.json({ error: 'Sem contrato de bookkeeping ativo' }, { status: 409 })
  if (!included) return NextResponse.json({ error: 'Contrato sem limite anual definido' }, { status: 409 })
  if (overage <= 0) return NextResponse.json({ error: 'Sem excedente neste ano' }, { status: 409 })
  if (!plan.stripe_customer_id || !plan.stripe_subscription_id) {
    return NextResponse.json({ error: 'Contrato sem assinatura Stripe ativa' }, { status: 409 })
  }

  // Idempotência: já cobrado este mês?
  const { data: prior } = await db.from('plan_audit')
    .select('id').eq('plan_id', plan.id)
    .eq('action', `overage_charged_${year}`).maybeSingle()
  if (prior) return NextResponse.json({ error: `Excedente de ${year} já foi cobrado` }, { status: 409 })

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
      description: `Annual transaction overage ${year}: ${overage} × $${rate.toFixed(2)} (${total} of ${included} included, all accounts)`,
    })

    await db.from('plan_audit').insert({
      plan_id: plan.id, action: `overage_charged_${year}`,
      performed_by: auth.userId,
      snapshot: { year, total, included, overage, rate, charge },
    })

    return NextResponse.json({ ok: true, overage, charge, message: `$${charge.toFixed(2)} adicionado à próxima fatura (dia 5)` })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
