// POST /api/stripe/webhook — PÚBLICO (assinatura verificada)
// Trata:
//   checkout.session.completed → cotações + entrada de parcelamento + bookkeeping
//                              → FATURAS do módulo financeiro (metadata.invoice_id)
//   checkout.session.async_payment_succeeded / _failed → fatura paga por ACH
//                              (o débito em conta leva dias; o 'completed' chega antes do dinheiro)
//   invoice.paid               → conta parcelas pagas / registra mensalidade
//   invoice.payment_failed     → alerta a equipe (cobrança manual)
//   payment_intent.payment_failed → registra recusa de cobrança de fatura
//   customer.subscription.deleted → encerra plano

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { getQueueDate } from '@/lib/pricing'
import { FREQ_STRIPE, firstInstallmentDate, round2, type Frequency } from '@/lib/plans'

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

      // ---- Módulo financeiro: fatura paga (cartão, Klarna ou ACH) ----
      if (meta.invoice_id) {
        await handleFaturaPaga(db, stripe, session)
        return NextResponse.json({ received: true })
      }

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

      // ---- Parcelamento de fatura SEM entrada: mandato cadastrado, nada cobrado ----
      if (meta.planKind === 'installment_setup' && meta.planId) {
        await handleInstallmentSetup(db, stripe, session, meta.planId)
        return NextResponse.json({ received: true })
      }

      // ---- Fase 4a: bookkeeping assinado ----
      if (meta.planKind === 'bookkeeping' && meta.planId) {
        await db.from('payment_plans').update({
          stripe_subscription_id: session.subscription as string,
          status: 'active',
          updated_at: new Date().toISOString(),
        }).eq('id', meta.planId)
        await notifyClient(db, meta.clientId, '✅ Contrato ativado! A cobrança mensal ocorre na data combinada. Obrigado pela confiança! 🙏')
        return NextResponse.json({ received: true })
      }

      return NextResponse.json({ received: true })
    }

    // ============ ACH DA FATURA: o dinheiro chegou (ou não) dias depois ============
    if (event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object as Stripe.Checkout.Session
      if (session.metadata?.invoice_id) await handleFaturaPaga(db, stripe, session)
      return NextResponse.json({ received: true })
    }
    if (event.type === 'checkout.session.async_payment_failed') {
      const session = event.data.object as Stripe.Checkout.Session
      const invoiceId = session.metadata?.invoice_id
      if (invoiceId) {
        await db.from('invoice_audit').insert({
          invoice_id: invoiceId, action: 'stripe_declined',
          reason: 'débito em conta (ACH) devolvido pelo banco',
          next: { session: session.id, valor: Number(session.amount_total || 0) / 100 },
        }).then(() => null, () => null)
        await notifyClient(db, session.metadata?.client_id,
          '⚠️ O débito em conta da sua fatura foi devolvido pelo banco. Você pode pagar de novo em Pagamentos ou falar conosco: (833) 732-2327.')
      }
      return NextResponse.json({ received: true })
    }

    // ============ COBRANÇA DE FATURA RECUSADA ============
    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object as Stripe.PaymentIntent
      const invoiceId = pi.metadata?.invoice_id
      if (invoiceId) {
        const motivo = (pi as any).last_payment_error?.message
          || (pi as any).last_payment_error?.decline_code
          || 'recusado pelo emissor'
        await db.from('invoice_audit').insert({
          invoice_id: invoiceId, action: 'stripe_declined',
          reason: String(motivo).slice(0, 400),
          next: { intent: pi.id, valor: Number(pi.amount || 0) / 100 },
        }).then(() => null, () => null)
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

      // Parcelamento nascido de fatura: baixa a parcela e lança o recebimento
      if (isInstallment && plan.invoice_id) {
        await sincronizarParcela(db, stripe, plan, invoice, paid)
      }

      // Mensalidade (bookkeeping/payroll/sales tax): emite a fatura do mês
      if (!isInstallment) {
        await gerarFaturaDaMensalidade(db, stripe, plan, invoice)
      }

      if (finished) {
        await db.from('plan_alerts').insert({
          plan_id: plan.id, client_id: plan.client_id, type: 'completed',
          message: `Parcelamento concluído: ${paid}/${plan.installments} parcelas pagas.`,
        })
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
        message: `⚠️ Débito de $${amount} de ${clientName} FALHOU (${plan.kind === 'installment' ? `parcela ${(plan.paid_installments||0)+1}/${plan.installments}` : `mensalidade: ${plan.description || 'bookkeeping'}`}). O Stripe fará novas tentativas automáticas. Se persistir, contatar o cliente para cobrança manual.`,
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

/** Fatura do módulo financeiro quitada pelo Stripe (cartão, Klarna ou ACH) */
/**
 * Forma realmente usada, lida do PaymentIntent. A sessão pode oferecer
 * cartão, ACH e Klarna juntos; a lista oferecida não diz o que o cliente
 * escolheu — só o método do pagamento diz.
 */
async function formaDoPagamento(stripe: Stripe, session: Stripe.Checkout.Session): Promise<'card' | 'ach' | 'klarna'> {
  try {
    const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id
    if (piId) {
      const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['payment_method'] })
      const tipo = (pi.payment_method as Stripe.PaymentMethod | null)?.type
      if (tipo === 'klarna') return 'klarna'
      if (tipo === 'us_bank_account') return 'ach'
      if (tipo) return 'card'
    }
  } catch (e) {
    console.error('formaDoPagamento:', (e as Error).message)
  }
  // Sem PaymentIntent legível: só confia na lista quando ela tem uma forma só
  const tipos = (session as any).payment_method_types as string[] | undefined
  if (tipos?.length === 1) return tipos[0] === 'klarna' ? 'klarna' : tipos[0] === 'us_bank_account' ? 'ach' : 'card'
  return 'card'
}

