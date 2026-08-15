// /api/billing/stripe-checkout
//
// POST { invoiceId } → cria a sessão de pagamento no Stripe e devolve a URL.
// O cartão é digitado na página do Stripe: o número nunca passa pelo nosso
// servidor (mantém a firma fora do escopo PCI completo).
//
// A confirmação de aprovado/recusado chega pelo webhook, não por aqui.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { permissoesFinanceiro, RECUSA } from '@/lib/billing-perms'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const STRIPE = 'https://api.stripe.com/v1'

function formulario(dados: Record<string, string>): string {
  return Object.entries(dados)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  if (!perms.receber) return NextResponse.json({ error: RECUSA.receber }, { status: 403 })

  const chave = process.env.STRIPE_SECRET_KEY
  if (!chave) {
    return NextResponse.json({
      error: 'STRIPE_SECRET_KEY não está configurada no Vercel.',
    }, { status: 500 })
  }

  const { invoiceId } = await req.json()
  if (!invoiceId) return NextResponse.json({ error: 'invoiceId obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: inv } = await db.from('invoices')
    .select('id, number, client_id, total, paid_total, status, doc_type, clients(business_name, name, email)')
    .eq('id', invoiceId).single()
  if (!inv) return NextResponse.json({ error: 'Fatura não encontrada' }, { status: 404 })
  if (inv.doc_type !== 'invoice') {
    return NextResponse.json({ error: 'Orçamento não recebe pagamento. Converta em fatura primeiro.' }, { status: 400 })
  }
  if (inv.status === 'void') return NextResponse.json({ error: 'Fatura cancelada.' }, { status: 409 })

  const saldo = Math.round((Number(inv.total) - Number(inv.paid_total)) * 100) / 100
  if (saldo <= 0) return NextResponse.json({ error: 'Esta fatura já está quitada.' }, { status: 409 })

  const cli: any = (inv as any).clients || {}
  const origem = req.nextUrl.origin

  const corpo: Record<string, string> = {
    mode: 'payment',
    'payment_method_types[0]': 'card',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(Math.round(saldo * 100)),
    'line_items[0][price_data][product_data][name]': `Fatura ${inv.number} — ${cli.business_name || cli.name || 'Cliente'}`,
    'line_items[0][quantity]': '1',
    'metadata[invoice_id]': inv.id,
    'metadata[invoice_number]': inv.number,
    'metadata[client_id]': inv.client_id,
    success_url: `${origem}/dashboard/billing?pago=${inv.number}`,
    cancel_url: `${origem}/dashboard/billing?cancelado=${inv.number}`,
  }
  if (cli.email) corpo.customer_email = cli.email

  const resp = await fetch(`${STRIPE}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${chave}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formulario(corpo),
  })

  const bruto = await resp.text()
  let sessao: any
  try { sessao = JSON.parse(bruto) } catch {
    return NextResponse.json({ error: 'Resposta inesperada do Stripe.' }, { status: 502 })
  }
  if (!resp.ok) {
    return NextResponse.json({
      error: `Stripe: ${sessao?.error?.message || 'não foi possível criar o pagamento'}`,
    }, { status: 400 })
  }

  await db.from('invoices').update({
    stripe_link: sessao.url, updated_at: new Date().toISOString(),
  }).eq('id', inv.id)

  await db.from('invoice_audit').insert({
    invoice_id: inv.id, action: 'stripe_link', performed_by: auth.userId,
    staff_level: perms.nivel, next: { session: sessao.id, valor: saldo },
  }).then(() => null, () => null)

  return NextResponse.json({
    ok: true, url: sessao.url, valor: saldo,
    message: `Link de pagamento de $${saldo.toFixed(2)} gerado para ${inv.number}.`,
  })
}
