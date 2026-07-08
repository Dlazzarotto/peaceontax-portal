// POST /api/stripe/webhook — PÚBLICO (assinatura verificada)
// Trata:
//   checkout.session.completed → quotes (Fase 2) + entrada de parcelamento + setup bookkeeping
//   invoice.paid               → conta parcelas pagas / registra mensalidade
//   invoice.payment_failed     → alerta a equipe (cobrança manual)
//   customer.subscription.deleted → encerra plano

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { getQueueDate } from '@/lib/pricing'
import { FREQ_STRIPE, firstInstallmentDate, type Frequency } from '@/lib/plans'

export const runtime = 'nodejs'

function adminDb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY
  if (!key) throw new Error('Service key não configurada')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key)
}

export async function POST(req: NextRequest) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-06-24.dahlia' as Stripe.LatestApiVersion,
  })

  const body = await req.text()
  const sig = req.headers.get('stripe-signature')
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!webhookSecret) return NextResponse.json({ error: 'Webhook não configurado' }, { status: 500 })

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig!, webhookSecret)
  } catch (err) {
    console.error('Webhook signature failed:', err)
    return NextResponse.json({ error: 'Assinatura inválida' }, { status: 400 })
  }

  const db = adminDb()

  try {
    // ============ CHECKOUT COMPLETO ============
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session
      const meta = session.metadata ?? {}

      // ---- Fase 2: cotação à vista ----
      if (meta.quoteId) {
        await handleQuotePaid(db, session)
        return NextResponse.json({ received: true })
      }

      // ---- Fase 4a: entrada do parcelamento ----
      if (meta.planKind === 'installment_entry' && meta.planId) {
        await handleInstallmentEntry(db, stripe, session, meta.planId)
        return NextResponse.json({ received: true })
      }

      // ---- Fase 4a: bookkeeping assinado ----
      if (meta.planKind === 'bookkeeping' && meta.planId) {
        await db.from('payment_plans').update({
          stripe_subscription_id: session.subscription as string,
          status: 'active',
          updated_at: new Date().toISOString(),
        }).eq('id', meta.planId)

        await notifyClient(db, meta.clientId, '✅ Contrato de bookkeeping ativado! A cobrança mensal ocorre todo dia 5. Obrigado pela confiança! 🙏')
        return NextResponse.json({ received: true })
      }

      return NextResponse.json({ received: true })
    }

    // ============ PARCELA / MENSALIDADE PAGA ============
    if (event.type === 'invoice.paid') {
      const invoice = event.data.object as Stripe.Invoice
      const subId = (invoice as any).subscription as string | null
      if (!subId) return NextResponse.json({ received: true })

      const { data: plan } = await db.from('payment_plans')
        .select('*').eq('stripe_subscription_id', subId).maybeSingle()
      if (!plan) return NextResponse.json({ received: true })

      // Ignora invoices de $0 (trial do bookkeeping)
      if ((invoice.amount_paid ?? 0) <= 0) return NextResponse.json({ received: true })

      const paid = (plan.paid_installments || 0) + 1
      const isInstallment = plan.kind === 'installment'
      const finished = isInstallment && paid >= plan.installments

      await db.from('payment_plans').update({
        paid_installments: paid,
        status: finished ? 'completed' : 'active',
        updated_at: new Date().toISOString(),
      }).eq('id', plan.id)

      if (finished) {
        await db.from('plan_alerts').insert({
          plan_id: plan.id, client_id: plan.client_id, type: 'completed',
          message: `Parcelamento concluído: ${paid}/${plan.installments} parcelas pagas.`,
        })
        // Cotação vinculada → vira Invoice paga
        if (plan.quote_id) {
          await db.from('quotes').update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', plan.quote_id)
        }
        await notifyClient(db, plan.client_id, '🎉 Todas as parcelas do seu plano foram quitadas. Obrigado!')
      }
      return NextResponse.json({ received: true })
    }

    // ============ FALHA DE DÉBITO ============
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object as Stripe.Invoice
      const subId = (invoice as any).subscription as string | null
      if (!subId) return NextResponse.json({ received: true })

      const { data: plan } = await db.from('payment_plans')
        .select('*, clients(name)').eq('stripe_subscription_id', subId).maybeSingle()
      if (!plan) return NextResponse.json({ received: true })

      const clientName = (plan.clients as any)?.name || plan.client_id
      const amount = ((invoice.amount_due ?? 0) / 100).toFixed(2)

      await db.from('payment_plans').update({
        status: 'payment_failed', updated_at: new Date().toISOString(),
      }).eq('id', plan.id)

      await db.from('plan_alerts').insert({
        plan_id: plan.id, client_id: plan.client_id, type: 'payment_failed',
        message: `⚠️ Débito de $${amount} de ${clientName} FALHOU (${plan.kind === 'installment' ? `parcela ${(plan.paid_installments||0)+1}/${plan.installments}` : 'mensalidade bookkeeping'}). O Stripe fará novas tentativas automáticas. Se persistir, contatar o cliente para cobrança manual.`,
      })

      await notifyClient(db, plan.client_id, '⚠️ Não conseguimos processar seu pagamento. Uma nova tentativa será feita automaticamente. Se preferir, entre em contato: (833) 732-2327.')
      return NextResponse.json({ received: true })
    }

    // ============ ASSINATURA ENCERRADA NO STRIPE ============
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as Stripe.Subscription
      const { data: plan } = await db.from('payment_plans')
        .select('id, status, kind, installments, paid_installments, client_id')
        .eq('stripe_subscription_id', sub.id).maybeSingle()
      if (plan && !['completed','cancelled'].includes(plan.status)) {
        const done = plan.kind === 'installment' && plan.paid_installments >= plan.installments
        await db.from('payment_plans').update({
          status: done ? 'completed' : 'cancelled',
          updated_at: new Date().toISOString(),
        }).eq('id', plan.id)
      }
      return NextResponse.json({ received: true })
    }

    return NextResponse.json({ received: true })
  } catch (err) {
    console.error('Webhook processing error:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}

// ---------- handlers ----------

async function handleQuotePaid(db: ReturnType<typeof adminDb>, session: Stripe.Checkout.Session) {
  const { quoteId, clientId } = session.metadata ?? {}
  if (!quoteId || !clientId) return

  const paidAt = new Date(session.created * 1000)
  const queueDate = getQueueDate(paidAt)

  await db.from('quotes').update({
    status: 'paid',
    stripe_payment_intent: session.payment_intent as string,
    paid_at: paidAt.toISOString(),
    payment_queued_for: queueDate,
    updated_at: new Date().toISOString(),
  }).eq('id', quoteId)

  await db.from('clients').update({ stage: 'In Preparation', updated_at: new Date().toISOString() })
    .eq('id', clientId).in('stage', ['Onboarding','Gathering Docs'])

  const queueDateFmt = new Date(`${queueDate}T12:00:00Z`).toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' })
  await notifyClient(db, clientId, `✅ Pagamento confirmado! Sua declaração entrou na fila de trabalho para **${queueDateFmt}**. Obrigado pela confiança! 🙏`)
}

async function handleInstallmentEntry(
  db: ReturnType<typeof adminDb>, stripe: Stripe,
  session: Stripe.Checkout.Session, planId: string,
) {
  const { data: plan } = await db.from('payment_plans').select('*').eq('id', planId).single()
  if (!plan || plan.status === 'active') return  // idempotência

  const entryPaidAt = new Date(session.created * 1000)

  // Método de pagamento salvo na entrada → usado nas parcelas
  const pi = await stripe.paymentIntents.retrieve(session.payment_intent as string)
  const paymentMethod = pi.payment_method as string

  const freq = plan.frequency as Frequency
  const { interval, interval_count } = FREQ_STRIPE[freq]
  const startDate = firstInstallmentDate(entryPaidAt, freq)

  // Agendamento: N parcelas e encerra sozinho
  const schedule = await stripe.subscriptionSchedules.create({
    customer: plan.stripe_customer_id!,
    start_date: Math.floor(startDate.getTime() / 1000),
    end_behavior: 'cancel',
    default_settings: {
      default_payment_method: paymentMethod,
      collection_method: 'charge_automatically',
    },
    phases: [{
      iterations: plan.installments,
      items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          product: await getOrCreateProduct(stripe),
          unit_amount: Math.round(Number(plan.installment_amount) * 100),
          recurring: { interval, interval_count },
        },
      }],
      metadata: { planId },
    }],
    metadata: { planId, planKind: 'installment' },
  })

  await db.from('payment_plans').update({
    status: 'active',
    entry_paid_at: entryPaidAt.toISOString(),
    stripe_schedule_id: schedule.id,
    stripe_subscription_id: schedule.subscription as string,
    next_charge_date: startDate.toISOString().slice(0, 10),
    updated_at: new Date().toISOString(),
  }).eq('id', planId)

  const firstFmt = startDate.toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric', timeZone:'America/New_York' })
  await notifyClient(db, plan.client_id,
    `✅ Entrada confirmada! Seu parcelamento está ativo: ${plan.installments} parcela(s) de $${Number(plan.installment_amount).toFixed(2)}, primeira cobrança em ${firstFmt}, débito automático. Obrigado! 🙏`)
}

let cachedProductId: string | null = null
async function getOrCreateProduct(stripe: Stripe): Promise<string> {
  if (cachedProductId) return cachedProductId
  const existing = await stripe.products.search({ query: "name:'Parcelamento Peace on Tax'" }).catch(() => null)
  if (existing?.data?.[0]) { cachedProductId = existing.data[0].id; return cachedProductId }
  const p = await stripe.products.create({ name: 'Parcelamento Peace on Tax' })
  cachedProductId = p.id
  return p.id
}

async function notifyClient(db: ReturnType<typeof adminDb>, clientId: string | undefined, content: string) {
  if (!clientId) return
  await db.from('chat_messages').insert({
    client_id: clientId, role: 'assistant', content, channel: 'portal',
  }).then(() => null, () => null)
}
