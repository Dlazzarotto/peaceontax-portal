// POST /api/billing/installment-plan — transforma uma fatura em aberto em parcelamento
//
// Body: { invoiceId, entryAmount?, entryPct?, installments, frequency, firstDueDate }
//   entryAmount  ENTRADA EM DÓLAR, como a equipe digita (0 = sem entrada)
//   entryPct     formato antigo, em porcentagem; entryAmount tem precedência
//   frequency    weekly | biweekly | monthly
//   firstDueDate data da 1ª parcela, escolhida no acordo
//
// Entrada > 0  → Checkout mode 'payment': cobra a entrada e salva o método
// Entrada = 0  → Checkout mode 'setup': cadastra método e mandato ACH sem cobrar
//
// Em ambos, o agendamento das parcelas é criado pelo webhook, depois que
// o método existe. Aqui só nasce o plano e o cronograma da fatura. A sessão
// vem de lib/plan-checkout.ts, e o cliente é avisado por e-mail e no portal
// para cadastrar o débito pelo portal (o link do Checkout expira em 24h).
//
// PATCH { planId, action: 'cancel', motivo, password } — CANCELA o parcelamento
//   O acordo desandou e o cliente vai pagar de outro jeito. Para o débito no
//   Stripe, anula as invoices de parcela já abertas, cancela o cronograma e
//   DEIXA A FATURA EM ABERTO com o saldo que falta. O que já foi pago fica
//   pago: cancelar para a cobrança futura, nunca desfaz recebimento — isso é
//   estorno e tem rotina própria.
//
// Só gerente ou sócio.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { permissoesFinanceiro, RECUSA } from '@/lib/billing-perms'
import { avancarData, type Frequency } from '@/lib/plans'
import { criarSessaoDoPlano, stripeClient } from '@/lib/plan-checkout'
import { enviarEmail, avisarNoPortal, emailComMarca, APP_URL } from '@/lib/avisos'
import { encerrarParcelamento } from '@/lib/parcelamento'
import { entradaDoPedido } from '@/lib/entrada-parcelamento'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://peaceontax-portal.vercel.app'
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

// avancarData (lib/plans.ts) trata mês curto: ver comentário lá.

/** Cronograma: base para todas, última absorve o centavo da divisão. */
function montarCronograma(restante: number, n: number, primeira: string, freq: Frequency) {
  const base = Math.floor((restante / n) * 100) / 100
  const linhas: { seq: number; due_date: string; amount: number }[] = []
  const inicio = new Date(`${primeira}T12:00:00Z`)
  for (let i = 0; i < n; i++) {
    linhas.push({
      seq: i + 1,
      due_date: avancarData(inicio, freq, i).toISOString().slice(0, 10),
      amount: i === n - 1 ? round2(restante - base * (n - 1)) : base,
    })
  }
  return linhas
}

