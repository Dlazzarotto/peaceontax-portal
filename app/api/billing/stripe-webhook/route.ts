// /api/billing/stripe-webhook
//
// O Stripe avisa aqui quando o pagamento é aprovado ou recusado.
// Aprovado  → registra a baixa (o gatilho do banco atualiza a fatura)
// Recusado  → grava o motivo na auditoria, para você ver o que houve
//
// A assinatura é conferida com STRIPE_WEBHOOK_SECRET: sem isso qualquer
// um poderia marcar faturas como pagas.

import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { serviceDb } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

function assinaturaConfere(corpo: string, cabecalho: string | null, segredo: string): boolean {
  if (!cabecalho) return false
  const partes = Object.fromEntries(
    cabecalho.split(',').map(p => p.split('=') as [string, string]))
  const t = partes['t']
  const v1 = partes['v1']
  if (!t || !v1) return false

  // Rejeita eventos com mais de 5 minutos (proteção contra reenvio)
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false

  const esperado = createHmac('sha256', segredo).update(`${t}.${corpo}`).digest('hex')
  const a = Buffer.from(esperado, 'utf8')
  const b = Buffer.from(v1, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  const segredo = process.env.STRIPE_WEBHOOK_SECRET
  if (!segredo) return NextResponse.json({ error: 'Webhook não configurado' }, { status: 500 })

  const corpo = await req.text()
  if (!assinaturaConfere(corpo, req.headers.get('stripe-signature'), segredo)) {
    return NextResponse.json({ error: 'Assinatura inválida' }, { status: 400 })
  }

  let evento: any
  try { evento = JSON.parse(corpo) } catch {
    return NextResponse.json({ error: 'Corpo inválido' }, { status: 400 })
  }

  const db = serviceDb()
  const obj = evento?.data?.object || {}
  const invoiceId = obj?.metadata?.invoice_id

  // ── Pagamento aprovado ──
  if (evento.type === 'checkout.session.completed' && obj.payment_status === 'paid') {
    if (!invoiceId) return NextResponse.json({ recebido: true })

    // Idempotência: o Stripe reenvia o mesmo evento se não confirmarmos
    const { data: jaTem } = await db.from('invoice_payments')
      .select('id').eq('stripe_object', obj.id).maybeSingle()
    if (jaTem) return NextResponse.json({ recebido: true, duplicado: true })

    const { data: inv } = await db.from('invoices')
      .select('id, client_id, number').eq('id', invoiceId).single()
    if (!inv) return NextResponse.json({ recebido: true })

    await db.from('invoice_payments').insert({
      invoice_id: inv.id,
      client_id: inv.client_id,
      amount: Math.round(Number(obj.amount_total || 0)) / 100,
      method: 'card',
      reference: obj.payment_intent || obj.id,
      stripe_object: obj.id,
      received_at: new Date().toISOString(),
    })

    await db.from('invoice_audit').insert({
      invoice_id: inv.id, action: 'stripe_paid',
      next: { valor: Number(obj.amount_total || 0) / 100, session: obj.id },
    }).then(() => null, () => null)

    return NextResponse.json({ recebido: true })
  }

  // ── Pagamento recusado ──
  if (evento.type === 'payment_intent.payment_failed') {
    const motivo = obj?.last_payment_error?.message
      || obj?.last_payment_error?.decline_code
      || 'recusado pelo emissor'
    if (invoiceId) {
      await db.from('invoice_audit').insert({
        invoice_id: invoiceId, action: 'stripe_declined',
        reason: String(motivo).slice(0, 400),
        next: { intent: obj.id, valor: Number(obj.amount || 0) / 100 },
      }).then(() => null, () => null)
    }
    return NextResponse.json({ recebido: true })
  }

  return NextResponse.json({ recebido: true, ignorado: evento.type })
}
