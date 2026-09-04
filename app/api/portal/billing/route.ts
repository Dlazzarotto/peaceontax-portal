// GET /api/portal/billing — o que o cliente logado tem para pagar, cadastrar ou assinar
//
// Só o dono do cadastro (cliente). Devolve:
//   faturas    em aberto (enviadas, com saldo), com o cronograma quando parceladas
//   planos     aguardando o cliente: entrada a pagar ou débito automático a cadastrar
//   contratos  enviados para assinatura e ainda não assinados por ele
//   historico  pagamentos recebidos
// Rascunhos nunca aparecem: enviar é ato consciente da equipe (especificação 4.3).

import { NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

async function clienteLogado(userId: string) {
  const { data } = await serviceDb()
    .from('clients').select('id, name, business_name, email, language, balance')
    .eq('user_id', userId).maybeSingle()
  return data
}

export async function GET() {
  const auth = await getAuth()
  if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
  if (auth.isStaff) return NextResponse.json({ error: 'Rota do cliente' }, { status: 403 })
  const c = await clienteLogado(auth.userId)
  if (!c) return NextResponse.json({ error: 'Cadastro não encontrado' }, { status: 404 })

  const db = serviceDb()
  const [{ data: faturas }, { data: planos }, { data: contratos }, { data: pagamentos }] = await Promise.all([
    db.from('invoices')
      .select('id, number, status, issue_date, due_date, total, paid_total, payment_plan, financier')
      .eq('client_id', c.id).eq('doc_type', 'invoice')
      .in('status', ['sent', 'partial', 'overdue', 'paid'])
      .order('issue_date', { ascending: false }).limit(50),
    db.from('payment_plans')
      .select('id, kind, status, description, total, entry_amount, entry_pct, installments, installment_amount, frequency, monthly_amount, due_day, invoice_id, next_charge_date')
      .eq('client_id', c.id).in('status', ['awaiting_entry', 'awaiting_setup'])
      .order('created_at', { ascending: false }),
    db.from('signature_requests')
      .select('id, kind, status, plan_id, created_at')
      .eq('client_id', c.id).eq('kind', 'contract').in('status', ['sent', 'delivered'])
      .order('created_at', { ascending: false }),
    db.from('invoice_payments')
      .select('id, invoice_id, amount, method, financier, received_at')
      .eq('client_id', c.id).order('received_at', { ascending: false }).limit(50),
  ])

  const abertas = (faturas || []).filter((f: any) => f.status !== 'paid' && Number(f.total) - Number(f.paid_total) > 0.009)
  const ids = abertas.map((f: any) => f.id)
  const { data: parcelas } = ids.length
    ? await db.from('invoice_installments').select('invoice_id, seq, due_date, amount, status').in('invoice_id', ids).order('seq')
    : { data: [] as any[] }

  // Contratos pendentes vêm com o plano, para o cliente saber o que está assinando
  const planIds = (contratos || []).map((s: any) => s.plan_id).filter(Boolean)
  const { data: planosDosContratos } = planIds.length
    ? await db.from('payment_plans').select('id, kind, description, total, monthly_amount, due_day, installments, installment_amount').in('id', planIds)
    : { data: [] as any[] }
  const planoPorId = new Map((planosDosContratos || []).map((p: any) => [p.id, p]))

  return NextResponse.json({
    ok: true,
    client: { id: c.id, name: c.name, business_name: c.business_name, language: c.language, balance: c.balance },
    faturas: abertas.map((f: any) => ({
      ...f, saldo: Math.round((Number(f.total) - Number(f.paid_total)) * 100) / 100,
      parcelas: (parcelas || []).filter((p: any) => p.invoice_id === f.id),
      // Fatura parcelada tem plano próprio: o botão certo é cadastrar o débito, não pagar à vista
      plano: (planos || []).find((p: any) => p.invoice_id === f.id) || null,
    })),
    planos: planos || [],
    contratos: (contratos || []).map((s: any) => ({ ...s, plano: planoPorId.get(s.plan_id) || null })),
    historico: (pagamentos || []).map((p: any) => ({
      ...p, number: (faturas || []).find((f: any) => f.id === p.invoice_id)?.number || null,
    })),
  })
}
