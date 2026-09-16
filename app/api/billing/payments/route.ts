// /api/billing/payments
//
// POST { invoiceId, amount, method, reference?, receivedAt?, financier? }
//   → registra o recebimento. O saldo e a situação da fatura são
//     atualizados pelo próprio banco (gatilho).
//
// Só gerente ou sócio: quem emite não dá baixa.
// Dinheiro, Zelle e Venmo são à vista — o banco recusa valor parcial.
//
// Fatura com cobrança automática no Stripe (mensalidade ou parcelamento):
// o recebimento manual (Zelle, dinheiro…) tem de TIRAR a fatura da linha de
// cobrança, senão o Stripe cobra de novo. Por isso ele só é aceito em três
// formas, todas fechadas:
//   1. mensalidade: o saldo inteiro → a invoice do Stripe é marcada como
//      paga fora dele e o débito para;
//   2. parcelamento: o valor exato de uma parcela cujo débito FALHOU (NSF)
//      → a parcela é liquidada e a invoice dela sai da linha;
//   3. parcelamento: o saldo inteiro → quitação antecipada: cancela o débito,
//      liquida as parcelas restantes e conclui o plano.
// Parcela avulsa que o Stripe ainda vai cobrar não se recebe à mão.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { permissoesFinanceiro, RECUSA } from '@/lib/billing-perms'
import { parcelamentoVivo, encerrarParcelamento } from '@/lib/parcelamento'

export const dynamic = 'force-dynamic'

