// GET /api/bookkeeping/overage?clientId=...&year=YYYY
//
// CONTADOR, e só. Mostra quantas transações o cliente teve no ano (todas as
// contas e bancos) contra a franquia do contrato. Não cobra nada, não cria
// item de fatura, não chama o Stripe.
//
// Este endpoint TINHA um POST que lançava o excedente na próxima fatura da
// assinatura. Foi removido por decisão do sócio: o excedente é acompanhado
// aqui e, se houver o que cobrar, a cobrança é feita pelo módulo de
// faturamento, onde o valor é conferido e aprovado por quem de direito.
// Não recoloque a cobrança aqui sem essa decisão ser revista.
//
// A franquia é MENSAL e a apuração é ANUAL. O contrato promete N transações por
// mês; a franquia do período é N × meses de vigência no ano, e só o total do ano
// diz se passou — mês de pouco movimento compensa mês de muito. Comparar o número
// mensal contra a contagem do ano inteiro, como se fazia aqui, acusava excedente
// em cliente que estava dentro do contrato.
//
// Contrato que não vigorava naquele ano não gera excedente, ainda que existam
// lançamentos importados do histórico.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { ancoraDeCobranca } from '@/lib/plans'

/**
 * Meses de franquia do contrato DENTRO do ano fiscal, contados da PRIMEIRA
 * COBRANÇA — não da criação do plano. Um contrato criado em 20/08 com débito
 * no dia 5 só começa a cobrar em 05/09: são quatro mensalidades no ano
 * (set, out, nov, dez), não cinco. A data sai de `ancoraDeCobranca`, a mesma
 * regra que o checkout e o aviso de cobrança usam.
 *
 * Devolve também o dia em que a vigência começa, para recortar a contagem.
 */
function vigenciaNoAno(plan: any, year: number): { meses: number; desde: string | null } {
  const criado = plan?.created_at ? new Date(plan.created_at) : null
  if (!criado || Number.isNaN(criado.getTime())) return { meses: 12, desde: null }

  const primeira = ancoraDeCobranca(plan.due_day ?? 5, criado)
  const anoDaPrimeira = primeira.getUTCFullYear()

  if (anoDaPrimeira > year) return { meses: 0, desde: null }   // contrato nem existia
  if (anoDaPrimeira < year) return { meses: 12, desde: null }  // cobriu o ano inteiro

  return {
    meses: 12 - primeira.getUTCMonth(),                        // da 1ª cobrança até dezembro
    desde: primeira.toISOString().slice(0, 10),
  }
}

async function calcOverage(db: any, clientId: string, year: number) {
  // Plano de bookkeeping ativo
  const { data: plan } = await db.from('payment_plans')
    .select('id, included_transactions, overage_rate, stripe_customer_id, stripe_subscription_id, status, created_at, due_day')
    .eq('client_id', clientId).eq('kind', 'bookkeeping')
    .in('status', ['active', 'paused', 'payment_failed'])
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle()

  // Contagem de TODAS as contas (checking, savings, cartões) no ano fiscal.
  // `desde` recorta a contagem pela vigência: se o contrato começou no meio do
  // ano, lançamento anterior a ele não entra na conta — comparar doze meses de
  // movimento contra uma franquia de cinco meses inflaria o excedente.
  const contar = async (desde: string | null) => {
    let q = db.from('bank_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .eq('fiscal_year', year)
      .neq('status', 'excluded')
    if (desde) q = q.gte('tx_date', desde)
    const { count } = await q
    return count ?? 0
  }

  const totalDoAno = await contar(null)

  const vazio = { total: totalDoAno, totalDoAno, included: null, incluidasPorMes: null, meses: 0, desde: null, overage: 0, rate: null, charge: 0 }
  if (!plan) return { ...vazio, plan: null }
  if (!plan.included_transactions) return { ...vazio, plan }

  // `included_transactions` é POR MÊS -- é assim que o formulário pede
  // ("Transações incluídas/mês") e é o que o contrato assinado promete
  // ("até N transações por mês"). A franquia do ano é esse número vezes os
  // meses de vigência: mês de pouco movimento compensa mês de muito, e só o
  // total do ano diz se passou. Comparar o número mensal contra a contagem do
  // ano inteiro -- como se fazia aqui -- acusava excedente em cliente que
  // estava dentro do contrato.
  const incluidasPorMes = plan.included_transactions
  const { meses, desde } = vigenciaNoAno(plan, year)
  const included = incluidasPorMes * meses          // franquia do periodo

  // Contrato que não vigorava no ano não gera excedente nenhum. Os lançamentos
  // de anos anteriores existem (importação do histórico), mas não há acordo que
  // os cubra -- sem esta saída, o ano inteiro viraria "excedente".
  if (meses === 0) {
    return { plan, total: totalDoAno, totalDoAno, included: 0, incluidasPorMes, meses: 0, desde: null,
             semVigencia: true, overage: 0, rate: Number(plan.overage_rate ?? 1.25), charge: 0 }
  }

  // Contrato que começou no meio do ano: conta só da vigência em diante.
  const total = desde ? await contar(desde) : totalDoAno

  const overage = Math.max(0, total - included)
  const rate = Number(plan.overage_rate ?? 1.25)
  const charge = Math.round(overage * rate * 100) / 100

  return { plan, total, totalDoAno, included, incluidasPorMes, meses, desde, overage, rate, charge }
}

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const clientId = req.nextUrl.searchParams.get('clientId')
  const year = parseInt(req.nextUrl.searchParams.get('year') || '')
  if (!clientId || !year) {
    return NextResponse.json({ error: 'clientId e year obrigatórios' }, { status: 400 })
  }
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const result = await calcOverage(serviceDb(), clientId, year)
  if ('error' in result) return NextResponse.json(result, { status: 404 })
  const { plan, ...rest } = result as any
  return NextResponse.json({ ...rest, hasPlan: !!plan, anoFechado: anoFechado(year) })
}

/** O ano fiscal só fecha quando termina: durante o ano corrente o total ainda muda. */
const anoFechado = (year: number) => year < new Date().getFullYear()
