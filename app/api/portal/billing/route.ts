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
  // Nenhuma destas quatro pode falhar em silêncio. Se a consulta das faturas
  // falha e o erro é descartado, o portal do cliente mostra ZERO -- e zero,
  // na tela, é uma afirmação: "você não tem nada para pagar". O cliente
  // acredita, e a firma não recebe.
  const [
    { data: faturas, error: errFaturas },
    { data: planos, error: errPlanos },
    { data: contratos, error: errContratos },
    { data: pagamentos, error: errPagamentos },
  ] = await Promise.all([
    db.from('invoices')
      .select('id, number, status, issue_date, due_date, total, paid_total, payment_plan, financier')
      .eq('client_id', c.id).eq('doc_type', 'invoice')
      .in('status', ['sent', 'partial', 'overdue', 'paid'])
      .order('issue_date', { ascending: false }).limit(50),
    // Todos os planos que ainda dizem respeito a uma fatura em aberto, não só os
    // que aguardam cadastro: uma fatura parcelada com plano ATIVO não pode
    // oferecer pagamento à vista (a rota recusa), então a tela precisa saber disso.
    db.from('payment_plans')
      .select('id, kind, status, description, total, entry_amount, entry_pct, installments, installment_amount, frequency, monthly_amount, due_day, invoice_id, next_charge_date, paid_installments')
      .eq('client_id', c.id).in('status', ['awaiting_entry', 'awaiting_setup', 'active', 'paused', 'payment_failed'])
      .order('created_at', { ascending: false }),
    db.from('signature_requests')
      .select('id, kind, status, plan_id, signers, created_at')
      .eq('client_id', c.id).eq('kind', 'contract').in('status', ['sent', 'delivered'])
      .order('created_at', { ascending: false }),
    db.from('invoice_payments')
      .select('id, invoice_id, amount, method, financier, received_at')
      .eq('client_id', c.id).order('received_at', { ascending: false }).limit(50),
  ])

  for (const [oque, err] of [['as faturas', errFaturas], ['os planos', errPlanos],
                             ['os contratos', errContratos], ['os pagamentos', errPagamentos]] as const) {
    if (err) {
      console.error('[portal/billing]', oque, err.message)
      return NextResponse.json({
        error: `Não foi possível carregar ${oque} agora. Tente de novo em instantes — ` +
               `se continuar, fale com a nossa equipe.`,
      }, { status: 500 })
    }
  }

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

  // Contrato que o cliente já assinou (a firma assina depois; o envelope ainda
  // não está 'completed') sai da lista de assinatura e libera o plano.
  const { data: assinados } = planIds.length
    ? await db.from('plan_audit').select('plan_id').in('plan_id', planIds).eq('action', 'contract_signed_by_client')
    : { data: [] as any[] }
  const jaAssinou = new Set((assinados || []).map((a: any) => a.plan_id))
  const contratosPendentes = (contratos || []).filter((s: any) => !s.plan_id || !jaAssinou.has(s.plan_id))
  const planosBloqueados = new Set(contratosPendentes.map((s: any) => s.plan_id).filter(Boolean))

  // Situação de cada plano para o cliente, com o MESMO critério da rota que cria
  // a sessão (/api/portal/plan-checkout): aguardando cadastro e contrato assinado.
  // Sem isso a tela oferece um botão que a rota recusa.
  const comSituacao = (planos || []).map((p: any) => ({
    ...p,
    podeCadastrar: ['awaiting_entry', 'awaiting_setup'].includes(p.status) && !planosBloqueados.has(p.id),
    aguardandoContrato: planosBloqueados.has(p.id),
  }))
  // Primeiro assina, depois cadastra o débito: só o que o cliente pode agir agora
  const planosLiberados = comSituacao.filter((p: any) => p.podeCadastrar)

  return NextResponse.json({
    ok: true,
    client: { id: c.id, name: c.name, business_name: c.business_name, language: c.language, balance: c.balance },
    faturas: abertas.map((f: any) => ({
      ...f, saldo: Math.round((Number(f.total) - Number(f.paid_total)) * 100) / 100,
      parcelas: (parcelas || []).filter((p: any) => p.invoice_id === f.id),
      // Fatura parcelada tem plano próprio: pagar à vista é recusado pela rota.
      // Vai o plano em qualquer situação, com podeCadastrar dizendo se há ação.
      plano: comSituacao.find((p: any) => p.invoice_id === f.id) || null,
    })),
    planos: planosLiberados,
    contratos: contratosPendentes.map((s: any) => ({
      id: s.id, status: s.status, plan_id: s.plan_id, created_at: s.created_at,
      plano: planoPorId.get(s.plan_id) || null,
      // Só o contrato enviado para assinatura no portal tem botão; o antigo foi por e-mail do DocuSign
      embedded: !!(Array.isArray(s.signers) && s.signers[0]?.embedded),
    })),
    historico: (pagamentos || []).map((p: any) => ({
      ...p, number: (faturas || []).find((f: any) => f.id === p.invoice_id)?.number || null,
    })),
  })
}
