// POST /api/stripe/checkout
// Cria uma sessão de pagamento Stripe para uma cotação aprovada.
// Body: { quoteId }
// Somente equipe pode criar sessões.

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getAuth, serviceDb } from '@/lib/api-auth'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-06-24.dahlia',
})

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://peaceontax-portal.vercel.app'

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuth()
    if (!auth?.isStaff) {
      return NextResponse.json({ error: 'Acesso restrito à equipe' }, { status: 403 })
    }

    const { quoteId } = await req.json()
    if (!quoteId) return NextResponse.json({ error: 'quoteId obrigatório' }, { status: 400 })

    const db = serviceDb()

    // Busca a cotação e dados do cliente
    const { data: quote, error: qErr } = await db
      .from('quotes')
      .select('*, clients(name, email, language)')
      .eq('id', quoteId)
      .single()

    if (qErr || !quote) return NextResponse.json({ error: 'Cotação não encontrada' }, { status: 404 })
    if (quote.status === 'paid') return NextResponse.json({ error: 'Esta cotação já foi paga' }, { status: 409 })
    if (quote.total <= 0) return NextResponse.json({ error: 'Valor inválido para cobrança' }, { status: 400 })

    const client = quote.clients as any
    const lang = client?.language || 'en'

    // Linha de itens para o Stripe
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = quote.items
      .filter((item: any) => item.amount > 0)
      .map((item: any) => ({
        price_data: {
          currency: 'usd',
          product_data: {
            name: item.label,
            metadata: { qty: String(item.qty || 1) },
          },
          unit_amount: Math.round(item.amount * 100),
        },
        quantity: 1,
      }))

    // Adiciona item de 1095-A se incluído (sem custo) — omite do Stripe

    const descriptions: Record<string, string> = {
      pt: `Declaração de Imposto ${quote.fiscal_year} — Peace on Tax Corp`,
      en: `Tax Return ${quote.fiscal_year} — Peace on Tax Corp`,
      es: `Declaración de Impuestos ${quote.fiscal_year} — Peace on Tax Corp`,
      zh: `${quote.fiscal_year}年报税 — Peace on Tax Corp`,
      fr: `Déclaration fiscale ${quote.fiscal_year} — Peace on Tax Corp`,
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'us_bank_account'],
      mode: 'payment',
      line_items: lineItems,
      customer_email: client?.email,
      metadata: {
        quoteId,
        clientId: quote.client_id,
        fiscalYear: String(quote.fiscal_year),
      },
      payment_intent_data: {
        description: descriptions[lang] || descriptions.en,
        metadata: { quoteId, clientId: quote.client_id },
      },
      success_url: `${BASE_URL}/portal?payment=success&quoteId=${quoteId}`,
      cancel_url:  `${BASE_URL}/portal?payment=cancelled`,
      locale: lang === 'pt' ? 'pt-BR' : lang === 'es' ? 'es' : lang === 'zh' ? 'zh' : lang === 'fr' ? 'fr' : 'en',
    })

    // Atualiza cotação com o ID da sessão e muda status para 'sent'
    await db.from('quotes').update({
      stripe_session_id: session.id,
      status: 'sent',
      updated_at: new Date().toISOString(),
    }).eq('id', quoteId)

    return NextResponse.json({
      url: session.url,
      sessionId: session.id,
    })
  } catch (e) {
    console.error('Stripe checkout error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