async function handleFaturaPaga(db: ReturnType<typeof adminDb>, stripe: Stripe, session: Stripe.Checkout.Session) {
  const meta = session.metadata ?? {}
  const invoiceId = meta.invoice_id
  if (!invoiceId) return

  const { data: inv } = await db.from('invoices')
    .select('id, client_id, number, total, paid_total').eq('id', invoiceId).maybeSingle()
  if (!inv) return

  // ACH: o 'completed' chega com o débito ainda em processamento. O dinheiro
  // é confirmado depois por async_payment_succeeded — aí sim entra como pago.
  if (session.payment_status !== 'paid') {
    await db.from('invoice_audit').insert({
      invoice_id: inv.id, action: 'stripe_processing',
      next: { session: session.id, valor: Number(session.amount_total || 0) / 100, status: session.payment_status },
    }).then(() => null, () => null)
    await notifyClient(db, inv.client_id,
      `🏦 Recebemos o pedido de débito em conta da fatura ${inv.number}. O banco leva alguns dias para confirmar; avisamos aqui quando entrar.`)
    return
  }

  // Idempotência: o Stripe reenvia o evento se não confirmarmos
  const { data: jaTem } = await db.from('invoice_payments')
    .select('id').eq('stripe_object', session.id).maybeSingle()
  if (jaTem) return

  const forma = await formaDoPagamento(stripe, session)
  const viaKlarna = forma === 'klarna'

  await db.from('invoice_payments').insert({
    invoice_id: inv.id,
    client_id: inv.client_id,
    amount: Math.round(Number(session.amount_total || 0)) / 100,
    // Klarna paga integralmente à firma: registra como financiada
    method: viaKlarna ? 'external' : forma === 'ach' ? 'ach' : 'card',
    financier: viaKlarna ? 'Klarna' : null,
    reference: (typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id) || session.id,
    stripe_object: session.id,
    received_at: new Date().toISOString(),
  })

  if (viaKlarna) {
    await db.from('invoices').update({ payment_plan: 'financed', financier: 'Klarna', updated_at: new Date().toISOString() })
      .eq('id', inv.id).then(() => null, () => null)
  }

  await db.from('invoice_audit').insert({
    invoice_id: inv.id, action: 'stripe_paid',
    next: { valor: Number(session.amount_total || 0) / 100, session: session.id, forma, klarna: viaKlarna },
  }).then(() => null, () => null)

  await notifyClient(db, inv.client_id,
    `✅ Pagamento da fatura ${inv.number} confirmado. Obrigado! 🙏`)
}

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

  const pi = await stripe.paymentIntents.retrieve(session.payment_intent as string)
  const paymentMethod = pi.payment_method as string

  // Data da 1ª parcela: a acordada no plano tem prioridade sobre a derivada
  // da data em que a entrada foi paga.
  const freq = plan.frequency as Frequency
  const startDate = plan.next_charge_date
    ? new Date(`${plan.next_charge_date}T12:00:00Z`)
    : firstInstallmentDate(entryPaidAt, freq)

  const { schedule, inicio } = await criarAgendamento(stripe, plan, paymentMethod, startDate)

  await db.from('payment_plans').update({
    status: 'active',
    entry_paid_at: entryPaidAt.toISOString(),
    stripe_schedule_id: schedule.id,
    stripe_subscription_id: schedule.subscription as string,
    next_charge_date: inicio.toISOString().slice(0, 10),
    updated_at: new Date().toISOString(),
  }).eq('id', planId)

  // A entrada é pagamento da fatura de origem, não parcela
  if (plan.invoice_id && Number(plan.entry_amount) > 0) {
    await lancarRecebimento(db, plan.invoice_id, plan.client_id,
      round2(Number(plan.entry_amount)), 'card', session.payment_intent as string, session.id)
  }

  const firstFmt = startDate.toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric', timeZone:'America/New_York' })
  await notifyClient(db, plan.client_id,
    `✅ Entrada confirmada! Seu parcelamento está ativo: ${plan.installments} parcela(s) de $${Number(plan.installment_amount).toFixed(2)}, primeira cobrança em ${firstFmt}, débito automático. Obrigado! 🙏`)
}

