// /api/bookkeeping/reconciliation-report
//
// Relatório das conciliações bancárias já FECHADAS. A aba ✅ Conciliação é a
// tela de trabalho (marcar, fechar); isto aqui é a prova do que foi fechado —
// para consulta e impressão, no mesmo formato dos outros relatórios.
//
//  GET ?clientId=[&accountId=]   → JSON com a lista das conciliações fechadas
//                                  (alimenta o seletor da aba Relatórios)
//  GET ?clientId=&id=<reconcId>  → HTML imprimível de uma conciliação
//
// Só equipe, nunca o cliente: `isStaff` aqui, e a tela que consome isto
// (BookkeepingTab) só existe na área da firma.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { barraDoRelatorio, escaparHtml } from '@/lib/relatorio-barra'
import { fmtUS, money } from '@/lib/format'

export const dynamic = 'force-dynamic'

const round2 = (n: number) => Math.round(n * 100) / 100

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  const accountId = sp.get('accountId')
  const id = sp.get('id')
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()

  // ── Lista das fechadas (JSON, para o seletor) ───────────────────────────
  if (!id) {
    let q = db.from('bank_reconciliations')
      .select('id, account_id, statement_date, beginning_balance, ending_balance, cleared_total, cleared_count, difference, completed_at')
      .eq('client_id', clientId)
      .eq('status', 'completed')
      .order('statement_date', { ascending: false })
      .limit(60)
    if (accountId) q = q.eq('account_id', accountId)

    const { data: fechadas, error } = await q
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const { data: contas } = await db.from('bank_accounts').select('id, name').eq('client_id', clientId)
    const nomeDaConta = new Map((contas || []).map((c: any) => [c.id, c.name]))

    return NextResponse.json({
      ok: true,
      conciliacoes: (fechadas || []).map((r: any) => ({ ...r, account_name: nomeDaConta.get(r.account_id) || '—' })),
    })
  }

  // ── Relatório de uma conciliação (HTML) ─────────────────────────────────
  const { data: rec } = await db.from('bank_reconciliations')
    .select('*').eq('id', id).eq('client_id', clientId).maybeSingle()
  if (!rec) return NextResponse.json({ error: 'Conciliação não encontrada' }, { status: 404 })
  if (rec.status !== 'completed')
    return NextResponse.json({ error: 'Conciliação ainda não foi fechada' }, { status: 409 })

  const [{ data: cliente }, { data: conta }] = await Promise.all([
    db.from('clients').select('name').eq('id', clientId).maybeSingle(),
    db.from('bank_accounts').select('name').eq('id', rec.account_id).maybeSingle(),
  ])

  // Os lançamentos que fecharam esta conciliação
  const { data: conciliados } = await db.from('bank_transactions')
    .select('tx_date, description, payee, category, amount')
    .eq('reconciliation_id', id)
    .order('tx_date', { ascending: true })
    .limit(5000)

  // O que segue sem conciliar até a data do extrato. É a situação de HOJE,
  // não uma foto do dia do fechamento — o relatório diz isso em letras.
  const { data: emAberto } = await db.from('bank_transactions')
    .select('tx_date, description, payee, amount')
    .eq('client_id', clientId).eq('account_id', rec.account_id)
    .in('status', ['approved', 'reviewed'])
    .is('reconciliation_id', null)
    .lte('tx_date', rec.statement_date)
    .order('tx_date', { ascending: true })
    .limit(2000)

  const entradas = (conciliados || []).filter((t: any) => Number(t.amount) > 0)
  const saidas   = (conciliados || []).filter((t: any) => Number(t.amount) < 0)
  const soma = (l: any[]) => round2(l.reduce((s, t) => s + Number(t.amount), 0))

  const barra = barraDoRelatorio({ voltarPara: '/clients', rotuloVoltar: 'Voltar' })

  // Toda string vinda do banco passa por escaparHtml. Nada é interpolado
  // dentro de <script> — o script da barra é fixo.
  const linhas = (l: any[]) => l.map((t: any) => `
    <tr>
      <td class="dt">${escaparHtml(fmtUS(t.tx_date))}</td>
      <td>${escaparHtml(t.payee || t.description || '—')}</td>
      <td class="muted">${escaparHtml(t.category || '')}</td>
      <td class="r">${escaparHtml(money(t.amount))}</td>
    </tr>`).join('')

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Reconciliation — ${escaparHtml(conta?.name || '')} — ${escaparHtml(fmtUS(rec.statement_date))}</title>
<style>
  body { font-family: Georgia, serif; color:#1a2a3a; margin:34px; font-size:13.5px; }
  .timbre { display:flex; align-items:center; gap:14px; border-bottom:2px solid #2D3278; padding-bottom:12px; margin-bottom:18px; }
  .timbre img { height:46px; }
  .marca { font-size:17px; font-weight:700; color:#2D3278; }
  .contato { font-size:11px; color:#6a7a9a; line-height:1.5; }
  h1 { font-size:19px; margin:0 0 3px; color:#0f2340; }
  h2 { font-size:14px; margin:0 0 18px; color:#6a7a9a; font-weight:400; }
  h3 { font-size:14px; margin:20px 0 7px; color:#2D3278; }
  table { width:100%; border-collapse:collapse; margin-bottom:8px; }
  td, th { padding:5px 7px; border-bottom:1px solid #eef2f8; text-align:left; vertical-align:top; }
  th { font-size:11px; text-transform:uppercase; color:#6a7a9a; letter-spacing:.4px; }
  .r { text-align:right; white-space:nowrap; }
  .dt { white-space:nowrap; color:#6a7a9a; }
  .muted { color:#8a9ab0; font-size:12px; }
  .total td { font-weight:700; border-top:1.5px solid #2D3278; border-bottom:none; }
  .resumo td:first-child { color:#4a5a70; }
  .ok { color:#1a6b4a; font-weight:700; }
  .off { color:#b02020; font-weight:700; }
  .warn { background:#fff8e8; border-left:4px solid #F47B20; padding:10px 14px; font-size:12px; color:#5a4a1a; margin-top:16px; line-height:1.6; }
  .footer { margin-top:22px; padding-top:10px; border-top:1px solid #e2e8f4; font-size:10.5px; color:#9aaab0; line-height:1.6; }
  ${barra.css}
</style></head><body>
${barra.html}
<div class="timbre">
  <img src="https://peaceontax-portal.vercel.app/logo.png" alt="Peace on Tax Corp" />
  <div>
    <div class="marca">Peace on Tax Corp</div>
    <div class="contato">75 Pleasant St Suite 119, Malden, MA 02148<br>(833) 732-2327 &middot; info@peaceontax.com &middot; peaceontax.com</div>
  </div>
</div>

<h1>${escaparHtml(cliente?.name || '')}</h1>
<h2>Bank Reconciliation — ${escaparHtml(conta?.name || '—')} — statement of ${escaparHtml(fmtUS(rec.statement_date))}</h2>

<h3>Summary</h3>
<table class="resumo">
  <tr><td>Beginning balance (statement)</td><td class="r">${escaparHtml(money(rec.beginning_balance))}</td></tr>
  <tr><td>Deposits and credits cleared (${entradas.length})</td><td class="r">${escaparHtml(money(soma(entradas)))}</td></tr>
  <tr><td>Payments and debits cleared (${saidas.length})</td><td class="r">${escaparHtml(money(soma(saidas)))}</td></tr>
  <tr><td>Cleared balance</td><td class="r">${escaparHtml(money(rec.cleared_total))}</td></tr>
  <tr><td>Ending balance (statement)</td><td class="r">${escaparHtml(money(rec.ending_balance))}</td></tr>
  <tr class="total"><td>Difference</td><td class="r ${Number(rec.difference) === 0 ? 'ok' : 'off'}">${escaparHtml(money(rec.difference))}</td></tr>
</table>
<div class="muted">Closed on ${escaparHtml(rec.completed_at ? fmtUS(String(rec.completed_at).slice(0, 10)) : '—')} · ${rec.cleared_count} transactions cleared</div>

<h3>Cleared deposits and credits (${entradas.length})</h3>
<table>
  <tr><th>Date</th><th>Payee / description</th><th>Category</th><th class="r">Amount</th></tr>
  ${entradas.length ? linhas(entradas) : '<tr><td colspan="4" class="muted">None</td></tr>'}
  ${entradas.length ? `<tr class="total"><td colspan="3">Total</td><td class="r">${escaparHtml(money(soma(entradas)))}</td></tr>` : ''}
</table>

<h3>Cleared payments and debits (${saidas.length})</h3>
<table>
  <tr><th>Date</th><th>Payee / description</th><th>Category</th><th class="r">Amount</th></tr>
  ${saidas.length ? linhas(saidas) : '<tr><td colspan="4" class="muted">None</td></tr>'}
  ${saidas.length ? `<tr class="total"><td colspan="3">Total</td><td class="r">${escaparHtml(money(soma(saidas)))}</td></tr>` : ''}
</table>

<h3>Still uncleared as of ${escaparHtml(fmtUS(rec.statement_date))} (${(emAberto || []).length})</h3>
<table>
  <tr><th>Date</th><th>Payee / description</th><th></th><th class="r">Amount</th></tr>
  ${(emAberto || []).length ? linhas(emAberto || []) : '<tr><td colspan="4" class="muted">None</td></tr>'}
  ${(emAberto || []).length ? `<tr class="total"><td colspan="3">Total</td><td class="r">${escaparHtml(money(soma(emAberto || [])))}</td></tr>` : ''}
</table>
<div class="muted">This uncleared list reflects the register as it stands today, not a snapshot taken on the closing date.</div>

<div class="warn">⚠️ Reconciles the book against the bank statement. Only transactions already in the register (approved or reviewed) are considered — items still in the classification queue are not. For internal review — not a formal financial statement.</div>

<div class="footer">Peace on Tax Corp · 75 Pleasant St Suite 119, Malden, MA 02148 · (833) 732-2327<br>Prepared by Peace on Tax Corp · Generated ${escaparHtml(new Date().toLocaleDateString('en-US'))} · Internal working document</div>
</body></html>`

  return new NextResponse(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0' },
  })
}
