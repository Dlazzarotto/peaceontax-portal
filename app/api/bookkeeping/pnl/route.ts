// GET /api/bookkeeping/pnl?clientId=...&year=2020[&month=9]
// Gera o P&L (cash-basis) em HTML pronto para imprimir/salvar PDF.
// Cada conta é um link para o detalhe (category-detail), na mesma aba.
// Baseado nas transações categorizadas (status auto/reviewed).

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { getUser } from '@/lib/supabase-server'
import { barraDoRelatorio } from '@/lib/relatorio-barra'

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

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await getAuth()

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  const year = parseInt(sp.get('year') || '')
  const month = sp.get('month') ? parseInt(sp.get('month')!) : null
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
    .sort((a, b) => a.cat.localeCompare(b.cat, undefined, { sensitivity: 'base' }))

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
      .sort((a, b) => a.cat.localeCompare(b.cat, undefined, { sensitivity: 'base' }))
  }

  const renderSection = (items: { cat: string; val: number }[]) =>
    withSubs(items).map(g => {
      if (g.subs.length === 0) return row(g.cat, g.direct, true, g.cat)
      const subRows = g.subs.sort((a, b) => a.cat.localeCompare(b.cat, undefined, { sensitivity: 'base' }))
        .map(sb => `<tr><td style="padding:5px 14px 5px 46px; ">\u21B3 ${catLink(`${g.cat}: ${sb.cat}`, sb.cat)}</td><td class="r" style="font-weight:500">${money(sb.val)}</td></tr>`).join('')
      const directRow = g.direct !== 0
        ? `<tr><td style="padding:5px 14px 5px 46px; ">\u21B3 ${catLink(g.cat, '(direct)')}</td><td class="r" style="font-weight:500">${money(g.direct)}</td></tr>` : ''
      return `<tr><td style="padding:6px 14px 2px 30px; font-weight:700">${g.cat}</td><td></td></tr>`
        + subRows + directRow
        + `<tr><td style="padding:2px 14px 8px 30px; font-size:12.5px; font-style:italic">Total ${g.cat}</td><td class="r" style="border-top:1px solid #e2e8f4">${money(g.total)}</td></tr>`
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
  // Padrão QuickBooks: despesas aparecem como valor positivo na coluna;
  // o sinal de menos fica só para valores realmente negativos (ex.: prejuízo).
  const money = (n: number) => {
    const v = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return `${n < 0 ? '-' : ''}$${v}`
  }

  const detailUrl = (cat: string) =>
    `/api/bookkeeping/category-detail?clientId=${clientId}&year=${year}${month ? `&month=${month}` : ''}&category=${encodeURIComponent(cat)}`
  const catLink = (cat: string, label?: string) =>
    // Mesma aba: o detalhe volta ao P&L pelo botão "Voltar" ou pelo voltar do navegador
    `<a href="${detailUrl(cat)}" style="color:inherit; text-decoration:none; border-bottom:1px dotted #8a9ab0" title="Abrir os lançamentos desta conta">${label ?? cat}</a>`

  const row = (label: string, val: number, indent = true, linkCat?: string) =>
    `<tr><td style="padding:6px 14px ${indent ? '6px 30px' : ''}">${linkCat ? catLink(linkCat, label) : label}</td><td class="r">${money(val)}</td></tr>`

  const barra = barraDoRelatorio({ voltarPara: isClient ? '/portal/reports' : '/dashboard/bookkeeping' })
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>P&L ${period} — ${displayName}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Georgia, "Times New Roman", serif; color:#000; background:#fff; padding:24px; font-size:14px; }
    .timbre { display:flex; align-items:center; gap:13px; border-bottom:2px solid #000;
              padding-bottom:11px; margin-bottom:14px; }
    .timbre img { height:42px; }
    .timbre .marca { font-size:18px; font-weight:700; letter-spacing:0.3px; }
    .timbre .contato { font-size:10px; line-height:1.45; }
  .sheet { max-width:760px; margin:0 auto; background:#fff; padding:40px 48px; }
  h1 { font-size:19px; font-weight:700; text-align:center; }
  h2 { font-size:15px; text-align:center; font-weight:400; margin:2px 0 2px; }
  h3 { font-size:13px; text-align:center; font-weight:400; margin:0 0 22px; }
  table { width:100%; border-collapse:collapse; }
  td { padding:4px 14px; }
  td.r { text-align:right; padding-right:0; font-variant-numeric: tabular-nums; white-space:nowrap; }
  tr.section td { font-weight:700; padding:14px 14px 4px; border-bottom:1px solid #000; }
  tr.subtotal td { border-top:1px solid #000; font-weight:700; padding:5px 14px; }
  tr.net td { border-top:1px solid #000; border-bottom:3px double #000; font-weight:700; padding:8px 14px; font-size:15px; }
  tr.nonpnl td { font-size:13px; }
  .warn { margin-top:18px; border:1px solid #000; padding:9px 12px; font-size:12px; }
  .foot { margin-top:32px; padding-top:10px; border-top:1px solid #000; text-align:center; font-size:11px; line-height:1.6; }
  a { color:#000; }
  ${barra.css}
  @media print { body { padding:0; } .sheet { padding:0; } }
</style></head><body>
  <div class="timbre">
    <img src="https://peaceontax-portal.vercel.app/logo.png" alt="Peace on Tax Corp" />
    <div>
      <div class="marca">Peace on Tax Corp</div>
      <div class="contato">75 Pleasant St Suite 119, Malden, MA 02148<br>(833) 732-2327 &middot; info@peaceontax.com &middot; peaceontax.com</div>
    </div>
  </div>

${barra.html}
<div class="sheet">
  <h1>${displayName}</h1>
  <h2>Profit and Loss</h2>
  <h3>${period} &middot; Cash Basis</h3>

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
    ${otherInc.map(i => row(i.cat, i.val, true, i.cat)).join('')}` : ''}
    ${otherExp.length ? `
    <tr class="section"><td colspan="2">Other Expenses</td></tr>
    ${otherExp.map(i => row(i.cat, i.val, true, i.cat)).join('')}` : ''}

    <tr class="net"><td>NET ${netProfit >= 0 ? 'PROFIT' : 'LOSS'}</td><td class="r">${money(netProfit)}</td></tr>

    ${nonPnl.length ? `
    <tr class="section"><td colspan="2" style="background:#8a9ab0">Balance Sheet / Non-P&amp;L Items (informational)</td></tr>
    ${nonPnl.map(n => `<tr class="nonpnl">${row(n.cat, n.val, true, n.cat).slice(4)}`).join('')}` : ''}
  </table>

  ${(pendingCount ?? 0) > 0 ? `<div class="warn">⚠️ ${pendingCount} transactions are still uncategorized for ${year} — this P&amp;L is preliminary.</div>` : ''}

  <div class="foot">
    ${FIRM.name} &middot; ${FIRM.address} &middot; ${FIRM.phone}<br>
    Prepared ${new Date().toLocaleDateString('en-US', { timeZone:'America/New_York', month:'long', day:'numeric', year:'numeric' })}
    &middot; Cash basis — reflects bank activity only
  </div>
</div>
</body></html>`

  const output = isClient
    ? html.replace(/Internal working document[^<]*/g, 'Relatório preliminar — sujeito a revisão da nossa equipe')
    : html
  return new NextResponse(output, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0' } })
}
