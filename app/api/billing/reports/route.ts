// GET /api/billing/reports?report=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD[&format=json]
//
// Relatórios do faturamento — EXCLUSIVOS DO SÓCIO (verRelatorios em
// lib/billing-perms.ts; gerente e assistente recebem 403). A checagem é
// no servidor: esconder o botão na tela não é controle de acesso.
//
//   faturamento   emitido/recebido/em aberto por mês de emissão
//   recebimentos  pagamentos do período por forma e por cliente
//   aberto        contas a receber hoje, por cliente, com aging
//   recorrente    contratos mensais (MRR) e parcelamentos em andamento
//   servicos      faturamento por item do catálogo
//   estornos      pagamentos estornados e faturas canceladas no período
//
// Devolve HTML impresso (barra Voltar/Imprimir) ou JSON com format=json.
// Orçamentos nunca entram: só doc_type 'invoice', e rascunho/cancelada ficam
// de fora do faturamento.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { permissoesFinanceiro, RECUSA } from '@/lib/billing-perms'
import {
  RELATORIOS, type RelatorioId, agregarFaturamento, agregarRecebimentos, agregarAberto, agregarRecorrente,
  agregarServicos, renderRelatorio, money, fmtUS, rotuloMes, nomeCliente, FAIXAS, FORMA, type Secao,
} from '@/lib/relatorios-financeiro'

export const dynamic = 'force-dynamic'

