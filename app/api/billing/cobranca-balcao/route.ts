// /api/billing/cobranca-balcao — cobrar no BALCÃO, sem leitor de cartão
//
// POST { invoiceId }     → cria a sessão de Checkout e devolve o QR
// GET  ?invoiceId=…      → como está a fatura agora (a tela pergunta de novo
//                          enquanto o cliente paga)
//
// Equipe, com a chave `enviar` e dentro do escopo por tipo. É a mesma chave
// de Enviar/Reenviar/Cobrar: pôr a cobrança diante do cliente é ENVIAR, não
// receber. Quem recebe é o webhook, e só ele.
//
// POR QUE ISTO EXISTE
// O leitor comprado (Stripe Reader M2) é Bluetooth: só funciona com um app
// móvel feito sobre o SDK do Terminal, e este sistema é web. Enquanto não há
// leitor de internet, o balcão mostra um QR na tela, o cliente aponta o
// próprio telefone e paga. Não há integração nova com o Stripe: é o MESMO
// Checkout do portal, com o MESMO `metadata.invoice_id` — então o webhook
// que já existe dá baixa sozinho, o recebimento entra na conta de passagem
// do caixa da firma e concilia no repasse. Nada aqui toca em dinheiro.
//
// A sessão é criada NO CLIQUE e vale 24h (o Stripe expira sozinho). Guardar
// um link pronto na fatura seria um link velho na hora errada.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb, canAccessClient } from '@/lib/api-auth'
import { permissoesFinanceiro, RECUSA } from '@/lib/billing-perms'
import { stripeClient } from '@/lib/plan-checkout'
import { APP_URL, localeStripe } from '@/lib/avisos'
import { FORMAS_DO_CLIENTE, sessaoComFormasDisponiveis } from '@/lib/stripe-formas'
import { saldoDaFatura, ehPagavel } from '@/lib/cobranca-balcao'
import QRCode from 'qrcode'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function faturaDoPedido(invoiceId: string) {
  const auth = await getAuth()
  if (!auth?.isStaff) return { erro: 'Acesso restrito', status: 403 as const }
  const perms = await permissoesFinanceiro(auth.userId)
  if (!perms.enviar) return { erro: RECUSA.enviar, status: 403 as const }
  if (!invoiceId) return { erro: 'invoiceId obrigatório', status: 400 as const }

  const db = serviceDb()
  const { data: inv, error } = await db.from('invoices')
    .select('id, number, client_id, status, total, paid_total')
    .eq('id', invoiceId).maybeSingle()
  // Consulta que falha não pode virar "fatura não existe": são conversas
  // diferentes com quem está no balcão.
  if (error) return { erro: `Não foi possível ler a fatura: ${error.message}`, status: 500 as const }
  if (!inv) return { erro: 'Fatura não encontrada', status: 404 as const }
  // isStaff diz QUEM chama; o escopo por TIPO é canAccessClient.
  if (!(await canAccessClient(auth, inv.client_id)))
    return { erro: 'Sem acesso a este cliente', status: 403 as const }
  return { auth, db, inv }
}

export async function GET(req: NextRequest) {
  const ctx = await faturaDoPedido(req.nextUrl.searchParams.get('invoiceId') || '')
  if ('erro' in ctx) return NextResponse.json({ error: ctx.erro }, { status: ctx.status })
  const { inv } = ctx
  const saldo = saldoDaFatura(inv)
  return NextResponse.json({
    ok: true, status: inv.status, saldo,
    pago: saldo <= 0,
    total: Number(inv.total || 0), recebido: Number(inv.paid_total || 0),
  })
}

export async function POST(req: NextRequest) {
  const { invoiceId } = await req.json().catch(() => ({}))
  const ctx = await faturaDoPedido(invoiceId)
  if ('erro' in ctx) return NextResponse.json({ error: ctx.erro }, { status: ctx.status })
  const { auth, db, inv } = ctx

  if (!process.env.STRIPE_SECRET_KEY)
    return NextResponse.json({ error: 'Pagamento online indisponível: falta a chave do Stripe no Vercel.' }, { status: 503 })

  if (!ehPagavel(inv.status))
    return NextResponse.json({
      error: inv.status === 'draft'
        ? 'A fatura ainda é rascunho. Envie antes de cobrar.'
        : `Fatura ${inv.status} não é cobrável.`,
    }, { status: 400 })

  const saldo = saldoDaFatura(inv)
  if (saldo <= 0) return NextResponse.json({ error: 'Esta fatura já está quitada.' }, { status: 400 })

  const { data: c } = await db.from('clients')
    .select('name, business_name, email, language').eq('id', inv.client_id).maybeSingle()

  const stripe = stripeClient()
  const base = APP_URL
  const montar = (formas: string[]) => ({
    mode: 'payment' as const,
    payment_method_types: formas as any,
    ...(c?.email ? { customer_email: c.email } : {}),
    line_items: [{
      price_data: {
        currency: 'usd',
        unit_amount: Math.round(saldo * 100),
        product_data: { name: `Fatura ${inv.number} — ${c?.business_name || c?.name || 'Cliente'}` },
      },
      quantity: 1,
    }],
    // O MESMO metadata do portal: é ele que faz o webhook dar baixa. `forma`
    // só distingue a origem na trilha.
    metadata: { invoice_id: inv.id, invoice_number: inv.number, client_id: inv.client_id, forma: 'balcao' },
    payment_intent_data: { metadata: { invoice_id: inv.id, forma: 'balcao' } },
    success_url: `${base}/portal/payments?pago=${inv.number}`,
    cancel_url: `${base}/portal/payments?cancelado=${inv.number}`,
    locale: localeStripe(c?.language) as any,
  })

  try {
    const { session, recusadas } = await sessaoComFormasDisponiveis(
      stripe, [...FORMAS_DO_CLIENTE], (formas) => montar(formas))
    if (recusadas.length) console.error('balcão: conta do Stripe sem', recusadas.join(', '))
    if (!session.url) throw new Error('o Stripe não devolveu a URL da sessão')

    const qr = await QRCode.toDataURL(session.url, { width: 420, margin: 1 })

    await db.from('invoice_audit').insert({
      invoice_id: inv.id, action: 'stripe_link', performed_by: auth.userId,
      next: { session: session.id, valor: saldo, origem: 'balcao', recusadas },
    }).then(() => null, () => null)

    return NextResponse.json({ ok: true, url: session.url, qr, saldo, numero: inv.number,
      cliente: c?.business_name || c?.name || 'Cliente' })
  } catch (e: any) {
    // Sessão que não nasce grava o motivo real — nunca só um "tente de novo".
    const motivo = String(e?.raw?.message || e?.message || e).slice(0, 400)
    console.error('cobranca-balcao:', inv.number, motivo)
    await db.from('invoice_audit').insert({
      invoice_id: inv.id, action: 'checkout_failed', performed_by: auth.userId,
      reason: motivo, next: { origem: 'balcao' },
    }).then(() => null, () => null)
    return NextResponse.json({ error: `Não foi possível gerar a cobrança: ${motivo}` }, { status: 502 })
  }
}
