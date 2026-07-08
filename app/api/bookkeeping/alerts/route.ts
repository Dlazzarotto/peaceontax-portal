// GET /api/bookkeeping/alerts — resumo para o dashboard da equipe:
// clientes com transações em aberto + alertas de planos não resolvidos

import { NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'

export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const db = serviceDb()

  // Transações pendentes agrupadas por cliente
  const { data: pending } = await db
    .from('bank_transactions')
    .select('client_id, clients(name)')
    .eq('status', 'pending')
    .limit(5000)

  const byClient: Record<string, { name: string; count: number }> = {}
  for (const t of (pending || []) as any[]) {
    const id = t.client_id
    if (!byClient[id]) byClient[id] = { name: t.clients?.name || 'Cliente', count: 0 }
    byClient[id].count++
  }
  const openTransactions = Object.entries(byClient)
    .map(([clientId, v]) => ({ clientId, ...v }))
    .sort((a, b) => b.count - a.count)

  // Alertas de planos não resolvidos (falha de débito etc.)
  const { data: alerts } = await db
    .from('plan_alerts')
    .select('id, client_id, type, message, created_at')
    .eq('resolved', false)
    .order('created_at', { ascending: false })
    .limit(20)

  return NextResponse.json({
    openTransactions,
    totalOpen: openTransactions.reduce((s, c) => s + c.count, 0),
    planAlerts: alerts || [],
  })
}