const html = (s: string, status = 200) => new NextResponse(s, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  if (!perms.verRelatorios) return NextResponse.json({ error: RECUSA.relatorios }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const report = sp.get('report') as RelatorioId
  if (!RELATORIOS.some(r => r.id === report)) return NextResponse.json({ error: 'report inválido' }, { status: 400 })
  const hoje = new Date().toISOString().slice(0, 10)
  const ano = hoje.slice(0, 4)
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.get('from') || '') ? sp.get('from')! : `${ano}-01-01`
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.get('to') || '') ? sp.get('to')! : `${ano}-12-31`
  if (from > to) return NextResponse.json({ error: 'Período inválido' }, { status: 400 })
  const periodo = `${fmtUS(from)} a ${fmtUS(to)}`
  const json = sp.get('format') === 'json'
  const db = serviceDb()
  const meta = RELATORIOS.find(r => r.id === report)!

  try {
    let dados: any
    let secoes: Secao[] = []
    let resumo: { rotulo: string; valor: string }[] = []
    let tituloPeriodo = periodo

    if (report === 'faturamento') {
      const [{ data: faturas }, { data: pagamentos }] = await Promise.all([
        db.from('invoices').select('id, issue_date, total, paid_total, status').eq('doc_type', 'invoice')
          .not('status', 'in', '(draft,void)').gte('issue_date', from).lte('issue_date', to),
        db.from('invoice_payments').select('amount, received_at').gte('received_at', from).lte('received_at', `${to}T23:59:59Z`),
      ])
      dados = agregarFaturamento(faturas || [], pagamentos || [])
      resumo = [
        { rotulo: 'Faturas emitidas', valor: String(dados.total.qtd) },
        { rotulo: 'Emitido no período', valor: money(dados.total.emitido) },
        { rotulo: 'Recebido no período (todas as faturas)', valor: money(dados.total.recebidoNoMes) },
        { rotulo: 'Em aberto das faturas do período', valor: money(dados.total.aberto) },
      ]
      secoes = [{
        colunas: [{ titulo: 'Mês' }, { titulo: 'Faturas', direita: true }, { titulo: 'Emitido', direita: true }, { titulo: 'Recebido (dessas)', direita: true }, { titulo: 'Em aberto', direita: true }, { titulo: 'Entrou no mês', direita: true }],
        linhas: dados.linhas.map((l: any) => [rotuloMes(l.mes), String(l.qtd), l.emitido, l.recebidoDessas, l.aberto, l.recebidoNoMes]),
        total: ['Total', String(dados.total.qtd), dados.total.emitido, dados.total.recebidoDessas, dados.total.aberto, dados.total.recebidoNoMes],
        nota: '"Recebido (dessas)" é o que já entrou das faturas emitidas no mês, em qualquer data. "Entrou no mês" é tudo que foi recebido naquele mês, de qualquer fatura. Rascunhos e faturas canceladas não entram.',
      }]
    }

    if (report === 'recebimentos') {
      const { data: pagamentos } = await db.from('invoice_payments')
        .select('amount, method, financier, received_at, reference, invoices(number), clients(name, business_name)')
        .gte('received_at', from).lte('received_at', `${to}T23:59:59Z`).order('received_at')
      dados = agregarRecebimentos(pagamentos || [])
      resumo = [{ rotulo: 'Pagamentos', valor: String(dados.qtd) }, { rotulo: 'Total recebido', valor: money(dados.total) }]
      secoes = [
        { titulo: 'Por forma de pagamento', colunas: [{ titulo: 'Forma' }, { titulo: 'Qtd', direita: true }, { titulo: 'Total', direita: true }],
          linhas: dados.porForma.map((l: any) => [l.nome, String(l.qtd), l.total]), total: ['Total', String(dados.qtd), dados.total] },
        { titulo: 'Por cliente', colunas: [{ titulo: 'Cliente' }, { titulo: 'Qtd', direita: true }, { titulo: 'Total', direita: true }],
          linhas: dados.porCliente.map((l: any) => [l.nome, String(l.qtd), l.total]), total: ['Total', String(dados.qtd), dados.total] },
        { titulo: 'Lançamentos', colunas: [{ titulo: 'Data' }, { titulo: 'Cliente' }, { titulo: 'Fatura' }, { titulo: 'Forma' }, { titulo: 'Valor', direita: true }],
          linhas: (pagamentos || []).map((p: any) => [fmtUS(p.received_at), nomeCliente(p.clients), p.invoices?.number || '—',
            p.method === 'external' ? `Financiado (${p.financier || 'terceiro'})` : (FORMA[p.method] || p.method), Number(p.amount)]) },
      ]
    }

    if (report === 'aberto') {
      tituloPeriodo = `Posição em ${fmtUS(hoje)}`
      const { data: faturas } = await db.from('invoices')
        .select('id, number, due_date, total, paid_total, status, clients(name, business_name)')
        .eq('doc_type', 'invoice').in('status', ['sent', 'partial', 'overdue'])
      dados = agregarAberto(faturas || [], hoje)
      resumo = [{ rotulo: 'Total a receber', valor: money(dados.total) }, { rotulo: 'Vencido', valor: money(dados.total - dados.totalFaixas[0]) }]
      secoes = [{
        colunas: [{ titulo: 'Cliente' }, { titulo: 'Faturas', direita: true }, ...FAIXAS.map(f => ({ titulo: f, direita: true })), { titulo: 'Total', direita: true }],
        linhas: dados.linhas.map((l: any) => [l.nome, String(l.faturas), ...l.faixas, l.total]),
        total: ['Total', String(dados.linhas.reduce((s: number, l: any) => s + l.faturas, 0)), ...dados.totalFaixas, dados.total],
        nota: 'Atraso contado a partir do vencimento da fatura. Fatura parcelada vence na primeira parcela.',
      }]
    }

    if (report === 'recorrente') {
      tituloPeriodo = `Posição em ${fmtUS(hoje)}`
      const { data: planos } = await db.from('payment_plans')
        .select('id, kind, status, description, monthly_amount, due_day, total, entry_amount, installments, installment_amount, paid_installments, next_charge_date, clients(name, business_name)')
        .in('status', ['active', 'paused', 'payment_failed', 'awaiting_entry', 'awaiting_setup']).order('created_at', { ascending: false })
      dados = agregarRecorrente(planos || [])
      const ST: Record<string, string> = { active: 'Ativo', paused: 'Pausado', payment_failed: 'Débito falhou', awaiting_entry: 'Aguardando entrada', awaiting_setup: 'Aguardando cadastro' }
      resumo = [
        { rotulo: 'Receita recorrente mensal (contratos ativos)', valor: money(dados.mrr) },
        { rotulo: 'Contratos mensais ativos', valor: String(dados.ativosMensais) },
        { rotulo: 'Parcelas a receber', valor: money(dados.aReceber) },
      ]
      secoes = [
        { titulo: 'Contratos mensais', colunas: [{ titulo: 'Cliente' }, { titulo: 'Serviço' }, { titulo: 'Situação' }, { titulo: 'Dia', direita: true }, { titulo: 'Mensal', direita: true }],
          linhas: dados.mensais.map((p: any) => [p.cliente, p.description || (p.kind === 'bookkeeping' ? 'Bookkeeping' : 'Serviço mensal'), ST[p.status] || p.status, String(p.due_day ?? 5), Number(p.monthly_amount || 0)]),
          total: ['Total ativos', '', '', '', dados.mrr] },
        { titulo: 'Parcelamentos', colunas: [{ titulo: 'Cliente' }, { titulo: 'Descrição' }, { titulo: 'Situação' }, { titulo: 'Parcelas', direita: true }, { titulo: 'Próxima', direita: true }, { titulo: 'A receber', direita: true }],
          linhas: dados.parcelados.map((p: any) => [p.cliente, p.description || '—', ST[p.status] || p.status, `${p.paid_installments || 0}/${p.installments}`, fmtUS(p.next_charge_date) || '—', p.restante]),
          total: ['Total', '', '', '', '', dados.aReceber] },
      ]
    }

    if (report === 'servicos') {
      const { data: itens } = await db.from('invoice_items')
        .select('invoice_id, description, qty, amount, pricing_items(label), invoices!inner(issue_date, status, doc_type)')
        .eq('invoices.doc_type', 'invoice').not('invoices.status', 'in', '(draft,void)')
        .gte('invoices.issue_date', from).lte('invoices.issue_date', to)
      dados = agregarServicos(itens || [])
      resumo = [{ rotulo: 'Faturado no período', valor: money(dados.total) }]
      secoes = [{
        colunas: [{ titulo: 'Serviço' }, { titulo: 'Faturas', direita: true }, { titulo: 'Qtd', direita: true }, { titulo: 'Total', direita: true }],
        linhas: dados.linhas.map((l: any) => [l.nome, String(l.faturas), String(l.qtd), l.total]),
        total: ['Total', '', '', dados.total],
        nota: 'Itens do catálogo pelo nome atual; item digitado livremente aparece pela descrição da fatura. Descontos são linhas negativas.',
      }]
    }

    if (report === 'estornos') {
      const [{ data: estornos }, { data: cancel }] = await Promise.all([
        db.from('payment_reversals').select('amount, method, reason, created_at, staff_level, invoices(number, clients(name, business_name))')
          .gte('created_at', from).lte('created_at', `${to}T23:59:59Z`).order('created_at'),
        db.from('invoice_audit').select('created_at, reason, staff_level, invoices(number, total, clients(name, business_name))')
          .eq('action', 'canceled').gte('created_at', from).lte('created_at', `${to}T23:59:59Z`).order('created_at'),
      ])
      const totalEst = (estornos || []).reduce((s: number, e: any) => s + Number(e.amount), 0)
      const totalCan = (cancel || []).reduce((s: number, c: any) => s + Number(c.invoices?.total || 0), 0)
      dados = { estornos: estornos || [], cancelamentos: cancel || [], totalEst, totalCan }
      resumo = [{ rotulo: 'Estornado', valor: money(totalEst) }, { rotulo: 'Cancelado (valor das faturas)', valor: money(totalCan) }]
      secoes = [
        { titulo: 'Pagamentos estornados', colunas: [{ titulo: 'Data' }, { titulo: 'Cliente' }, { titulo: 'Fatura' }, { titulo: 'Forma' }, { titulo: 'Motivo' }, { titulo: 'Valor', direita: true }],
          linhas: (estornos || []).map((e: any) => [fmtUS(e.created_at), nomeCliente(e.invoices?.clients), e.invoices?.number || '—', FORMA[e.method] || e.method, e.reason || '—', Number(e.amount)]),
          total: ['Total', '', '', '', '', totalEst] },
        { titulo: 'Faturas canceladas', colunas: [{ titulo: 'Data' }, { titulo: 'Cliente' }, { titulo: 'Fatura' }, { titulo: 'Motivo' }, { titulo: 'Valor', direita: true }],
          linhas: (cancel || []).map((c: any) => [fmtUS(c.created_at), nomeCliente(c.invoices?.clients), c.invoices?.number || '—', c.reason || '—', Number(c.invoices?.total || 0)]),
          total: ['Total', '', '', '', totalCan] },
      ]
    }

    if (json) return NextResponse.json({ ok: true, report, from, to, resumo, dados })
    return html(renderRelatorio({ titulo: meta.titulo, periodo: tituloPeriodo, resumo, secoes }))
  } catch (e) {
    console.error('billing/reports:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
