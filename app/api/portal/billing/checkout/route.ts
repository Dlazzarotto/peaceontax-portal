// POST /api/portal/billing/checkout — o CLIENTE paga uma fatura
//   Body: { invoiceId }
//
// Um link só, com as três formas: cartão, débito em conta (ACH) e Klarna.
// O cliente escolhe na página do Stripe; se pedir Klarna, a aprovação é
// feita ali mesmo, na hora — e se a Klarna recusar, ele volta e escolhe
// outra forma na mesma sessão. O número do cartão nunca passa por aqui.
//
// Só o dono do cadastro. Fatura tem de estar enviada e com saldo; fatura
// parcelada não paga à vista por aqui (o débito é cadastrado pelo plano).
// A confirmação vem pelo webhook do Stripe, que descobre a forma usada
// pelo PaymentIntent — nunca pela lista de formas oferecidas.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { stripeClient } from '@/lib/plan-checkout'
import { APP_URL, localeStripe } from '@/lib/avisos'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FORMAS_DO_CLIENTE = ['card', 'us_bank_account', 'klarna'] as const

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
  if (auth.isStaff) return NextResponse.json({ error: 'Rota do cliente' }, { status: 403 })
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: 'Pagamento online indisponível no momento.' }, { status: 503 })

  const { invoiceId } = await req.json().catch(() => ({}))
  if (!invoiceId) return NextResponse.json({ error: 'invoiceId obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: c } = await db.from('clients').select('id, name, business_name, email, language').eq('user_id', auth.userId).maybeSingle()
  if (!c) return NextResponse.json({ error: 'Cadastro não encontrado' }, { status: 404 })

  const { data: inv } = await db.from('invoices')
    .select('id, number, client_id, total, paid_total, status, doc_type, payment_plan')
    .eq('id', invoiceId).eq('client_id', c.id).maybeSingle()
  if (!inv) return NextResponse.json({ error: 'Fatura não encontrada' }, { status: 404 })
  if (inv.doc_type !== 'invoice' || inv.status === 'draft') return NextResponse.json({ error: 'Esta fatura ainda não foi enviada.' }, { status: 409 })
  if (inv.status === 'void') return NextResponse.json({ error: 'Fatura cancelada.' }, { status: 409 })
  if (inv.payment_plan === 'installments') {
    return NextResponse.json({ error: 'Esta fatura é parcelada: cadastre o débito automático pelo plano.' }, { status: 409 })
  }
  const saldo = Math.round((Number(inv.total) - Number(inv.paid_total)) * 100) / 100
  if (saldo <= 0) return NextResponse.json({ error: 'Esta fatura já está quitada.' }, { status: 409 })

  const stripe = stripeClient()
  const base = APP_URL.replace(/\/$/, '')
  const montar = (formas: string[]) => ({
    mode: 'payment' as const,
    payment_method_types: formas as any,
    customer_email: c.email || undefined,
    line_items: [{
      price_data: {
        currency: 'usd',
        unit_amount: Math.round(saldo * 100),
        product_data: { name: `Fatura ${inv.number} — ${c.business_name || c.name || 'Cliente'}` },
      },
      quantity: 1,
    }],
    metadata: { invoice_id: inv.id, invoice_number: inv.number, client_id: inv.client_id, forma: 'cliente' },
    payment_intent_data: { metadata: { invoice_id: inv.id, forma: 'cliente' } },
    success_url: `${base}/portal/payments?pago=${inv.number}`,
    cancel_url: `${base}/portal/payments?cancelado=${inv.number}`,
    locale: localeStripe(c.language) as any,
  })

  try {
    let session
    try {
      session = await stripe.checkout.sessions.create(montar([...FORMAS_DO_CLIENTE]))
    } catch (e: any) {
      // Klarna não habilitada na conta Stripe: oferece as outras duas em vez de travar o cliente
      if (/klarna/i.test(String(e?.message))) session = await stripe.checkout.sessions.create(montar(['card', 'us_bank_account']))
      else throw e
    }
    await db.from('invoices').update({ stripe_link: session.url, updated_at: new Date().toISOString() }).eq('id', inv.id)
    await db.from('invoice_audit').insert({
      invoice_id: inv.id, action: 'stripe_link', performed_by: auth.userId,
      next: { session: session.id, valor: saldo, origem: 'portal' },
    }).then(() => null, () => null)
    return NextResponse.json({ ok: true, url: session.url })
  } catch (e) {
    console.error('portal checkout:', e)
    return NextResponse.json({ error: 'Não foi possível iniciar o pagamento. Tente de novo ou fale conosco: (833) 732-2327.' }, { status: 502 })
  }
}
