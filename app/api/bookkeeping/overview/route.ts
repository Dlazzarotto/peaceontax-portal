// GET /api/bookkeeping/overview — central de bookkeeping (equipe)
// Por cliente: status do trabalho (sem_comecar | em_aberto | pronto),
// contadores de transações, contrato ativo e contador anual vs limite.

import { NextResponse } from 'next/server'
import { getAuth, serviceDb, clientesOcultos } from '@/lib/api-auth'
import { dataDaFirma } from '@/lib/dia-da-firma'
import { vigenciaNoAno, apurarExcedente } from '@/lib/excedente-transacoes'

// Lê TODOS os lançamentos, em páginas de 1000 com `order`. Era
// `.limit(50000)`: o PostgREST tem teto próprio (1000 por padrão, ver o
// conserto de PATCH /api/bookkeeping/rules) e corta EM SILÊNCIO — a central
// contaria só parte da carteira, sem dizer qual parte.
async function todosOsLancamentos(db: any) {
  const PAGINA = 1000
  const linhas: { client_id: string; status: string; fiscal_year: number | null; tx_date: string | null }[] = []
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await db.from('bank_transactions')
      .select('client_id, status, fiscal_year, tx_date')
      .order('id')
      .range(de, de + PAGINA - 1)
    if (error) return { linhas, erro: error.message as string }
    linhas.push(...(data || []))
    if (!data || data.length < PAGINA) break
  }
  return { linhas, erro: null as string | null }
}

export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const db = serviceDb()
  // O ano do ESCRITÓRIO, não o do servidor em UTC (na virada do ano, às 21h
  // de Malden o servidor já está no ano seguinte).
  const hoje = dataDaFirma()
  const year = Number(hoje.slice(0, 4))

  const [
    { data: plans, error: errPlans },
    { linhas: txs, erro: errTxs },
    { data: statements, error: errDocs },
    { data: alerts, error: errAlerts },
  ] = await Promise.all([
    db.from('payment_plans')
      .select('client_id, monthly_amount, included_transactions, overage_rate, created_at, due_day, status, clients(id, name)')
      .eq('kind', 'bookkeeping')
      .in('status', ['active', 'paused', 'payment_failed']),
    todosOsLancamentos(db),
    db.from('documents')
      .select('id, client_id')
      .ilike('category', '%bank%'),
    db.from('plan_alerts')
      .select('id, client_id, type, message, created_at')
      .eq('resolved', false)
      .order('created_at', { ascending: false })
      .limit(20),
  ])
  // Central de bookkeeping com consulta falha mostra cliente a MENOS, e a
  // equipe conclui que nao ha trabalho pendente naquele cliente.
  for (const [oque, err] of [['contratos', errPlans], ['lancamentos', errTxs],
                             ['extratos', errDocs], ['alertas', errAlerts]] as const) {
    if (err) return NextResponse.json({ error: `Nao foi possivel ler ${oque}: ${typeof err === 'string' ? err : err.message}` }, { status: 500 })
  }

  // Clientes relevantes: com contrato OU com transações OU com extratos
  const clientIds = new Set<string>()
  for (const p of plans || []) clientIds.add(p.client_id)
  for (const t of txs || []) clientIds.add(t.client_id)
  for (const s of statements || []) clientIds.add(s.client_id)

  // Escopo por TIPO: quem nao pode ver empresa nao ve nem o nome dela aqui.
  // A central de bookkeeping e, em boa parte, carteira de empresa.
  // A firma tambem sai daqui: o caixa dela tem tela propria (/dashboard/caixa)
  // e nao e carteira de cliente.
  const { ocultos, erro: errEscopo } = await clientesOcultos(auth)
  if (errEscopo) return NextResponse.json({ error: errEscopo }, { status: 500 })
  for (const id of Array.from(clientIds)) if (ocultos.has(id)) clientIds.delete(id)

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
    const doAno = clientTxs.filter(t => t.fiscal_year === year && t.status !== 'excluded')
    const yearCount = doAno.length
    const plan = (plans || []).find(p => p.client_id === id) as any
    // A MESMA conta do quadro do cliente (lib/excedente-transacoes.ts):
    // franquia MENSAL × meses de vigência, contagem recortada pela vigência.
    // Antes: `yearLimit = included_transactions` contra o ano inteiro — 100/mês
    // virava "100/ano" e quase todo cliente aparecia estourado.
    const vig = vigenciaNoAno(plan || {}, year, hoje)
    const naVigencia = vig.desde ? doAno.filter(t => (t.tx_date || '') >= vig.desde!).length : yearCount
    const ap = apurarExcedente(plan || null, naVigencia, vig)
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
      yearCount,
      yearLimit: ap.franquia,
      yearExcess: ap.excedente,
      yearPartial: ap.parcial,
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
