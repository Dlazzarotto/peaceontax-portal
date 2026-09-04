// lib/plan-checkout.ts — a sessão do Stripe de um plano, num lugar só.
//
// Três rotas precisam da mesma coisa: a equipe gerando o link (Planos),
// o parcelamento nascido de fatura e o cliente cadastrando o débito pelo
// portal. Antes cada uma montava a sessão do seu jeito; aqui a regra é uma.
//
//   installment  entrada > 0 → Checkout 'payment' da ENTRADA, salvando o
//                              método (cartão ou ACH) para as parcelas
//                entrada = 0 → Checkout 'setup': cadastra método e mandato
//                              ACH sem cobrar nada agora
//   bookkeeping / monthly    → Checkout 'subscription' ancorada no DIA
//                              ACORDADO (due_day): trial até a data-base
//
// O link do Checkout expira em 24 horas: por isso a sessão é criada na hora
// em que alguém clica, nunca guardada para mandar depois.

import Stripe from 'stripe'
import { nextBillingDayET, normalizarDiaCobranca } from '@/lib/plans'
import { APP_URL, localeStripe } from '@/lib/avisos'

export const STRIPE_API_VERSION = '2026-06-24.dahlia' as Stripe.LatestApiVersion

export function stripeClient(): Stripe {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: STRIPE_API_VERSION })
}

export const STATUS_QUE_GERAM_LINK = ['draft', 'awaiting_entry', 'awaiting_setup']

/** Cliente do Stripe reutilizável: o do plano, o de outro plano do cliente, ou um novo. */
export async function garantirCustomer(db: any, stripe: Stripe, plan: any, client: any): Promise<string> {
  if (plan.stripe_customer_id) return plan.stripe_customer_id
  const { data: outro } = await db.from('payment_plans')
    .select('stripe_customer_id').eq('client_id', plan.client_id)
    .not('stripe_customer_id', 'is', null).limit(1)
  if (outro?.[0]?.stripe_customer_id) return outro[0].stripe_customer_id
  const c = await stripe.customers.create({
    name: client?.name, email: client?.email || undefined,
    metadata: { clientId: plan.client_id },
  })
  return c.id
}

/**
 * Cria a sessão do Checkout para o plano e grava no plano o que a sessão
 * define (customer, session, status, data-base). Devolve a URL.
 * `plan` precisa vir com `clients(name, email, language)`.
 */
export async function criarSessaoDoPlano(db: any, stripe: Stripe, plan: any, opts: {
  /** quem pediu: 'equipe' ou 'cliente' — vai para a auditoria */
  origem: 'equipe' | 'cliente'
  performedBy?: string | null
  baseUrl?: string
}): Promise<{ url: string; sessionId: string }> {
  if (!STATUS_QUE_GERAM_LINK.includes(plan.status)) {
    throw new Error(`Plano em status '${plan.status}' não gera novo link`)
  }
  const client = plan.clients || {}
  const lang = client.language || 'en'
  const locale = localeStripe(lang) as Stripe.Checkout.SessionCreateParams.Locale
  const base = (opts.baseUrl || APP_URL).replace(/\/$/, '')
  const customerId = await garantirCustomer(db, stripe, plan, client)
  const planId = plan.id

  let session: Stripe.Checkout.Session
  const update: Record<string, unknown> = { stripe_customer_id: customerId, updated_at: new Date().toISOString() }

  if (plan.kind === 'installment') {
    const entrada = Number(plan.entry_amount || 0)
    const metadata: Record<string, string> = {
      planId, clientId: plan.client_id,
      planKind: entrada > 0 ? 'installment_entry' : 'installment_setup',
      ...(plan.invoice_id ? { invoiceOrigem: plan.invoice_id } : {}),
    }
    if (entrada > 0) {
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
            unit_amount: Math.round(entrada * 100),
          },
          quantity: 1,
        }],
        payment_intent_data: { setup_future_usage: 'off_session', metadata },
        metadata,
        success_url: `${base}/portal/payments?plan=entry_success`,
        cancel_url: `${base}/portal/payments?plan=cancelled`,
        locale,
      })
      update.status = 'awaiting_entry'
    } else {
      session = await stripe.checkout.sessions.create({
        mode: 'setup',
        customer: customerId,
        payment_method_types: ['us_bank_account', 'card'],
        setup_intent_data: { metadata },
        metadata,
        success_url: `${base}/portal/payments?plan=setup_success`,
        cancel_url: `${base}/portal/payments?plan=cancelled`,
        locale,
      })
      update.status = 'awaiting_setup'
    }
  } else {
    // Mensalidade: trial até o dia acordado, e o Stripe repete no mesmo dia
    const anchor = nextBillingDayET(normalizarDiaCobranca(plan.due_day))
    const metadata = { planId, planKind: 'bookkeeping', clientId: plan.client_id }
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
      subscription_data: { trial_end: Math.floor(anchor.getTime() / 1000), metadata },
      metadata,
      success_url: `${base}/portal/payments?plan=subscription_success`,
      cancel_url: `${base}/portal/payments?plan=cancelled`,
      locale,
    })
    update.status = 'awaiting_setup'
    update.next_charge_date = anchor.toISOString().slice(0, 10)
  }

  update.stripe_session_id = session.id
  await db.from('payment_plans').update(update).eq('id', planId)
  await db.from('plan_audit').insert({
    plan_id: planId, action: 'checkout_link_created', performed_by: opts.performedBy || null,
    snapshot: { sessionId: session.id, kind: plan.kind, dueDay: plan.due_day ?? null, origem: opts.origem },
  }).then(() => null, () => null)

  return { url: session.url!, sessionId: session.id }
}

/**
 * Contrato enviado para este plano que o cliente ainda não assinou.
 * Regra: primeiro assina (autorização do débito), depois cadastra a conta.
 * A assinatura do cliente fica marcada em plan_audit ('contract_signed_by_client')
 * pela volta do DocuSign; o envelope só fica 'completed' depois que a firma assina.
 */
export async function contratoPendenteDoPlano(db: any, planId: string): Promise<{ id: string; embedded: boolean } | null> {
  const { data: sr } = await db.from('signature_requests')
    .select('id, status, signers').eq('plan_id', planId).eq('kind', 'contract')
    .in('status', ['sent', 'delivered']).order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (!sr) return null
  const { data: assinou } = await db.from('plan_audit')
    .select('id').eq('plan_id', planId).eq('action', 'contract_signed_by_client').limit(1).maybeSingle()
  if (assinou) return null
  const embedded = !!(Array.isArray(sr.signers) && sr.signers[0]?.embedded)
  return { id: sr.id, embedded }
}
