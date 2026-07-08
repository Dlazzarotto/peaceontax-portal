// GET /api/bookkeeping/overview — central de bookkeeping (equipe)
// Por cliente: status do trabalho (sem_comecar | em_aberto | pronto),
// contadores de transações, contrato ativo e contador anual vs limite.

import { NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'

export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const db = serviceDb()
  const year = new Date().getFullYear()

  const [{ data: plans }, { data: txs }, { data: statements }, { data: alerts }] = await Promise.all([
    db.from('payment_plans')
      .select('client_id, monthly_amount, included_transactions, status, clients(id, name)')
      .eq('kind', 'bookkeeping')
      .in('status', ['active', 'paused', 'payment_failed']),
    db.from('bank_transactions')
      .select('client_id, status, fiscal_year')
      .limit(50000),
    db.from('documents')
      .select('id, client_id')
      .ilike('category', '%bank%'),
    db.from('plan_alerts')
      .select('id, client_id, type, message, created_at')
      .eq('resolved', false)
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  // Clientes relevantes: com contrato OU com transações OU com extratos
  const clientIds = new Set<string>()
  for (const p of plans || []) clientIds.add(p.client_id)
  for (const t of txs || []) clientIds.add(t.client_id)
  for (const s of statements || []) clientIds.add(s.client_id)

  // Nomes dos clientes sem contrato
  const missingNames = Array.from(clientIds).filter(id =>
    !(plans || []).some(p => p.client_id === id))
  let nameMap: Record<string, string> = {}
  if (missingNames.length > 0) {
    const { data: cs } = await db.from('clients').select('id, name').in('id', missingNames)
    for (const c of cs || []) nameMap[c.id] = c.name
  }
  for (const p of (plans || []) as any[]) nameMap[p.client_id] = p.clients?.name || nameMap[p.client_id]

  const rows = Array.from(clientIds).map(id => {
    const clientTxs = (txs || []).filter(t => t.client_id === id)
    const forReview = clientTxs.filter(t => ['pending', 'auto'].includes(t.status)).length
    const inRegister = clientTxs.filter(t => ['approved', 'reviewed'].includes(t.status)).length
    const total = clientTxs.filter(t => t.status !== 'excluded').length
    const yearCount = clientTxs.filter(t => t.fiscal_year === year && t.status !== 'excluded').length
    const plan = (plans || []).find(p => p.client_id === id) as any
    const hasStatements = (statements || []).some(s => s.client_id === id)

    let workStatus: 'sem_comecar' | 'em_aberto' | 'pronto'
    if (total === 0) workStatus = 'sem_comecar'
    else if (forReview > 0) workStatus = 'em_aberto'
    else workStatus = 'pronto'

    return {
      clientId: id,
      name: nameMap[id] || 'Cliente',
      workStatus,
      forReview, inRegister, total,
      yearCount, yearLimit: plan?.included_transactions ?? null,
      contract: plan ? {
        monthly: plan.monthly_amount,
        status: plan.status,
      } : null,
      hasStatements,
    }
  }).sort((a, b) => {
    const order = { em_aberto: 0, sem_comecar: 1, pronto: 2 }
    return order[a.workStatus] - order[b.workStatus] || b.forReview - a.forReview
  })

  return NextResponse.json({
    clients: rows,
    counts: {
      em_aberto: rows.filter(r => r.workStatus === 'em_aberto').length,
      sem_comecar: rows.filter(r => r.workStatus === 'sem_comecar').length,
      pronto: rows.filter(r => r.workStatus === 'pronto').length,
    },
    alerts: alerts || [],
    year,
  })
}