/**
 * Agendamento das parcelas no Stripe.
 *
 * DUAS FASES: o cronograma faz a última parcela absorver o centavo da divisão
 * (ex.: 1000/3 = 333.33 + 333.33 + 333.34). Um schedule de fase única cobraria
 * 333.33 três vezes e a fatura fecharia com 1 centavo em aberto para sempre.
 * Quando a última difere, ela vira uma fase própria.
 *
 * Data no passado é aceita como "começar agora": o Stripe recusa start_date
 * anterior ao instante da criação.
 */
async function criarAgendamento(
  stripe: Stripe, plan: any, paymentMethod: string, desejada: Date,
): Promise<{ schedule: Stripe.SubscriptionSchedule; inicio: Date }> {
  const freq = plan.frequency as Frequency
  const { interval, interval_count } = FREQ_STRIPE[freq]
  const n = Number(plan.installments)
  const base = round2(Number(plan.installment_amount))
  const restante = round2(Number(plan.total) - Number(plan.entry_amount || 0))
  const ultima = round2(restante - base * (n - 1))

  const agora = Math.floor(Date.now() / 1000)
  const ts = Math.max(Math.floor(desejada.getTime() / 1000), agora + 120)
  const inicio = new Date(ts * 1000)

  const produto = await getOrCreateProduct(stripe)
  const item = (valor: number) => ({
    quantity: 1,
    price_data: {
      currency: 'usd',
      product: produto,
      unit_amount: Math.round(valor * 100),
      recurring: { interval, interval_count },
    },
  })

  const fases: any[] =
    ultima === base || n < 2
      ? [{ iterations: n, items: [item(base)], metadata: { planId: plan.id } }]
      : [
          { iterations: n - 1, items: [item(base)], metadata: { planId: plan.id, fase: 'base' } },
          { iterations: 1, items: [item(ultima)], metadata: { planId: plan.id, fase: 'ultima' } },
        ]

  const schedule = await stripe.subscriptionSchedules.create({
    customer: plan.stripe_customer_id!,
    start_date: ts,
    end_behavior: 'cancel',
    default_settings: {
      default_payment_method: paymentMethod,
      collection_method: 'charge_automatically',
    },
    phases: fases,
    metadata: { planId: plan.id, planKind: 'installment' },
  })

  return { schedule, inicio }
}