const MANUAIS = ['zelle', 'venmo', 'cash', 'check', 'wire', 'external', 'other']

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)

  const invoiceId = req.nextUrl.searchParams.get('invoiceId')
  if (!invoiceId) return NextResponse.json({ error: 'invoiceId obrigatório' }, { status: 400 })

  const db = serviceDb()
  const [{ data, error }, { data: inv }, { data: falhas }] = await Promise.all([
    db.from('invoice_payments')
      .select('id, amount, method, reference, received_at, stripe_object')
      .eq('invoice_id', invoiceId).order('received_at', { ascending: false }),
    db.from('invoices').select('stripe_invoice, status, total, paid_total').eq('id', invoiceId).maybeSingle(),
    db.from('invoice_installments').select('seq, amount, last_error, attempts')
      .eq('invoice_id', invoiceId).eq('status', 'failed').order('seq'),
  ])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Situação da cobrança automática, para a tela mostrar o que pode ser feito
  const aberta = !!inv && !['paid', 'void', 'draft'].includes(inv.status)
  const cobranca = {
    automatica: !!inv?.stripe_invoice || (falhas || []).length > 0,
    falhas: (falhas || []).map((f: any) => ({ seq: f.seq, valor: Number(f.amount), motivo: f.last_error, tentativas: f.attempts })),
    podeCobrarDeNovo: aberta && (!!inv?.stripe_invoice || (falhas || []).length > 0),
  }
  return NextResponse.json({ payments: data || [], perms, cobranca })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  if (!perms.receber) return NextResponse.json({ error: RECUSA.receber }, { status: 403 })

  const b = await req.json()

  // ── Estorno ──
  if (b.action === 'refund') {
    if (!perms.estornar) return NextResponse.json({ error: RECUSA.estornar }, { status: 403 })
    if (!b.paymentId) return NextResponse.json({ error: 'paymentId obrigatório' }, { status: 400 })

    const dbR = serviceDb()
    const { data: pag } = await dbR.from('invoice_payments')
      .select('*').eq('id', b.paymentId).single()
    if (!pag) return NextResponse.json({ error: 'Pagamento não encontrado' }, { status: 404 })

    const motivo = String(b.reason || '').trim()

    // Sócio estorna direto; gerente confirma com senha e justifica
    if (perms.nivel === 'manager') {
      if (motivo.length < 5) {
        return NextResponse.json({ error: 'Descreva o motivo do estorno (mínimo 5 caracteres).' }, { status: 400 })
      }
      if (!b.password) return NextResponse.json({ error: 'Confirme com a sua senha.' }, { status: 400 })

      const { data: quem } = await dbR.auth.admin.getUserById(auth.userId)
      const email = quem?.user?.email
      if (!email) return NextResponse.json({ error: 'Não foi possível identificar seu login.' }, { status: 400 })

      const sbAuth = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      )
      const { error: pwErr } = await sbAuth.auth.signInWithPassword({
        email, password: String(b.password).trim(),
      })
      if (pwErr) {
        const m = pwErr.message || ''
        if (/rate|too many|429/i.test(m)) {
          return NextResponse.json({ error: 'Muitas tentativas. Aguarde 1 minuto.' }, { status: 429 })
        }
        return NextResponse.json({ error: `Senha não confere para ${email}.` }, { status: 401 })
      }
    }

    await dbR.from('payment_reversals').insert({
      invoice_id: pag.invoice_id, amount: pag.amount, method: pag.method,
      reference: pag.reference, stripe_object: pag.stripe_object,
      reason: motivo || 'estorno pelo sócio',
      performed_by: auth.userId, staff_level: perms.nivel,
    }).then(() => null, () => null)

    const { error: delErr } = await dbR.from('invoice_payments').delete().eq('id', b.paymentId)
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })

    await dbR.from('invoice_audit').insert({
      invoice_id: pag.invoice_id, action: 'payment_reversed', performed_by: auth.userId,
      staff_level: perms.nivel, reason: motivo || null,
      previous: { amount: pag.amount, method: pag.method },
    }).then(() => null, () => null)

    const avisoStripe = pag.stripe_object
      ? ' ⚠️ Este pagamento veio do Stripe: a devolução do dinheiro ao cliente precisa ser feita no painel do Stripe (Refund).'
      : ''
    return NextResponse.json({
      ok: true,
      message: `Estorno de $${Number(pag.amount).toFixed(2)} registrado. A fatura voltou a ficar em aberto.${avisoStripe}`,
    })
  }

  const valor = Math.round((Number(b.amount) || 0) * 100) / 100
  if (!b.invoiceId) return NextResponse.json({ error: 'invoiceId obrigatório' }, { status: 400 })
  if (valor <= 0) return NextResponse.json({ error: 'Informe o valor recebido.' }, { status: 400 })

  const method = String(b.method || '')
  if (!['card', 'ach', ...MANUAIS].includes(method)) {
    return NextResponse.json({ error: 'Forma de pagamento inválida.' }, { status: 400 })
  }

  const db = serviceDb()
  const { data: inv } = await db.from('invoices')
    .select('id, client_id, number, total, paid_total, status, stripe_invoice').eq('id', b.invoiceId).single()
  if (!inv) return NextResponse.json({ error: 'Fatura não encontrada' }, { status: 404 })
  if (inv.status === 'void') return NextResponse.json({ error: 'Fatura cancelada não recebe pagamento.' }, { status: 409 })

  const saldo = Math.round((Number(inv.total) - Number(inv.paid_total)) * 100) / 100
  if (valor > saldo + 0.005) {
    return NextResponse.json({
      error: `Valor acima do saldo desta fatura ($${saldo.toFixed(2)}).`,
    }, { status: 400 })
  }

  const iguais = (a: number, c: number) => Math.abs(a - c) < 0.005
  const stripeMensal: string | null = (inv as any).stripe_invoice || null

  // Parcelamento em andamento nesta fatura? (lib/parcelamento: a mesma
  // pergunta em todos os caminhos, e sem maybeSingle() — dois planos na
  // mesma fatura davam erro e a fatura passava como se não tivesse nenhum)
  const plano = await parcelamentoVivo(db, inv.id)

  // Parcela cujo débito falhou (a mais antiga): pode ser recebida por fora
  let parcelaFalha: any = null
  if (plano) {
    const { data: f } = await db.from('invoice_installments')
      .select('id, seq, amount, stripe_invoice').eq('invoice_id', inv.id).eq('status', 'failed')
      .order('seq').limit(1).maybeSingle()
    parcelaFalha = f || null
  }

  const quitacao = !!plano && iguais(valor, saldo)
  const parcelaPorFora = !!plano && !quitacao && !!parcelaFalha && iguais(valor, Number(parcelaFalha.amount))
  if (plano && !quitacao && !parcelaPorFora) {
    return NextResponse.json({
      error: parcelaFalha
        ? `Fatura parcelada com débito automático. Recebimento manual só da parcela ${parcelaFalha.seq} que falhou ($${Number(parcelaFalha.amount).toFixed(2)}) ou do saldo inteiro ($${saldo.toFixed(2)}, quitação antecipada).`
        : `Fatura parcelada com débito automático. Recebimento manual só para quitar o saldo inteiro ($${saldo.toFixed(2)}) — a quitação antecipada encerra o débito. Parcela que o Stripe ainda vai cobrar não se recebe à mão.`,
    }, { status: 409 })
  }
  if (!plano && stripeMensal && !iguais(valor, saldo)) {
    return NextResponse.json({
      error: `Esta fatura de mensalidade está na cobrança automática do Stripe. Recebimento manual só do saldo inteiro ($${saldo.toFixed(2)}): assim ela sai da linha de cobrança e o débito não acontece.`,
    }, { status: 409 })
  }

  const { error } = await db.from('invoice_payments').insert({
    invoice_id: inv.id,
    client_id: inv.client_id,
    amount: valor,
    method,
    reference: b.reference || null,
    financier: method === 'external' ? (b.financier || null) : null,
    received_at: b.receivedAt ? new Date(b.receivedAt).toISOString() : new Date().toISOString(),
    created_by: auth.userId,
  })
  if (error) {
    // O gatilho do banco devolve a mensagem de "à vista" com o valor certo
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  await db.from('invoice_audit').insert({
    invoice_id: inv.id, action: 'payment', performed_by: auth.userId,
    staff_level: perms.nivel, next: { amount: valor, method },
  }).then(() => null, () => null)

  let notaQuitacao = ''
  if (plano && quitacao) {
    const r = await encerrarParcelamento(db, stripeCli(), plano, inv.id,
      { motivo: 'quitacao', performedBy: auth.userId })
    notaQuitacao = r.nota
  }
  else if (plano && parcelaPorFora) notaQuitacao = await liquidarParcelaPorFora(db, plano, parcelaFalha, auth.userId)
  else if (!plano && stripeMensal) notaQuitacao = await tirarDaLinha(stripeMensal)
    ? ' · saiu da linha de cobrança do Stripe'
    : ' · ATENÇÃO: não consegui avisar o Stripe — marque a invoice como paga fora dele no painel, senão o débito acontece'

  const restante = Math.round((saldo - valor) * 100) / 100
  return NextResponse.json({
    ok: true,
    message: (restante > 0
      ? `Recebido $${valor.toFixed(2)} em ${inv.number} · saldo $${restante.toFixed(2)}`
      : `${inv.number} quitada com $${valor.toFixed(2)}`) + notaQuitacao,
  })
}

