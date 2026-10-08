// GET /api/bookkeeping/overage?clientId=...&year=YYYY
//
// CONTADOR, e só. Quantas transações o cliente teve no ano (todas as contas e
// bancos) contra a franquia do contrato de bookkeeping. Não cobra nada, não
// cria item de fatura, não chama o Stripe.
//
// TINHA UM POST que lançava o excedente na próxima fatura da assinatura do
// Stripe, com um botão "Cobrar excedente do ano". Foi removido: a conta que
// ele cobrava estava ERRADA (franquia mensal contra contagem anual — ver
// lib/excedente-transacoes.ts) e, mesmo certa, cobrança é faturamento: passa
// pela alçada de quem emite e de quem dá baixa (princípio 1), e não por um
// botão no bookkeeping que vai direto ao cartão do cliente. Havendo excedente
// a cobrar, emite-se uma fatura. Não recoloque a cobrança aqui sem essa
// decisão ser revista pelo sócio.
//
// A regra da conta mora em lib/excedente-transacoes.ts (com teste), e a
// central de bookkeeping (/api/bookkeeping/overview) usa a MESMA.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { dataDaFirma } from '@/lib/dia-da-firma'
import { vigenciaNoAno, apurarExcedente } from '@/lib/excedente-transacoes'

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const clientId = req.nextUrl.searchParams.get('clientId')
  const year = parseInt(req.nextUrl.searchParams.get('year') || '')
  if (!clientId || !year) {
    return NextResponse.json({ error: 'clientId e year obrigatórios' }, { status: 400 })
  }
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const { data: plano, error: errPlano } = await db.from('payment_plans')
    .select('id, included_transactions, overage_rate, status, created_at, due_day')
    .eq('client_id', clientId).eq('kind', 'bookkeeping')
    .in('status', ['active', 'paused', 'payment_failed'])
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle()
  // Consulta que falha não é "sem contrato": a tela diria "só contagem" e
  // esconderia um excedente que existe.
  if (errPlano) return NextResponse.json({ error: `Não foi possível ler o contrato: ${errPlano.message}` }, { status: 500 })

  const vig = vigenciaNoAno(plano || {}, year, dataDaFirma())

  const contar = async (desde: string | null) => {
    let q = db.from('bank_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .eq('fiscal_year', year)
      .neq('status', 'excluded')
    if (desde) q = q.gte('tx_date', desde)
    const { count, error } = await q
    if (error) throw new Error(error.message)
    return count ?? 0
  }

  try {
    // O total do ano (o que a equipe trabalhou) e o total DENTRO da vigência
    // (o que conta para a franquia) são números diferentes quando o contrato
    // começou no meio do ano — e a tela mostra os dois.
    const totalDoAno = await contar(null)
    const naVigencia = plano && vig.desde ? await contar(vig.desde) : totalDoAno
    const ap = apurarExcedente(plano, naVigencia, vig)
    return NextResponse.json({
      hasPlan: !!plano,
      totalDoAno,
      total: ap.total,
      incluidasPorMes: ap.incluidasPorMes,
      meses: ap.meses,
      desde: vig.desde,
      franquia: ap.franquia,
      excedente: ap.excedente,
      taxa: ap.taxa,
      valor: ap.valor,
      parcial: ap.parcial,
    })
  } catch (e: any) {
    return NextResponse.json({ error: `Não foi possível contar as transações: ${e?.message || e}` }, { status: 500 })
  }
}
