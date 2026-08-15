// /api/billing/recurring — contratos recorrentes (bookkeeping mensal etc.)
//
// GET                                  → contratos + clientes + serviços
// POST   { clientId, description, amount, interval, dayOfMonth, startDate, autoCharge }
// PATCH  { id, active?, amount?, dayOfMonth?, autoCharge? }
//
// Criar/editar contrato é de gerente ou sócio: define quanto o cliente
// paga todo mês. Cobrança automática exige cartão/ACH salvo (trava no banco).

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { permissoesFinanceiro } from '@/lib/billing-perms'

export const dynamic = 'force-dynamic'

const INTERVALOS = ['monthly', 'quarterly', 'annual']

function proximaCobranca(dia: number, inicio: string): string {
  const hoje = new Date()
  const base = new Date(`${inicio}T12:00:00Z`)
  const d = base > hoje ? base : hoje
  const alvo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dia, 12))
  if (alvo <= hoje) alvo.setUTCMonth(alvo.getUTCMonth() + 1)
  return alvo.toISOString().slice(0, 10)
}

export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)

  const db = serviceDb()
  const [{ data: planos, error }, { data: clients }] = await Promise.all([
    db.from('recurring_plans')
      .select('id, client_id, description, amount, interval, day_of_month, start_date, end_date, auto_charge, next_run, active, clients(business_name, name)')
      .order('active', { ascending: false })
      .order('next_run'),
    db.from('clients').select('id, business_name, name').eq('active', true).order('name'),
  ])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    plans: (planos || []).map((p: any) => ({
      ...p, cliente: p.clients?.business_name || p.clients?.name || '—',
    })),
    clients: (clients || []).map((c: any) => ({ id: c.id, nome: c.business_name || c.name })),
    perms,
  })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  if (!perms.receber) {
    return NextResponse.json({ error: 'Criar contrato é de gerente ou sócio.' }, { status: 403 })
  }

  const b = await req.json()
  const valor = Math.round((Number(b.amount) || 0) * 100) / 100
  const dia = Math.max(1, Math.min(28, Number(b.dayOfMonth) || 1))
  const inicio = b.startDate || new Date().toISOString().slice(0, 10)

  if (!b.clientId) return NextResponse.json({ error: 'Escolha o cliente.' }, { status: 400 })
  if (!String(b.description || '').trim()) return NextResponse.json({ error: 'Descreva o serviço do contrato.' }, { status: 400 })
  if (valor <= 0) return NextResponse.json({ error: 'Informe o valor mensal.' }, { status: 400 })
  const interval = INTERVALOS.includes(b.interval) ? b.interval : 'monthly'

  const { error } = await serviceDb().from('recurring_plans').insert({
    client_id: b.clientId,
    description: String(b.description).trim(),
    amount: valor,
    interval,
    day_of_month: dia,
    start_date: inicio,
    auto_charge: !!b.autoCharge,
    payment_method_id: b.paymentMethodId || null,
    next_run: proximaCobranca(dia, inicio),
    active: true,
  })
  if (error) {
    // O gatilho do banco recusa auto-cobrança sem cartão/ACH salvo
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({
    ok: true,
    message: `Contrato criado · próxima cobrança dia ${dia}`,
  })
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  if (!perms.receber) {
    return NextResponse.json({ error: 'Alterar contrato é de gerente ou sócio.' }, { status: 403 })
  }

  const b = await req.json()
  if (!b.id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const upd: Record<string, unknown> = {}
  if (b.active !== undefined) upd.active = !!b.active
  if (b.amount !== undefined) upd.amount = Math.round(Number(b.amount) * 100) / 100
  if (b.dayOfMonth !== undefined) upd.day_of_month = Math.max(1, Math.min(28, Number(b.dayOfMonth)))
  if (b.autoCharge !== undefined) upd.auto_charge = !!b.autoCharge
  if (Object.keys(upd).length === 0) return NextResponse.json({ error: 'Nada para alterar.' }, { status: 400 })

  const { error } = await serviceDb().from('recurring_plans').update(upd).eq('id', b.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true, message: 'Contrato atualizado.' })
}
