// GET /api/bookkeeping/pnl?clientId=...&year=2020[&month=9]
// Gera o P&L (cash-basis) em HTML pronto para imprimir/salvar PDF.
// Baseado nas transações categorizadas (status auto/reviewed).

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

const FIRM = {
  name: 'Peace on Tax Corp',
  address: '75 Pleasant St Suite 119, Malden, MA 02148',
  phone: '(833) 732-2327', email: 'info@peaceontax.com',
}

// Mapa categoria → grupo, carregado do banco
async function loadKindMap(db: any): Promise<Record<string, string>> {
  const { data } = await db.from('bookkeeping_categories').select('name, kind')
  const map: Record<string, string> = {}
  for (const c of (data || [])) map[c.name] = c.kind
  return map
}

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  const year = parseInt(sp.get('year') || '')
  const month = sp.get('month') ? parseInt(sp.get('month')!) : null
  if (!clientId || !year) return NextResponse.json({ error: 'clientId e year obrigatórios' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const kindMap = await loadKindMap(db)
  const { data: client } = await db.from('clients')
    .select('name, business_name').eq('id', clientId).single()

  let q = db.from('bank_transactions')
    .select('tx_date, category, amount, status')
    .eq('client_id', clientId)
    .eq('fiscal_year', year)
    .in('status', ['approved', 'reviewed'])
    .limit(10000)
  const { data: txs } = await q

  const filtered = (txs || []).filter(t =>
    month ? new Date(t.tx_date + 'T12:00:00Z').getUTCMonth() + 1 === month : true
  )

  // Pendentes (aviso de P&L incompleto)
  let pq = db.from('bank_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId).eq('fiscal_year', year).eq('status', 'pending')
  const { count: pendingCount } = await pq

  // Agrega por categoria
  const byCat: Record<string, number> = {}
  for (const t of filtered) {
    const cat = t.category || 'Other'
    byCat[cat] = (byCat[cat] || 0) + Number(t.amount)
  }

  const group = (kind: string) => Object.entries(byCat)
    .filter(([c]) => (kindMap[c] || 'expense') === kind)
    .map(([c, v]) => ({ cat: c, val: v }))
    .sort((a, b) => Math.abs(b.val) - Math.abs(a.val))

  // Sub-contas ("Pai: Filho"): agrupa sob a mãe, com subtotal
  const withSubs = (items: { cat: string; val: number }[]) => {
    const parents: Record<string, { direct: number; subs: { cat: string; val: number }[] }> = {}
    for (const it of items) {
      const idx = it.cat.indexOf(': ')
      if (idx > 0) {
        const parent = it.cat.slice(0, idx)
        parents[parent] = parents[parent] || { direct: 0, subs: [] }
        parents[parent].subs.push({ cat: it.cat.slice(idx + 2), val: it.val })
      } else {
        parents[it.cat] = parents[it.cat] || { direct: 0, subs: [] }
        parents[it.cat].direct += it.val
      }
    }
    return Object.entries(parents)
      .map(([cat, g]) => ({ cat, direct: g.direct, subs: g.subs, total: g.direct + g.subs.reduce((s2, x) => s2 + x.val, 0) }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
  }

  const renderSection = (items: { cat: string; val: number }[]) =>
    withSubs(items).map(g => {
      if (g.subs.length === 0) return row(g.cat, g.direct, true, g.cat)
      const subRows = g.subs.sort((a, b) => Math.abs(b.val) - Math.abs(a.val))
        .map(sb => `<tr><td style="padding:5px 14px 5px 46px; color:#4a5a70">\u21B3 ${catLink(`${g.cat}: ${sb.cat}`, sb.cat)}</td><td class="r" style="font-weight:500">${money(sb.val)}</td></tr>`).join('')
      const directRow = g.direct !== 0
        ? `<tr><td style="padding:5px 14px 5px 46px; color:#4a5a70">\u21B3 ${catLink(g.cat, '(direct)')}</td><td class="r" style="font-weight:500">${money(g.direct)}</td></tr>` : ''
      return `<tr><td style="padding:6px 14px 2px 30px; font-weight:700">${g.cat}</td><td></td></tr>`
        + subRows + directRow
        + `<tr><td style="padding:2px 14px 8px 30px; color:#6a7a9a; font-size:12px">Total ${g.cat}</td><td class="r" style="border-top:1px solid #e2e8f4">${money(g.total)}</td></tr>`
    }).join('')

  const income   = group('income')
  const cogs     = group('cogs')
  const expenses = group('expense')
  const otherInc = group('other_income')
  const otherExp = group('other_expense')
  const liab     = group('liability')
  const assets   = group('asset')
  const nonPnl   = [...group('non_pnl'), ...liab, ...assets]  // informativos

  const sum = (a: {val:number}[]) => a.reduce((s, i) => s + i.val, 0)
  const totalIncome   = sum(income)
  const totalCogs     = sum(cogs)
  const grossProfit   = totalIncome + totalCogs
  const totalExpense  = sum(expenses)
  const operProfit    = grossProfit + totalExpense
  const totalOtherInc = sum(otherInc)
  const totalOtherExp = sum(otherExp)
  const netProfit     = operProfit + totalOtherInc + totalOtherExp

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const period = month ? `${MONTHS[month-1]} ${year}` : `Year ${year}`
  const displayName = client?.business_name || client?.name || ''
  const money = (n: number) => `${n < 0 ? '(' : ''}$${Math.abs(n).toFixed(2)}${n < 0 ? ')' : ''}`

  const detailUrl = (cat: string) =>
    `/api/bookkeeping/category-detail?clientId=${clientId}&year=${year}${month ? `&month=${month}` : ''}&category=${encodeURIComponent(cat)}`
  const catLink = (cat: string, label?: string) =>
    `<a href="${detailUrl(cat)}" target="_blank" style="color:inherit; text-decoration:none; border-bottom:1px dotted #8a9ab0" title="Abrir os lançamentos desta conta">${label ?? cat}</a>`

  const row = (label: string, val: number, indent = true, linkCat?: string) =>
    `<tr><td style="padding:6px 14px ${indent ? '6px 30px' : ''}">${linkCat ? catLink(linkCat, label) : label}</td><td class="r">${money(val)}</td></tr>`

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>P&L ${period} — ${displayName}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Georgia, serif; color:#1a2a3a; background:#f0f4fa; padding:24px; font-size:15px; }
  .sheet { max-width:760px; margin:0 auto; background:#fff; padding:44px 52px; border-radius:8px; box-shadow:0 2px 24px rgba(45,50,120,0.12); }
  h1 { font-size:22px; color:#2D3278; text-align:center; }
  h2 { font-size:15px; text-align:center; color:#5a6a7a; font-weight:400; margin:4px 0 24px; }
  .firm { text-align:center; font-size:12px; color:#8a9ab0; margin-bottom:8px; }
  table { width:100%; border-collapse:collapse; }
  td.r { text-align:right; padding-right:14px; font-variant-numeric: tabular-nums; }
  tr.section td { background:#2D3278; color:#fff; font-weight:700; padding:8px 14px; font-size:13px; text-transform:uppercase; letter-spacing:0.5px; }
  tr.subtotal td { border-top:1.5px solid #2D3278; font-weight:700; padding:8px 14px; }
  tr.net td { background:${netProfit >= 0 ? '#e8f5ee' : '#fee2e2'}; color:${netProfit >= 0 ? '#1a6b4a' : '#b02020'}; font-weight:800; font-size:17px; padding:12px 14px; }
  tr.nonpnl td { color:#8a9ab0; font-size:13px; }
  .warn { margin-top:18px; background:#fff7e0; border:1px solid #e8c46a; border-radius:8px; padding:10px 14px; font-size:12.5px; color:#7a5a10; }
  .foot { margin-top:26px; text-align:center; font-size:11px; color:#9aaab0; }
  .printbtn { position:fixed; top:18px; right:18px; background:#F47B20; color:#fff; border:none; font-size:15px; font-weight:700; padding:13px 20px; border-radius:10px; cursor:pointer; min-height:48px; }
  @media print { body { background:#fff; padding:0; } .sheet { box-shadow:none; } .printbtn { display:none; } }
</style></head><body>
<button class="printbtn" onclick="window.print()">🖨️ Print / Save PDF</button>
<div class="sheet">
  <div class="firm">${FIRM.name} · ${FIRM.address} · ${FIRM.phone}</div>
  <h1>${displayName}</h1>
  <h2>Profit &amp; Loss (Cash Basis) — ${period}</h2>

  <table>
    <tr class="section"><td colspan="2">Income</td></tr>
    ${renderSection(income) || row('No income recorded', 0)}
    <tr class="subtotal"><td>Total Income</td><td class="r">${money(totalIncome)}</td></tr>

    ${cogs.length ? `
    <tr class="section"><td colspan="2">Cost of Goods Sold</td></tr>
    ${renderSection(cogs)}
    <tr class="subtotal"><td>Gross Profit</td><td class="r">${money(grossProfit)}</td></tr>` : ''}

    <tr class="section"><td colspan="2">Expenses</td></tr>
    ${renderSection(expenses) || row('No expenses recorded', 0)}
    <tr class="subtotal"><td>Total Expenses</td><td class="r">${money(totalExpense)}</td></tr>
    <tr class="subtotal"><td>Operating ${operProfit >= 0 ? 'Profit' : 'Loss'}</td><td class="r">${money(operProfit)}</td></tr>

    ${otherInc.length ? `
    <tr class="section"><td colspan="2">Other Income</td></tr>
    ${otherInc.map(i => row(i.cat, i.val)).join('')}` : ''}
    ${otherExp.length ? `
    <tr class="section"><td colspan="2">Other Expenses</td></tr>
    ${otherExp.map(i => row(i.cat, i.val)).join('')}` : ''}

    <tr class="net"><td>NET ${netProfit >= 0 ? 'PROFIT' : 'LOSS'}</td><td class="r">${money(netProfit)}</td></tr>

    ${nonPnl.length ? `
    <tr class="section"><td colspan="2" style="background:#8a9ab0">Balance Sheet / Non-P&amp;L Items (informational)</td></tr>
    ${nonPnl.map(n => `<tr class="nonpnl">${row(n.cat, n.val).slice(4)}`).join('')}` : ''}
  </table>

  ${(pendingCount ?? 0) > 0 ? `<div class="warn">⚠️ ${pendingCount} transactions are still uncategorized for ${year} — this P&amp;L is preliminary.</div>` : ''}

  <div class="foot">Prepared by ${FIRM.name} · Generated ${new Date().toLocaleDateString('en-US', { timeZone:'America/New_York', month:'long', day:'numeric', year:'numeric' })} · Cash basis — reflects bank activity only</div>
</div>
</body></html>`

  return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}
