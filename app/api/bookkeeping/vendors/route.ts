// GET /api/bookkeeping/vendors?clientId=...&year=2020
// Relatório por fornecedor (payee): total pago, nº de transações, categorias —
// com seção de candidatos a 1099 (Contract Labor / Rent / Legal ≥ $600 no ano).

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

const FIRM = {
  name: 'Peace on Tax Corp',
  address: '75 Pleasant St Suite 119, Malden, MA 02148',
  phone: '(833) 732-2327',
}

// Categorias tipicamente reportáveis em 1099-NEC/MISC (pagamentos ≥ $600/ano)
const CATS_1099 = ['Contract Labor', 'Subcontractors (COGS)', 'Rent', 'Legal & Professional']

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  const year = parseInt(sp.get('year') || '')
  if (!clientId || !year) return NextResponse.json({ error: 'clientId e year obrigatórios' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const { data: client } = await db.from('clients')
    .select('name, business_name').eq('id', clientId).single()

  const { data: txs } = await db.from('bank_transactions')
    .select('payee, category, amount')
    .eq('client_id', clientId)
    .eq('fiscal_year', year)
    .in('status', ['auto', 'reviewed'])
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

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Vendors ${year} — ${displayName}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Georgia, serif; color:#1a2a3a; background:#f0f4fa; padding:24px; font-size:14px; }
  .sheet { max-width:820px; margin:0 auto; background:#fff; padding:44px 52px; border-radius:8px; box-shadow:0 2px 24px rgba(45,50,120,0.12); }
  h1 { font-size:21px; color:#2D3278; text-align:center; }
  h2 { font-size:14px; text-align:center; color:#5a6a7a; font-weight:400; margin:4px 0 24px; }
  h3 { font-size:15px; color:#2D3278; margin:26px 0 10px; }
  .firm { text-align:center; font-size:12px; color:#8a9ab0; margin-bottom:8px; }
  table { width:100%; border-collapse:collapse; }
  th { background:#2D3278; color:#fff; text-align:left; padding:8px 12px; font-size:12px; text-transform:uppercase; }
  td { padding:7px 12px; border-bottom:1px solid #eef2f8; font-size:13px; }
  td.r { text-align:right; font-variant-numeric:tabular-nums; font-weight:700; }
  .badge { display:inline-block; font-size:10.5px; background:#f0f4ff; color:#2D3278; border-radius:12px; padding:1px 8px; margin-right:4px; }
  .k1099 { background:#fff7e0; }
  .warn { margin-top:14px; background:#fff7e0; border:1px solid #e8c46a; border-radius:8px; padding:10px 14px; font-size:12.5px; color:#7a5a10; }
  .foot { margin-top:26px; text-align:center; font-size:11px; color:#9aaab0; }
  .printbtn { position:fixed; top:18px; right:18px; background:#F47B20; color:#fff; border:none; font-size:15px; font-weight:700; padding:13px 20px; border-radius:10px; cursor:pointer; min-height:48px; }
  @media print { body { background:#fff; padding:0; } .sheet { box-shadow:none; } .printbtn { display:none; } }
</style></head><body>
<button class="printbtn" onclick="window.print()">🖨️ Print / Save PDF</button>
<div class="sheet">
  <div class="firm">${FIRM.name} · ${FIRM.address} · ${FIRM.phone}</div>
  <h1>${displayName}</h1>
  <h2>Vendor / Payee Report — ${year} (cash basis, payments only)</h2>

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
  ` : `<h3>1099 Candidates</h3><p style="color:#6a7a9a; font-size:13px;">None found (no payee with ≥ $600 in Contract Labor, Rent or Legal &amp; Professional).</p>`}

  <h3>All Vendors by Total Paid</h3>
  <table>
    <tr><th>Payee</th><th>Categories</th><th style="text-align:right">Total Paid</th><th style="text-align:right">Payments</th></tr>
    ${vendors.map(v => `<tr>
      <td>${v.payee}</td>
      <td>${v.cats.map(c => `<span class="badge">${c}</span>`).join('')}</td>
      <td class="r">${money(v.total)}</td><td class="r" style="font-weight:400">${v.count}</td>
    </tr>`).join('') || '<tr><td colspan="4" style="color:#9aaab0">No categorized payments with payee yet.</td></tr>'}
  </table>

  ${customers.length ? `
  <h3>💰 Customers by Total Received (money in)</h3>
  <table>
    <tr><th>Customer</th><th style="text-align:right">Total Received</th><th style="text-align:right">Payments</th></tr>
    ${customers.map(c => `<tr><td>${c.payee}</td><td class="r">${money(c.total)}</td><td class="r" style="font-weight:400">${c.count}</td></tr>`).join('')}
  </table>` : ''}

  ${noPayeeCount > 0 ? `<div class="warn">📌 ${noPayeeCount} payment(s) totaling ${money(noPayeeTotal)} have no payee identified — run "Categorizar pendentes" to extract payees, or fill manually.</div>` : ''}

  <div class="foot">Prepared by ${FIRM.name} · Generated ${new Date().toLocaleDateString('en-US',{ timeZone:'America/New_York', month:'long', day:'numeric', year:'numeric' })} · Internal working document — verify before filing</div>
</div>
</body></html>`

  return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}
