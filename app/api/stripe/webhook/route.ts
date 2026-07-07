// POST /api/stripe/webhook
// Recebe eventos do Stripe. DEVE SER PÚBLICO (no middleware).
// Verifica assinatura antes de processar qualquer dado.

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { getQueueDate } from '@/lib/pricing'

// Importante: desativar o body parser do Next.js para verificação de assinatura
export const runtime = 'nodejs'

function adminDb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY
  if (!key) throw new Error('Service key não configurada')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key)
}

export async function POST(req: NextRequest) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-06-24.dahlia',
  })

  const body = await req.text()
  const sig  = req.headers.get('stripe-signature')
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET não configurado')
    return NextResponse.json({ error: 'Webhook não configurado' }, { status: 500 })
  }

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig!, webhookSecret)
  } catch (err) {
    console.error('Webhook signature verification failed:', err)
    return NextResponse.json({ error: 'Assinatura inválida' }, { status: 400 })
  }

  // Só processamos checkout.session.completed
  if (event.type !== 'checkout.session.completed') {
    return NextResponse.json({ received: true })
  }

  const session = event.data.object as Stripe.Checkout.Session
  const { quoteId, clientId, fiscalYear } = session.metadata ?? {}

  if (!quoteId || !clientId) {
    console.error('Webhook: metadados faltando', session.id)
    return NextResponse.json({ error: 'Metadados inválidos' }, { status: 400 })
  }

  const db = adminDb()
  const paidAt = new Date(session.created * 1000)
  const queueDate = getQueueDate(paidAt)

  try {
    // Atualiza a cotação
    const { error: qErr } = await db.from('quotes').update({
      status:                'paid',
      stripe_payment_intent: session.payment_intent as string,
      paid_at:               paidAt.toISOString(),
      payment_queued_for:    queueDate,
      updated_at:            new Date().toISOString(),
    }).eq('id', quoteId)

    if (qErr) throw new Error(`Quote update error: ${qErr.message}`)

    // Move o cliente para "In Preparation" no CRM
    await db.from('clients').update({
      stage:      'In Preparation',
      updated_at: new Date().toISOString(),
    }).eq('id', clientId).in('stage', ['Onboarding','Gathering Docs'])

    // Registra mensagem automática no chat do cliente
    const paymentDateET = paidAt.toLocaleDateString('en-US', {
      timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric',
    })
    const queueDateFmt = new Date(`${queueDate}T12:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric'
    })

    await db.from('chat_messages').insert({
      client_id: clientId,
      role:      'assistant',
      content:   `✅ Pagamento confirmado em ${paymentDateET} (ET)! Sua declaração foi adicionada à fila de trabalho para **${queueDateFmt}**. Nossa equipe entrará em contato caso precise de alguma informação adicional. Obrigado pela confiança! 🙏`,
      channel:   'portal',
    })

    console.log(`✅ Pagamento processado: quote ${quoteId}, cliente ${clientId}, fila ${queueDate}`)
    return NextResponse.json({ received: true, queueDate })
  } catch (err) {
    console.error('Webhook processing error:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}

