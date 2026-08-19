// GET /api/bookkeeping/balance-sheet?clientId=...&year=YYYY
// Balance Sheet SIMPLIFICADO (cash basis, a partir dos dados disponíveis):
// - Cash: saldo do último extrato de cada conta (checking/savings)
// - Credit cards: saldo devedor do último extrato
// - Assets/Liabilities do ano: transações aprovadas categorizadas nesses grupos
// Uso interno — não substitui um balanço formal.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { getUser } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await getAuth()

  const clientId = req.nextUrl.searchParams.get('clientId')
  const year = parseInt(req.nextUrl.searchParams.get('year') || '')
  if (!clientId || !year) return NextResponse.json({ error: 'clientId e year obrigatórios' }, { status: 400 })
  // Acesso: equipe (com permissão neste cliente) OU o próprio cliente business, pelo portal
  let isClient = false
  if (auth?.isStaff) {
    if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
  } else {
    const user = await getUser()
    if (!user) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
    const { data: own } = await serviceDb().from('clients').select('id, type').eq('user_id', user.id)
    const mine = (own || []).find(c => c.id === clientId)
    if (!mine || mine.type !== 'business') return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
    isClient = true
  }

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
    body { font-family: Georgia, "Times New Roman", serif; max-width: 700px; margin: 40px auto; color: #000; padding: 0 20px; }
    .timbre { display:flex; align-items:center; gap:13px; border-bottom:2px solid #000;
              padding-bottom:11px; margin-bottom:14px; }
    .timbre img { height:42px; }
    .timbre .marca { font-size:18px; font-weight:700; letter-spacing:0.3px; }
    .timbre .contato { font-size:10px; line-height:1.45; }
    h1 { font-size: 19px; font-weight: 700; margin-bottom: 2px; text-align: center; }
    h2 { font-size: 15px; margin: 2px 0 22px; font-weight: normal; text-align: center; }
    h3 { font-size: 13px; font-weight: 700; border-bottom: 1px solid #000; padding-bottom: 4px; margin-top: 26px; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    td { padding: 5px 8px; }
    .r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .total td { border-top: 1px solid #000; font-weight: 700; }
    .muted { font-size: 11.5px; }
    .net td { border-top: 1px solid #000; border-bottom: 3px double #000; font-weight: 700; }
    .warn { border: 1px solid #000; padding: 9px 12px; font-size: 12px; margin-top: 22px; }
    .footer { margin-top: 32px; font-size: 11px; border-top: 1px solid #000; padding-top: 10px; text-align: center; line-height: 1.6; }
    @media print { body { margin: 16px auto; } }
  </style></head><body>
  <div class="timbre">
    <img src="https://peaceontax-portal.vercel.app/logo.png" alt="Peace on Tax Corp" />
    <div>
      <div class="marca">Peace on Tax Corp</div>
      <div class="contato">75 Pleasant St Suite 119, Malden, MA 02148<br>(833) 732-2327 &middot; info@peaceontax.com &middot; peaceontax.com</div>
    </div>
  </div>

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

  <div class="footer">Peace on Tax Corp · 75 Pleasant St Suite 119, Malden, MA 02148 · (833) 732-2327<br>Prepared by Peace on Tax Corp · Generated ${new Date().toLocaleDateString('en-US')} · Internal working document</div>
  </body></html>`

  const output = isClient
    ? html.replace(/Internal working document[^<]*/g, 'Relatório preliminar — sujeito a revisão da nossa equipe')
    : html
  return new NextResponse(output, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0' } })
}