const stripeCli = () => new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' as Stripe.LatestApiVersion })

/** Invoice do Stripe marcada como paga fora dele: para de tentar cobrar. */
async function tirarDaLinha(stripeInvoice: string): Promise<boolean> {
  try { await stripeCli().invoices.pay(stripeInvoice, { paid_out_of_band: true }); return true }
  catch (e) { console.error('paid_out_of_band:', (e as Error).message); return false }
}

/**
 * Parcela que falhou (NSF) recebida por fora: liquida a parcela, tira a
 * invoice dela da linha do Stripe e conta a parcela no plano. Se era a
 * última, o plano conclui.
 */
async function liquidarParcelaPorFora(db: any, plano: any, parcela: any, userId: string): Promise<string> {
  const agora = new Date().toISOString()
  await db.from('invoice_installments').update({ status: 'paid', paid_at: agora }).eq('id', parcela.id)
  const pagas = Number(plano.paid_installments || 0) + 1
  const concluiu = pagas >= Number(plano.installments)
  await db.from('payment_plans').update({
    paid_installments: pagas,
    status: concluiu ? 'completed' : 'active',
    updated_at: agora,
  }).eq('id', plano.id)
  await db.from('plan_audit').insert({
    plan_id: plano.id, action: 'installment_paid_out_of_band', performed_by: userId,
    snapshot: { parcela: parcela.seq, stripe_invoice: parcela.stripe_invoice || null },
  }).then(() => null, () => null)

  let stripeOk = true
  if (parcela.stripe_invoice) stripeOk = await tirarDaLinha(parcela.stripe_invoice)
  if (concluiu) {
    try {
      if (plano.stripe_schedule_id) await stripeCli().subscriptionSchedules.cancel(plano.stripe_schedule_id)
      else if (plano.stripe_subscription_id) await stripeCli().subscriptions.cancel(plano.stripe_subscription_id)
    } catch (e) { stripeOk = false; console.error('encerrar plano:', (e as Error).message) }
  }
  return (stripeOk
    ? ` · parcela ${parcela.seq}/${plano.installments} liquidada por fora; saiu da linha de cobrança`
    : ` · parcela ${parcela.seq}/${plano.installments} liquidada, MAS o Stripe não foi avisado — marque a invoice como paga fora dele no painel`)
    + (concluiu ? ' · parcelamento concluído' : '')
}


