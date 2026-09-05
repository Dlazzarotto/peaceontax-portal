// GET /api/bookkeeping/vendors?clientId=...&year=2020
// Relatório por fornecedor (payee): total pago, nº de transações, categorias —
// com seção de candidatos a 1099 (Contract Labor / Rent / Legal ≥ $600 no ano).

import { NextRequest, NextResponse } from 'next/server'
import { barraDoRelatorio } from '@/lib/relatorio-barra'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { getUser } from '@/lib/supabase-server'

const FIRM = {
  name: 'Peace on Tax Corp',
  address: '75 Pleasant St Suite 119, Malden, MA 02148',
  phone: '(833) 732-2327',
}

// Categorias tipicamente reportáveis em 1099-NEC/MISC (pagamentos ≥ $600/ano)
const CATS_1099 = ['Contract Labor', 'Subcontractors (COGS)']

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await getAuth()

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  const year = parseInt(sp.get('year') || '')
  const report = sp.get('report') === '1099' ? '1099' : 'vendors'
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
  const { data: client } = await db.from('clients')
    .select('name, business_name').eq('id', clientId).single()

  const { data: txs } = await db.from('bank_transactions')
    .select('payee, category, amount')
    .eq('client_id', clientId)
    .eq('fiscal_year', year)
    .in('status', ['approved', 'reviewed'])
    .limit(10000)

  // Agrega por payee — saídas (vendors) e entradas (customers) separadas
  const byPayee: Record<string, { total: number; count: number; cats: Set<string> }> = {}
  const byCustomer: Record<string, { total: number; count: number }> = {}
  let noPayeeTotal = 0, noPayeeCount = 0
  for (const t of (txs || [])) {
    const val = Number(t.amount)
    const amt = Math.abs(val)
    if (val > 0) {
      if (t.payee) {
        if (!byCustomer[t.payee]) byCustomer[t.payee] = { total: 0, count: 0 }
        byCustomer[t.payee].total += amt
        byCustomer[t.payee].count++
      }
      continue
    }
    if (!t.payee) { noPayeeTotal += amt; noPayeeCount++; continue }
    if (!byPayee[t.payee]) byPayee[t.payee] = { total: 0, count: 0, cats: new Set() }
    byPayee[t.payee].total += amt
    byPayee[t.payee].count++
    if (t.category) byPayee[t.payee].cats.add(t.category)
  }
  const customers = Object.entries(byCustomer)
    .map(([payee, v]) => ({ payee, total: v.total, count: v.count }))
    .sort((a, b) => b.total - a.total)

  const vendors = Object.entries(byPayee)
    .map(([payee, v]) => ({ payee, total: v.total, count: v.count, cats: Array.from(v.cats) }))
    .sort((a, b) => b.total - a.total)

  const candidates1099 = vendors.filter(v =>
    v.total >= 600 && v.cats.some(c => CATS_1099.includes(c)))

  const displayName = client?.business_name || client?.name || ''
  const money = (n: number) => `$${n.toFixed(2)}`

  const barra = barraDoRelatorio({ voltarPara: '/dashboard/bookkeeping' })
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Vendors ${year} — ${displayName}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Georgia, "Times New Roman", serif; color:#000; background:#fff; padding:24px; font-size:14px; }
    .timbre { display:flex; align-items:center; gap:13px; border-bottom:2px solid #000;
              padding-bottom:11px; margin-bottom:14px; }
    .timbre img { height:42px; }
    .timbre .marca { font-size:18px; font-weight:700; letter-spacing:0.3px; }
    .timbre .contato { font-size:10px; line-height:1.45; }
  .sheet { max-width:820px; margin:0 auto; background:#fff; padding:44px 52px; border-radius:8px;  }
  h1 { font-size:19px; font-weight:700; text-align:center; }
  h2 { font-size:14px; text-align:center; color:#5a6a7a; font-weight:400; margin:4px 0 24px; }
  h3 { font-size:14px; font-weight:700; margin:26px 0 8px; border-bottom:1px solid #000; padding-bottom:4px; }
  .firm { text-align:center; font-size:12px; color:#8a9ab0; margin-bottom:8px; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; padding:7px 12px; font-size:11px; font-weight:700; border-bottom:1px solid #000; }
  td { padding:7px 12px; border-bottom:1px solid #eef2f8; font-size:13px; }
  td.r { text-align:right; font-variant-numeric:tabular-nums; font-weight:700; }
  .badge { display:inline-block; font-size:10.5px; border:1px solid #000; padding:1px 8px; margin-right:4px; }
  .k1099 { background:#fff7e0; }
  .warn { margin-top:14px; background:#fff7e0; border:1px solid #e8c46a; border-radius:8px; padding:10px 14px; font-size:12.5px; color:#7a5a10; }
  .foot { margin-top:32px; padding-top:10px; border-top:1px solid #000; text-align:center; font-size:11px; line-height:1.6; }
  ${barra.css}
  @media print { body { background:#fff; padding:0; } .sheet { box-shadow:none; } }
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
  <h2>${report === '1099' ? '1099 Report' : 'Vendor / Payee Report'} — ${year} (cash basis, payments only)</h2>

  ${report === '1099' ? `
  ${candidates1099.length ? `
  <h3>⚠️ 1099 Candidates (≥ $600 in reportable categories)</h3>
  <table>
    <tr><th>Payee</th><th>Categories</th><th style="text-align:right">Total Paid</th><th style="text-align:right">Payments</th></tr>
    ${candidates1099.map(v => `<tr class="k1099">
      <td><b>${v.payee}</b></td>
      <td>${v.cats.map(c => `<span class="badge">${c}</span>`).join('')}</td>
      <td class="r">${money(v.total)}</td><td class="r" style="font-weight:400">${v.count}</td>
    </tr>`).join('')}
  </table>
  <div class="warn">Collect Form W-9 from these payees and confirm entity type — corporations are generally exempt from 1099-NEC. Verify amounts before filing.</div>
  ` : `<h3>1099 Candidates</h3><p style="color:#6a7a9a; font-size:13px;">None found (no payee with ≥ $600 in Contract Labor or Subcontractors).</p>`}

  ` : ''}

  ${report === 'vendors' ? `<h3>All Vendors by Total Paid</h3>
  <table>
    <tr><th>Payee</th><th>Categories</th><th style="text-align:right">Total Paid</th><th style="text-align:right">Payments</th></tr>
    ${vendors.map(v => `<tr>
      <td>${v.payee}</td>
      <td>${v.cats.map(c => `<span class="badge">${c}</span>`).join('')}</td>
      <td class="r">${money(v.total)}</td><td class="r" style="font-weight:400">${v.count}</td>
    </tr>`).join('') || '<tr><td colspan="4" style="color:#9aaab0">No categorized payments with payee yet.</td></tr>'}
  </table>

  ` : ''}

  ${report === 'vendors' && customers.length ? `
  <h3>💰 Customers by Total Received (money in)</h3>
  <table>
    <tr><th>Customer</th><th style="text-align:right">Total Received</th><th style="text-align:right">Payments</th></tr>
    ${customers.map(c => `<tr><td>${c.payee}</td><td class="r">${money(c.total)}</td><td class="r" style="font-weight:400">${c.count}</td></tr>`).join('')}
  </table>` : ''}

  ${noPayeeCount > 0 ? `<div class="warn">📌 ${noPayeeCount} payment(s) totaling ${money(noPayeeTotal)} have no payee identified — run "Categorizar pendentes" to extract payees, or fill manually.</div>` : ''}

  <div class="foot">${FIRM.name} &middot; ${FIRM.address} &middot; ${FIRM.phone}<br>Prepared · Generated ${new Date().toLocaleDateString('en-US',{ timeZone:'America/New_York', month:'long', day:'numeric', year:'numeric' })} · Internal working document — verify before filing</div>
</div>
</body></html>`

  const output = isClient
    ? html.replace(/Internal working document[^<]*/g, 'Relatório preliminar — sujeito a revisão da nossa equipe')
    : html
  return new NextResponse(output, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0' } })
}
