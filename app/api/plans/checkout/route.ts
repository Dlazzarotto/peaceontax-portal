// POST /api/plans/checkout — gera o link de pagamento do plano
// Body: { planId }
// installment → Checkout mode 'payment' da ENTRADA, salvando o método p/ débitos futuros
// bookkeeping/monthly → Checkout mode 'subscription' ancorada no DIA ACORDADO (plan.due_day)

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { nextBillingDayET, normalizarDiaCobranca } from '@/lib/plans'

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://peaceontax-portal.vercel.app'

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return NextResponse.json({ error: 'Somente manager/owner' }, { status: 403 })
  }

  const { planId } = await req.json()
  if (!planId) return NextResponse.json({ error: 'planId obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: plan } = await db
    .from('payment_plans')
    .select('*, clients(name, email, language)')
    .eq('id', planId)
    .single()

  if (!plan) return NextResponse.json({ error: 'Plano não encontrado' }, { status: 404 })
  if (!['draft','awaiting_entry','awaiting_setup'].includes(plan.status)) {
    return NextResponse.json({ error: `Plano em status '${plan.status}' não gera novo link` }, { status: 409 })
  }

  const client = plan.clients as any
  const lang = client?.language || 'en'
  const locale = lang === 'pt' ? 'pt-BR' : lang === 'es' ? 'es' : lang === 'zh' ? 'zh' : lang === 'fr' ? 'fr' : 'en'
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' as Stripe.LatestApiVersion })

  try {
    // Cliente Stripe reutilizável (necessário para débitos futuros)
    let customerId = plan.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: client?.name, email: client?.email || undefined,
        metadata: { clientId: plan.client_id },
      })
      customerId = customer.id
    }

    let session: Stripe.Checkout.Session

    if (plan.kind === 'installment') {
      // ENTRADA — pagamento único que salva o método para as parcelas futuras
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        payment_method_types: ['card', 'us_bank_account'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: lang === 'pt'
                ? `Entrada (${plan.entry_pct}%) — ${plan.description || 'Serviços Peace on Tax'}`
                : `Down payment (${plan.entry_pct}%) — ${plan.description || 'Peace on Tax services'}`,
            },
            unit_amount: Math.round(Number(plan.entry_amount) * 100),
          },
          quantity: 1,
        }],
        payment_intent_data: {
          setup_future_usage: 'off_session',   // salva o método + mandato ACH p/ parcelas
          metadata: { planId, planKind: 'installment_entry' },
        },
        metadata: { planId, planKind: 'installment_entry', clientId: plan.client_id },
        success_url: `${BASE_URL}/portal?plan=entry_success`,
        cancel_url: `${BASE_URL}/portal?plan=cancelled`,
        locale: locale as Stripe.Checkout.SessionCreateParams.Locale,
      })

      await db.from('payment_plans').update({
        stripe_customer_id: customerId,
        stripe_session_id: session.id,
        status: 'awaiting_entry',
        updated_at: new Date().toISOString(),
      }).eq('id', planId)

    } else {
      // BOOKKEEPING / MENSAL — ancorada no dia acordado com o cliente.
      // O trial vai até a data-base: a 1ª cobrança cai exatamente nela,
      // e o Stripe repete no mesmo dia nos meses seguintes.
      const dia = normalizarDiaCobranca(plan.due_day)
      const anchor = nextBillingDayET(dia)
      session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        payment_method_types: ['card', 'us_bank_account'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: plan.description || (plan.kind === 'monthly'
                ? (lang === 'pt' ? 'Serviço mensal — Peace on Tax' : 'Monthly service — Peace on Tax')
                : (lang === 'pt' ? 'Bookkeeping mensal — Peace on Tax' : 'Monthly bookkeeping — Peace on Tax')),
            },
            unit_amount: Math.round(Number(plan.monthly_amount) * 100),
            recurring: { interval: 'month', interval_count: 1 },
          },
          quantity: 1,
        }],
        subscription_data: {
          trial_end: Math.floor(anchor.getTime() / 1000),  // 1ª cobrança no próximo dia 5
          metadata: { planId, planKind: 'bookkeeping' },
        },
        metadata: { planId, planKind: 'bookkeeping', clientId: plan.client_id },
        success_url: `${BASE_URL}/portal?plan=subscription_success`,
        cancel_url: `${BASE_URL}/portal?plan=cancelled`,
        locale: locale as Stripe.Checkout.SessionCreateParams.Locale,
      })

      await db.from('payment_plans').update({
        stripe_customer_id: customerId,
        stripe_session_id: session.id,
        status: 'awaiting_setup',
        next_charge_date: anchor.toISOString().slice(0, 10),
        updated_at: new Date().toISOString(),
      }).eq('id', planId)
    }

    await db.from('plan_audit').insert({
      plan_id: planId, action: 'checkout_link_created', performed_by: auth.userId,
      snapshot: { sessionId: session.id, kind: plan.kind, dueDay: plan.due_day ?? null },
    })

    return NextResponse.json({ url: session.url, sessionId: session.id })
  } catch (e) {
    console.error('Plan checkout error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