// GET → parcelamentos existentes + faturas elegíveis para parcelar
export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  const db = serviceDb()

  const [{ data: planos }, { data: faturas }] = await Promise.all([
    db.from('payment_plans')
      .select('id, invoice_id, status, total, entry_pct, entry_amount, frequency, installments, installment_amount, paid_installments, next_charge_date, stripe_session_id, created_at, clients(name, business_name), invoices(number, total, paid_total)')
      .eq('kind', 'installment')
      .not('invoice_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200),
    // Faturas que podem ser parceladas: fatura (não orçamento), não cancelada,
    // não rascunho, e com saldo em aberto.
    db.from('invoices')
      .select('id, number, total, paid_total, issue_date, clients(name, business_name)')
      .eq('doc_type', 'invoice')
      .not('status', 'in', '(void,draft,paid)')
      .order('issue_date', { ascending: false })
      .limit(200),
  ])

  // Fatura que já tem parcelamento vivo sai da lista de elegíveis
  const VIVOS = ['draft', 'awaiting_entry', 'awaiting_setup', 'active', 'payment_failed']
  const ocupadas = new Set(
    (planos || []).filter((p: any) => VIVOS.includes(p.status)).map((p: any) => p.invoice_id),
  )

  return NextResponse.json({
    perms,
    plans: (planos || []).map((p: any) => ({
      ...p,
      cliente: p.clients?.business_name || p.clients?.name || '—',
      numero: p.invoices?.number || '—',
    })),
    invoices: (faturas || [])
      .map((i: any) => ({
        id: i.id, number: i.number,
        cliente: i.clients?.business_name || i.clients?.name || '—',
        saldo: round2(Number(i.total) - Number(i.paid_total)),
      }))
      .filter((i: any) => i.saldo > 0 && !ocupadas.has(i.id)),
  })
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

  // A entrada vem em DÓLAR (lib/entrada-parcelamento.ts faz a conta e a
  // porcentagem). A validação só é possível aqui, depois de saber o saldo.
  const res = entradaDoPedido({ saldo, entryAmount: b.entryAmount, entryPct: b.entryPct })
  if ('erro' in res) return NextResponse.json({ error: res.erro }, { status: 400 })
  const { entrada, pct: entryPct, restante } = res

  const cronograma = montarCronograma(restante, n, String(b.firstDueDate), freq)
  const valorParcela = cronograma[0].amount

  const client = (inv as any).clients || {}
  const lang = client.language || 'en'
  const stripe = stripeClient()

  try {
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
      // Data acordada da 1ª parcela. O webhook lê daqui em vez de derivar
      // da data em que a entrada foi paga.
      next_charge_date: String(b.firstDueDate),
      created_by: auth.userId,
    }).select('*').single()

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

    // ── sessão Stripe (mesma regra do portal: lib/plan-checkout) ──
    const { url: sessionUrl, sessionId } = await criarSessaoDoPlano(db, stripe, { ...plan, clients: client }, {
      origem: 'equipe', performedBy: auth.userId, baseUrl: BASE_URL,
    })
    const session = { id: sessionId, url: sessionUrl }

    // ── o cliente fica sabendo na hora: e-mail + aviso no portal ──
    // O link do Checkout expira em 24h; o e-mail leva ao portal, onde o
    // cliente gera a sessão na hora em que clicar.
    const valorParcelaFmt = `$${valorParcela.toFixed(2)}`
    const textoPortal = lang === 'pt'
      ? `📆 Sua fatura ${inv.number} foi parcelada em ${n}x de ${valorParcelaFmt}${entrada > 0 ? `, com entrada de $${entrada.toFixed(2)}` : ''}. Em Pagamentos, cadastre o débito automático (conta bancária ou cartão).`
      : lang === 'es'
      ? `📆 Su factura ${inv.number} fue dividida en ${n} cuotas de ${valorParcelaFmt}${entrada > 0 ? `, con anticipo de $${entrada.toFixed(2)}` : ''}. En Pagos, registre el débito automático (cuenta bancaria o tarjeta).`
      : `📆 Your invoice ${inv.number} was split into ${n} installments of ${valorParcelaFmt}${entrada > 0 ? `, with a down payment of $${entrada.toFixed(2)}` : ''}. Under Payments, set up automatic debit (bank account or card).`
    await avisarNoPortal(db, inv.client_id, textoPortal)
    if (client.email) {
      await enviarEmail(client.email,
        lang === 'pt' ? `Fatura ${inv.number} parcelada — cadastre o débito automático` : lang === 'es' ? `Factura ${inv.number} en cuotas — registre el débito automático` : `Invoice ${inv.number} installment plan — set up automatic debit`,
        emailComMarca({ lang, nome: client.name, corpoHtml: `<p>${textoPortal.replace(/^📆 /, '')}</p>`,
          botao: { texto: lang === 'pt' ? 'Cadastrar débito automático' : lang === 'es' ? 'Registrar débito automático' : 'Set up automatic debit', url: `${APP_URL}/portal/payments` } }))
    }

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

