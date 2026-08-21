// POST /api/billing/installment-plan — transforma uma fatura em aberto em parcelamento
//
// Body: { invoiceId, entryPct?, installments, frequency, firstDueDate }
//   entryPct     0 a 90 (0 = sem entrada)
//   frequency    weekly | biweekly | monthly
//   firstDueDate data da 1ª parcela, escolhida no acordo
//
// Entrada > 0  → Checkout mode 'payment': cobra a entrada e salva o método
// Entrada = 0  → Checkout mode 'setup': cadastra método e mandato ACH sem cobrar
//
// Em ambos, o agendamento das parcelas é criado pelo webhook, depois que
// o método existe. Aqui só nasce o plano e o cronograma da fatura.
//
// Só gerente ou sócio.

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { permissoesFinanceiro, RECUSA } from '@/lib/billing-perms'
import { type Frequency } from '@/lib/plans'

export const dynamic = 'force-dynamic'

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://peaceontax-portal.vercel.app'
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

/**
 * Avança a data conforme a frequência acordada.
 *
 * No mensal, mês curto é tratado: dia 30 + 3 meses a partir de novembro
 * cairia em "30 de fevereiro", que o JavaScript transborda para 2 de março
 * — deixando duas parcelas em março e nenhuma em fevereiro. Aqui a data
 * é limitada ao último dia do mês de destino.
 */
function avancar(base: Date, freq: Frequency, passos: number): Date {
  const d = new Date(base)
  if (freq === 'weekly') {
    d.setUTCDate(d.getUTCDate() + 7 * passos)
    return d
  }
  if (freq === 'biweekly') {
    d.setUTCDate(d.getUTCDate() + 14 * passos)
    return d
  }
  const dia = d.getUTCDate()
  const ano = d.getUTCFullYear()
  const mes = d.getUTCMonth() + passos
  // Dia 0 do mês seguinte = último dia do mês de destino
  const ultimo = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate()
  return new Date(Date.UTC(ano, mes, Math.min(dia, ultimo), 12, 0, 0))
}