/** Parcelamento de fatura SEM entrada: nada foi cobrado, só o mandato colhido. */
async function handleInstallmentSetup(
  db: ReturnType<typeof adminDb>, stripe: Stripe,
  session: Stripe.Checkout.Session, planId: string,
) {
  const { data: plan } = await db.from('payment_plans').select('*').eq('id', planId).single()
  if (!plan || plan.status === 'active') return   // idempotência

  const si = await stripe.setupIntents.retrieve(session.setup_intent as string)
  const paymentMethod = si.payment_method as string
  if (!paymentMethod) return

  const desejada = plan.next_charge_date
    ? new Date(`${plan.next_charge_date}T12:00:00Z`)
    : new Date()

  const { schedule, inicio } = await criarAgendamento(stripe, plan, paymentMethod, desejada)

  await db.from('payment_plans').update({
    status: 'active',
    stripe_schedule_id: schedule.id,
    stripe_subscription_id: schedule.subscription as string,
    next_charge_date: inicio.toISOString().slice(0, 10),
    updated_at: new Date().toISOString(),
  }).eq('id', planId)

  const fmt = inicio.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/New_York' })
  await notifyClient(db, plan.client_id,
    `✅ Débito automático autorizado! ${plan.installments} parcela(s) de $${Number(plan.installment_amount).toFixed(2)}, primeira em ${fmt}. Nada foi cobrado agora. Obrigado! 🙏`)
}

/** Lança um recebimento na fatura, sem duplicar se o evento for reenviado. */
async function lancarRecebimento(
  db: ReturnType<typeof adminDb>, invoiceId: string, clientId: string,
  valor: number, metodo: string, referencia: string | null, objetoStripe: string,
) {
  if (!invoiceId || valor <= 0) return
  const { data: ja } = await db.from('invoice_payments')
    .select('id').eq('stripe_object', objetoStripe).maybeSingle()
  if (ja) return

  await db.from('invoice_payments').insert({
    invoice_id: invoiceId, client_id: clientId, amount: valor,
    method: metodo, reference: referencia, stripe_object: objetoStripe,
    received_at: new Date().toISOString(),
  })
}

/** Descobre o método do pagamento no Stripe. Cai em 'card' se não conseguir. */
async function metodoDoPagamento(stripe: Stripe, invoice: Stripe.Invoice): Promise<string> {
  try {
    const piId = (invoice as any).payment_intent as string | null
    if (!piId) return 'card'
    const pi = await stripe.paymentIntents.retrieve(piId)
    const t = (pi.payment_method_types || [])[0]
    return t === 'us_bank_account' ? 'ach' : 'card'
  } catch {
    return 'card'
  }
}

/** Parcela paga: baixa a linha do cronograma e lança o recebimento na fatura. */
async function sincronizarParcela(
  db: ReturnType<typeof adminDb>, stripe: Stripe,
  plan: any, invoice: Stripe.Invoice, seq: number,
) {
  const valor = round2((invoice.amount_paid ?? 0) / 100)
  const metodo = await metodoDoPagamento(stripe, invoice)

  await db.from('invoice_installments').update({
    status: 'paid',
    paid_at: new Date().toISOString(),
    stripe_intent: (invoice as any).payment_intent || null,
  }).eq('invoice_id', plan.invoice_id).eq('seq', seq)

  await lancarRecebimento(db, plan.invoice_id, plan.client_id, valor, metodo,
    (invoice as any).payment_intent || null, invoice.id as string)
}

