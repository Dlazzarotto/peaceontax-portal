// /api/billing/payments
//
// POST { invoiceId, amount, method, reference?, receivedAt?, financier? }
//   → registra o recebimento. O saldo e a situação da fatura são
//     atualizados pelo próprio banco (gatilho).
//
// Só gerente ou sócio: quem emite não dá baixa.
// Dinheiro, Zelle e Venmo são à vista — o banco recusa valor parcial.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { permissoesFinanceiro, RECUSA } from '@/lib/billing-perms'

export const dynamic = 'force-dynamic'

const MANUAIS = ['zelle', 'venmo', 'cash', 'check', 'wire', 'external', 'other']

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)

  const invoiceId = req.nextUrl.searchParams.get('invoiceId')
  if (!invoiceId) return NextResponse.json({ error: 'invoiceId obrigatório' }, { status: 400 })

  const { data, error } = await serviceDb().from('invoice_payments')
    .select('id, amount, method, reference, received_at, stripe_object')
    .eq('invoice_id', invoiceId).order('received_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ payments: data || [], perms })
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
    .select('id, client_id, number, total, paid_total, status').eq('id', b.invoiceId).single()
  if (!inv) return NextResponse.json({ error: 'Fatura não encontrada' }, { status: 404 })
  if (inv.status === 'void') return NextResponse.json({ error: 'Fatura cancelada não recebe pagamento.' }, { status: 409 })

  const saldo = Math.round((Number(inv.total) - Number(inv.paid_total)) * 100) / 100
  if (valor > saldo + 0.005) {
    return NextResponse.json({
      error: `Valor acima do saldo desta fatura ($${saldo.toFixed(2)}).`,
    }, { status: 400 })
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

  const restante = Math.round((saldo - valor) * 100) / 100
  return NextResponse.json({
    ok: true,
    message: restante > 0
      ? `Recebido $${valor.toFixed(2)} em ${inv.number} · saldo $${restante.toFixed(2)}`
      : `${inv.number} quitada com $${valor.toFixed(2)}`,
  })
}