// ── Cancelar o parcelamento, com a fatura seguindo em aberto ──
export async function PATCH(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  if (!perms.cancelar) return NextResponse.json({ error: RECUSA.cancelar }, { status: 403 })

  const b = await req.json().catch(() => ({} as any))
  if (b.action !== 'cancel') return NextResponse.json({ error: 'Ação desconhecida.' }, { status: 400 })
  if (!b.planId) return NextResponse.json({ error: 'planId obrigatório' }, { status: 400 })

  const motivo = String(b.motivo || '').trim()
  if (motivo.length < 5) {
    return NextResponse.json({
      error: 'Descreva por que o parcelamento está sendo cancelado (mínimo 5 caracteres). Fica na trilha do plano.',
    }, { status: 400 })
  }
  if (!b.password) return NextResponse.json({ error: 'Confirme com a sua senha.' }, { status: 400 })

  const db = serviceDb()

  // Senha da própria pessoa: parar uma régua de cobrança é ação sensível
  // (princípio 3) e não pode sair de uma tela destravada no balcão.
  {
    const { data: quem } = await db.auth.admin.getUserById(auth.userId)
    const email = quem?.user?.email
    if (!email) return NextResponse.json({ error: 'Não foi possível identificar seu login.' }, { status: 400 })
    const sbAuth = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
    const { error: pwErr } = await sbAuth.auth.signInWithPassword({ email, password: String(b.password).trim() })
    if (pwErr) {
      const m = pwErr.message || ''
      if (/rate|too many|429/i.test(m)) {
        return NextResponse.json({ error: 'Muitas tentativas. Aguarde 1 minuto.' }, { status: 429 })
      }
      return NextResponse.json({ error: `Senha não confere para ${email}.` }, { status: 401 })
    }
  }

  const { data: plano } = await db.from('payment_plans')
    .select('id, invoice_id, client_id, status, kind, installments, paid_installments, stripe_schedule_id, stripe_subscription_id')
    .eq('id', b.planId).eq('kind', 'installment').maybeSingle()
  if (!plano) return NextResponse.json({ error: 'Parcelamento não encontrado.' }, { status: 404 })
  if (!plano.invoice_id) {
    return NextResponse.json({ error: 'Este plano não está ligado a uma fatura.' }, { status: 409 })
  }
  // Já encerrado: dizer isso é melhor que rodar de novo e tentar cancelar no
  // Stripe uma assinatura que não existe mais.
  if (['cancelled', 'completed'].includes(String(plano.status))) {
    return NextResponse.json({
      error: `Este parcelamento já está ${plano.status === 'completed' ? 'concluído' : 'cancelado'}.`,
    }, { status: 409 })
  }

  const { data: inv } = await db.from('invoices')
    .select('id, number, total, paid_total, clients(name, email, language)')
    .eq('id', plano.invoice_id).maybeSingle()
  if (!inv) return NextResponse.json({ error: 'Fatura do parcelamento não encontrada.' }, { status: 404 })

  const r = await encerrarParcelamento(db, stripeClient(), plano, plano.invoice_id, {
    motivo: 'plano_cancelado', performedBy: auth.userId, razao: motivo,
  })

  const saldo = round2(Number(inv.total) - Number(inv.paid_total))

  await db.from('invoice_audit').insert({
    invoice_id: inv.id, action: 'installment_plan_cancelled', performed_by: auth.userId,
    staff_level: perms.nivel, reason: motivo,
    next: { planId: plano.id, saldoEmAberto: saldo, stripeOk: r.stripeOk, parcelasFechadas: r.parcelasFechadas },
  }).then(() => null, () => null)

  // O cliente tinha um acordo e o débito automático dele. Se o acordo acabou,
  // ele precisa saber ANTES de estranhar o débito que não veio.
  const client = (inv as any).clients || {}
  const lang = (client.language || 'en').toLowerCase()
  const texto = lang === 'pt'
    ? `📆 O parcelamento da fatura ${inv.number} foi encerrado e o débito automático não será mais cobrado. Saldo em aberto: $${saldo.toFixed(2)}. Fale com a nossa equipe para combinar o pagamento.`
    : lang === 'es'
    ? `📆 El plan de cuotas de la factura ${inv.number} fue cancelado y el débito automático ya no se cobrará. Saldo pendiente: $${saldo.toFixed(2)}. Hable con nuestro equipo para acordar el pago.`
    : `📆 The installment plan for invoice ${inv.number} was ended and automatic debit will no longer be charged. Outstanding balance: $${saldo.toFixed(2)}. Please contact our team to arrange payment.`
  await avisarNoPortal(db, plano.client_id, texto)
  if (client.email) {
    await enviarEmail(client.email,
      lang === 'pt' ? `Parcelamento da fatura ${inv.number} encerrado`
      : lang === 'es' ? `Plan de cuotas de la factura ${inv.number} cancelado`
      : `Installment plan for invoice ${inv.number} ended`,
      emailComMarca({ lang, nome: client.name, corpoHtml: `<p>${texto.replace(/^📆 /, '')}</p>`,
        botao: { texto: lang === 'pt' ? 'Ver em Pagamentos' : lang === 'es' ? 'Ver en Pagos' : 'View in Payments',
          url: `${APP_URL}/portal/payments` } }))
  }

  return NextResponse.json({
    ok: true,
    saldo,
    message: `Parcelamento de ${inv.number} cancelado. Saldo em aberto: $${saldo.toFixed(2)}.${r.nota}`,
  })
}