/**
 * Mensalidade paga vira fatura quitada — sustentação contábil: todo dinheiro
 * que entra tem documento de origem.
 *
 * A numeração usa a MESMA função do banco que a tela usa (next_invoice_number),
 * que é atômica. Reimplementar aqui criaria corrida entre a tela e o webhook.
 *
 * O índice único (plan_id, competencia) impede fatura repetida quando o
 * Stripe reenvia o evento.
 */
async function gerarFaturaDaMensalidade(
  db: ReturnType<typeof adminDb>, stripe: Stripe, plan: any, invoice: Stripe.Invoice,
) {
  const ts = ((invoice as any).period_start || invoice.created) * 1000
  const d = new Date(ts)
  const competencia = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`

  const { data: ja } = await db.from('invoices')
    .select('id').eq('plan_id', plan.id).eq('competencia', competencia).maybeSingle()
  if (ja) return

  const valor = round2((invoice.amount_paid ?? 0) / 100)
  if (valor <= 0) return

  const { data: num, error: numErr } = await db.rpc('next_invoice_number', { p_kind: 'invoice' })
  if (numErr || !num) { console.error('Numeração da mensalidade:', numErr); return }

  const mesRef = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const descricao = `${plan.description || 'Serviço mensal'} — ${mesRef}`

  const { data: inv, error: invErr } = await db.from('invoices').insert({
    client_id: plan.client_id,
    doc_type: 'invoice',
    number: num,
    status: 'sent',
    due_date: competencia,
    subtotal: valor, discount: 0, total: valor,
    payment_plan: 'full',
    expected_method: null,
    notes: `Gerada automaticamente pelo contrato recorrente.`,
    plan_id: plan.id,
    competencia,
    created_by: plan.created_by,
  }).select('id, number').single()

  if (invErr || !inv) { console.error('Fatura da mensalidade:', invErr); return }

  const { error: itErr } = await db.from('invoice_items').insert({
    invoice_id: inv.id, service_id: null, description: descricao,
    qty: 1, unit_price: valor, amount: valor, sort: 0,
  })
  if (itErr) {
    await db.from('invoices').delete().eq('id', inv.id)
    console.error('Item da mensalidade:', itErr)
    return
  }

  const metodo = await metodoDoPagamento(stripe, invoice)
  await lancarRecebimento(db, inv.id, plan.client_id, valor, metodo,
    (invoice as any).payment_intent || null, invoice.id as string)

  // O gatilho do banco deve fechar paid_total e a situação. Se não houver
  // gatilho, a fatura ficaria 'sent' com saldo — conferimos e corrigimos.
  const { data: conf } = await db.from('invoices')
    .select('paid_total, status').eq('id', inv.id).maybeSingle()
  if (conf && (Number(conf.paid_total) < valor || conf.status !== 'paid')) {
    await db.from('invoices').update({ paid_total: valor, status: 'paid' }).eq('id', inv.id)
  }

  await db.from('invoice_audit').insert({
    invoice_id: inv.id, action: 'recurring_invoiced',
    next: { planId: plan.id, competencia, valor, stripeInvoice: invoice.id },
  }).then(() => null, () => null)

  await notifyClient(db, plan.client_id,
    `✅ Recebemos o pagamento de ${mesRef}. A fatura ${inv.number} está disponível no portal. Obrigado! 🙏`)
}

let cachedProductId: string | null = null
async function getOrCreateProduct(stripe: Stripe): Promise<string> {
  if (cachedProductId) return cachedProductId
  const existing = await stripe.products.search({ query: "name:'Parcelamento Peace on Tax'" }).catch(() => null)
  if (existing?.data?.[0]) { const id = String(existing.data[0].id); cachedProductId = id; return id }
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
