// GET /api/bookkeeping/balance-sheet?clientId=...&year=YYYY
// Balance Sheet SIMPLIFICADO (cash basis, a partir dos dados disponíveis):
// - Cash: saldo do último extrato de cada conta (checking/savings)
// - Credit cards: saldo devedor do último extrato
// - Assets/Liabilities do ano: transações aprovadas categorizadas nesses grupos
// Uso interno — não substitui um balanço formal.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const clientId = req.nextUrl.searchParams.get('clientId')
  const year = parseInt(req.nextUrl.searchParams.get('year') || '')
  if (!clientId || !year) return NextResponse.json({ error: 'clientId e year obrigatórios' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const [{ data: client }, { data: accounts }, { data: txs }, { data: cats }] = await Promise.all([
    db.from('clients').select('name, business_name').eq('id', clientId).single(),
    db.from('bank_accounts').select('id, name, type').eq('client_id', clientId).eq('active', true),
    db.from('bank_transactions')
      .select('account_id, tx_date, balance, amount, category, status, fiscal_year')
      .eq('client_id', clientId).limit(20000),
    db.from('bookkeeping_categories').select('name, kind').eq('active', true),
  ])

  const kindOf: Record<string, string> = {}
  for (const c of cats || []) kindOf[c.name] = c.kind

  // Saldo mais recente por conta (até 31/12 do ano do relatório)
  const cutoff = `${year}-12-31`
  const balances = (accounts || []).map(a => {
    const list = (txs || [])
      .filter(t => t.account_id === a.id && t.balance != null && t.tx_date <= cutoff)
      .sort((x, y) => (y.tx_date as string).localeCompare(x.tx_date as string))
    return { name: a.name, type: a.type, balance: list[0]?.balance != null ? Number(list[0].balance) : null, asOf: list[0]?.tx_date ?? null }
  })

  const cashAccounts = balances.filter(b => b.type !== 'credit_card' && b.balance != null)
  const cardAccounts = balances.filter(b => b.type === 'credit_card' && b.balance != null)
  const totalCash = cashAccounts.reduce((s, b) => s + (b.balance || 0), 0)
  const totalCards = cardAccounts.reduce((s, b) => s + (b.balance || 0), 0)

  // Movimentos do ano categorizados como asset/liability (aprovados)
  const registered = (txs || []).filter(t =>
    t.fiscal_year === year && ['approved', 'reviewed'].includes(t.status) && t.category)
  const assetMoves: Record<string, number> = {}
  const liabilityMoves: Record<string, number> = {}
  for (const t of registered) {
    const kind = kindOf[t.category!] || ''
    if (kind === 'asset') assetMoves[t.category!] = (assetMoves[t.category!] || 0) + Math.abs(Number(t.amount))
    if (kind === 'liability') liabilityMoves[t.category!] = (liabilityMoves[t.category!] || 0) + Math.abs(Number(t.amount))
  }

  const money = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const name = client?.business_name || client?.name || 'Client'
  const totalAssets = totalCash + Object.values(assetMoves).reduce((s, v) => s + v, 0)
  const totalLiab = totalCards
  const net = totalAssets - totalLiab

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Balance Sheet ${year} — ${name}</title>
  <style>
    body { font-family: Georgia, serif; max-width: 700px; margin: 40px auto; color: #1a2a3a; padding: 0 20px; }
    h1 { font-size: 19px; color: #2D3278; margin-bottom: 2px; }
    h2 { font-size: 15px; color: #0f2340; margin: 4px 0 20px; font-weight: normal; }
    h3 { font-size: 13px; color: #2D3278; text-transform: uppercase; letter-spacing: 1px; border-bottom: 2px solid #2D3278; padding-bottom: 4px; margin-top: 26px; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    td { padding: 6px 8px; border-bottom: 1px solid #eef1f6; }
    .r { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
    .total td { border-top: 2px solid #2D3278; font-weight: 800; font-size: 14px; }
    .muted { color: #8a9ab0; font-size: 11.5px; }
    .net { background: #f0f4ff; }
    .warn { background: #fff7e0; border: 1px solid #e0c060; border-radius: 8px; padding: 10px 14px; font-size: 12px; margin-top: 22px; color: #6a5a10; }
    .footer { margin-top: 30px; font-size: 11px; color: #9aaab0; border-top: 1px solid #e2e8f4; padding-top: 10px; }
    @media print { body { margin: 16px auto; } }
  </style></head><body>
  <div class="muted">Peace on Tax Corp · 75 Pleasant St Suite 119, Malden, MA 02148 · (833) 732-2327</div>
  <h1>${name}</h1>
  <h2>Balance Sheet (simplified) — as of December 31, ${year}</h2>

  <h3>Assets</h3>
  <table>
    ${cashAccounts.map(b => `<tr><td>🏦 ${b.name} <span class="muted">(as of ${b.asOf})</span></td><td class="r">${money(b.balance!)}</td></tr>`).join('')}
    ${cashAccounts.length === 0 ? '<tr><td class="muted">No bank balances available</td><td></td></tr>' : ''}
    ${Object.entries(assetMoves).map(([c, v]) => `<tr><td>${c} <span class="muted">(purchases in ${year})</span></td><td class="r">${money(v)}</td></tr>`).join('')}
    <tr class="total"><td>Total Assets</td><td class="r">${money(totalAssets)}</td></tr>
  </table>

  <h3>Liabilities</h3>
  <table>
    ${cardAccounts.map(b => `<tr><td>💳 ${b.name} <span class="muted">(balance as of ${b.asOf})</span></td><td class="r">${money(b.balance!)}</td></tr>`).join('')}
    ${cardAccounts.length === 0 ? '<tr><td class="muted">No credit card balances available</td><td></td></tr>' : ''}
    ${Object.entries(liabilityMoves).map(([c, v]) => `<tr><td class="muted">${c} — payments made in ${year} (informational)</td><td class="r muted">${money(v)}</td></tr>`).join('')}
    <tr class="total"><td>Total Liabilities</td><td class="r">${money(totalLiab)}</td></tr>
  </table>

  <h3>Net Position</h3>
  <table>
    <tr class="total net"><td>Assets − Liabilities</td><td class="r">${money(net)}</td></tr>
  </table>

  <div class="warn">⚠️ Simplified statement compiled from bank statement balances and categorized transactions available in the portal.
  It may not include all assets/liabilities (loans, receivables, payables, equipment basis, depreciation). For internal review — not a formal financial statement.</div>

  <div class="footer">Prepared by Peace on Tax Corp · Generated ${new Date().toLocaleDateString('en-US')} · Internal working document</div>
  </body></html>`

  return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}