/** Cronograma: base para todas, última absorve o centavo da divisão. */
export function montarCronograma(restante: number, n: number, primeira: string, freq: Frequency) {
  const base = Math.floor((restante / n) * 100) / 100
  const linhas: { seq: number; due_date: string; amount: number }[] = []
  const inicio = new Date(`${primeira}T12:00:00Z`)
  for (let i = 0; i < n; i++) {
    linhas.push({
      seq: i + 1,
      due_date: avancar(inicio, freq, i).toISOString().slice(0, 10),
      amount: i === n - 1 ? round2(restante - base * (n - 1)) : base,
    })
  }
  return linhas
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  if (!perms.receber) return NextResponse.json({ error: RECUSA.receber }, { status: 403 })

  const b = await req.json()
  const db = serviceDb()

  // ── validações ──
  if (!b.invoiceId) return NextResponse.json({ error: 'Selecione a fatura.' }, { status: 400 })

  const freq = String(b.frequency || 'monthly') as Frequency
  if (!['weekly', 'biweekly', 'monthly'].includes(freq)) {
    return NextResponse.json({ error: 'Frequência inválida.' }, { status: 400 })
  }

  const n = Math.trunc(Number(b.installments) || 0)
  if (n < 2 || n > 36) {
    return NextResponse.json({ error: 'O parcelamento vai de 2 a 36 parcelas.' }, { status: 400 })
  }

  if (!b.firstDueDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.firstDueDate))) {
    return NextResponse.json({ error: 'Informe a data da primeira parcela.' }, { status: 400 })
  }

  const entryPct = round2(Number(b.entryPct) || 0)
  if (entryPct < 0 || entryPct > 90) {
    return NextResponse.json({ error: 'A entrada vai de 0% a 90%.' }, { status: 400 })
  }

  const { data: inv } = await db.from('invoices')
    .select('id, client_id, number, doc_type, total, paid_total, status, clients(name, email, language)')
    .eq('id', b.invoiceId).maybeSingle()
  if (!inv) return NextResponse.json({ error: 'Fatura não encontrada.' }, { status: 404 })
  if (inv.doc_type !== 'invoice') {
    return NextResponse.json({ error: 'Só faturas podem ser parceladas. Converta o orçamento primeiro.' }, { status: 409 })
  }
  if (inv.status === 'void') {
    return NextResponse.json({ error: 'Fatura cancelada não pode ser parcelada.' }, { status: 409 })
  }

  const saldo = round2(Number(inv.total) - Number(inv.paid_total))
  if (saldo <= 0) {
    return NextResponse.json({ error: `${inv.number} já está quitada.` }, { status: 409 })
  }

  // Um parcelamento vivo por fatura
  const { data: existente } = await db.from('payment_plans')
    .select('id, status').eq('invoice_id', inv.id)
    .in('status', ['draft', 'awaiting_entry', 'awaiting_setup', 'active', 'payment_failed'])
    .limit(1)
  if (existente && existente.length > 0) {
    return NextResponse.json({
      error: `${inv.number} já tem um parcelamento em andamento (${existente[0].status}). Cancele-o antes de criar outro.`,
    }, { status: 409 })
  }

  const entrada = round2(saldo * (entryPct / 100))
  const restante = round2(saldo - entrada)
  if (restante <= 0) {
    return NextResponse.json({ error: 'A entrada não pode cobrir o saldo inteiro.' }, { status: 400 })
  }

  const cronograma = montarCronograma(restante, n, String(b.firstDueDate), freq)
  const valorParcela = cronograma[0].amount

  const client = (inv as any).clients || {}
  const lang = client.language || 'en'
  const locale = lang === 'pt' ? 'pt-BR' : lang === 'es' ? 'es' : lang === 'zh' ? 'zh' : lang === 'fr' ? 'fr' : 'en'
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-06-24.dahlia' as Stripe.LatestApiVersion,
  })

  try {
    // Cliente Stripe reutilizável — necessário para os débitos futuros
    const { data: outro } = await db.from('payment_plans')
      .select('stripe_customer_id').eq('client_id', inv.client_id)
      .not('stripe_customer_id', 'is', null).limit(1)

    let customerId: string = outro?.[0]?.stripe_customer_id || ''
    if (!customerId) {
      const c = await stripe.customers.create({
        name: client.name, email: client.email || undefined,
        metadata: { clientId: inv.client_id },
      })
      customerId = c.id
    }

    // ── plano ──
    const { data: plan, error: pErr } = await db.from('payment_plans').insert({
      client_id: inv.client_id,
      invoice_id: inv.id,
      kind: 'installment',
      total: saldo,
      entry_pct: entryPct,
      entry_amount: entrada,
      frequency: freq,
      installments: n,
      installment_amount: valorParcela,
      description: `Parcelamento da fatura ${inv.number}`,
      status: entrada > 0 ? 'awaiting_entry' : 'awaiting_setup',
      stripe_customer_id: customerId,
      // Data acordada da 1ª parcela. O webhook lê daqui em vez de derivar
      // da data em que a entrada foi paga.
      next_charge_date: String(b.firstDueDate),
      created_by: auth.userId,
    }).select('id').single()

    if (pErr || !plan) {
      return NextResponse.json({ error: `Plano: ${pErr?.message || 'falha ao criar'}` }, { status: 500 })
    }

    // ── cronograma da fatura (fonte da impressão) ──
    await db.from('invoice_installments').delete().eq('invoice_id', inv.id)
    const { error: cErr } = await db.from('invoice_installments')
      .insert(cronograma.map(l => ({ ...l, invoice_id: inv.id, status: 'scheduled' })))
    if (cErr) {
      await db.from('payment_plans').delete().eq('id', plan.id)
      return NextResponse.json({ error: `Cronograma: ${cErr.message}` }, { status: 500 })
    }

    await db.from('invoices').update({
      payment_plan: 'installments',
      due_date: cronograma[0].due_date,
    }).eq('id', inv.id)

    // ── sessão Stripe ──
    const metadata = {
      planId: plan.id,
      planKind: entrada > 0 ? 'installment_entry' : 'installment_setup',
      clientId: inv.client_id,
      invoiceOrigem: inv.id,
    }

    const session = entrada > 0
      ? await stripe.checkout.sessions.create({
          mode: 'payment',
          customer: customerId,
          payment_method_types: ['us_bank_account', 'card'],
          line_items: [{
            price_data: {
              currency: 'usd',
              product_data: {
                name: lang === 'pt'
                  ? `Entrada (${entryPct}%) — Fatura ${inv.number}`
                  : `Down payment (${entryPct}%) — Invoice ${inv.number}`,
              },
              unit_amount: Math.round(entrada * 100),
            },
            quantity: 1,
          }],
          payment_intent_data: {
            setup_future_usage: 'off_session',
            metadata,
          },
          metadata,
          success_url: `${BASE_URL}/portal?plan=entry_success`,
          cancel_url: `${BASE_URL}/portal?plan=cancelled`,
          locale: locale as Stripe.Checkout.SessionCreateParams.Locale,
        })
      : await stripe.checkout.sessions.create({
          // Entrada zero: nada é cobrado agora. A sessão existe só para
          // cadastrar o método e colher o mandato ACH com validade legal.
          mode: 'setup',
          customer: customerId,
          payment_method_types: ['us_bank_account', 'card'],
          setup_intent_data: { metadata },
          metadata,
          success_url: `${BASE_URL}/portal?plan=setup_success`,
          cancel_url: `${BASE_URL}/portal?plan=cancelled`,
          locale: locale as Stripe.Checkout.SessionCreateParams.Locale,
        })

    await db.from('payment_plans').update({ stripe_session_id: session.id }).eq('id', plan.id)

    await db.from('invoice_audit').insert({
      invoice_id: inv.id, action: 'installment_plan_created', performed_by: auth.userId,
      staff_level: perms.nivel,
      next: { planId: plan.id, entrada, parcelas: n, frequencia: freq, primeira: b.firstDueDate },
    }).then(() => null, () => null)

    return NextResponse.json({
      ok: true,
      planId: plan.id,
      url: session.url,
      cronograma,
      message: entrada > 0
        ? `Parcelamento de ${inv.number} criado: entrada de $${entrada.toFixed(2)} + ${n}x. Envie o link ao cliente.`
        : `Parcelamento de ${inv.number} criado: ${n}x sem entrada. O link cadastra o débito automático sem cobrar nada agora.`,
    })
  } catch (e) {
    console.error('Installment plan error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
