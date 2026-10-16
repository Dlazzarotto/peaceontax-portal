// GET /api/bookkeeping/vendors?clientId=...&from=YYYY-MM-DD&to=YYYY-MM-DD[&report=vendors|1099]
//   (ou year=YYYY, como sempre aceitou — lib/periodo-relatorio.ts converte)
// Relatório por fornecedor (payee): total pago, nº de transações, categorias.
// Com report=1099, a lista do 1099: TODA despesa paga nas contas que o sócio
// marcou no plano de contas (botão do 1099, `bookkeeping_categories.form_1099`),
// por prestador e por formulário, contra o limite DO ANO. Quem decide é
// lib/relatorio-1099.ts: limite 600 até 2025 e 2000 a partir de 2026, cartão
// de crédito e PayPal/Venmo/Cash App fora (vão no 1099-K), grafias do mesmo
// prestador somadas juntas. A lista fixa no código saiu.
// O 1099 é por ANO-CALENDÁRIO: período livre vira o ano do fim dele, e o
// relatório diz qual.
//
// Todo texto que vem do banco sai escapado: o payee nasce da descrição do
// extrato e o nome do cliente é digitado por ele no aceite do convite.

import { NextRequest, NextResponse } from 'next/server'
import { barraDoRelatorio, escaparHtml, META_RELATORIO } from '@/lib/relatorio-barra'
import { apurar1099, ehContaDeDespesa, formularioDoPedido, FORMULARIOS_1099,
         type Formulario1099, type Linha1099 } from '@/lib/relatorio-1099'
import { colunaAusente } from '@/lib/caixa-firma'
import { periodoDosParametros, periodoDeAno, anoDe, rotuloDoPeriodo } from '@/lib/periodo-relatorio'
import { todasAsLinhas } from '@/lib/paginar'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { getUser } from '@/lib/supabase-server'

const FIRM = {
  name: 'Peace on Tax Corp',
  address: '75 Pleasant St Suite 119, Malden, MA 02148',
  phone: '(833) 732-2327',
}

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await getAuth()

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  const report = sp.get('report') === '1099' ? '1099' : 'vendors'
  const pedido = periodoDosParametros(k => sp.get(k))
  if (!clientId || !pedido) return NextResponse.json({ error: 'clientId e período (from/to ou year) obrigatórios' }, { status: 400 })
  // 1099 é por ano-calendário (lei): o período livre vira o ano do FIM dele
  const { de, ate } = report === '1099' ? periodoDeAno(anoDe(pedido.ate)) : pedido
  const rotulo = rotuloDoPeriodo(de, ate)
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

  // Por DATA (fiscal_year nasce dela) e em páginas de 1000: `.limit(10000)`
  // parava em mil sem avisar — e o 1099 saía com fornecedor FALTANDO.
  const { data: txs, error: errTxs } = await todasAsLinhas<any>(() =>
    db.from('bank_transactions')
      .select('payee, category, amount, account_id, description')
      .eq('client_id', clientId)
      .gte('tx_date', de).lte('tx_date', ate)
      .in('status', ['approved', 'reviewed']))
  // Consulta que falha não vira "No categorized payments" — isso é uma afirmação.
  if (errTxs) return NextResponse.json({ error: `Relatório não gerado — falhou ao ler os lançamentos: ${errTxs.message}` }, { status: 500 })

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

  // ── 1099: as contas marcadas no plano e quais contas do cliente são cartão
  let apuracao: ReturnType<typeof apurar1099> | null = null
  const contas1099: { name: string; form: Formulario1099 }[] = []
  if (report === '1099') {
    const [{ data: cats, error: errCats }, { data: contasBanco, error: errContas }] = await Promise.all([
      db.from('bookkeeping_categories').select('name, kind, form_1099').not('form_1099', 'is', null),
      db.from('bank_accounts').select('id, type').eq('client_id', clientId),
    ])
    if (errCats) {
      return colunaAusente(errCats)
        ? NextResponse.json({ error: 'O 1099 por conta precisa da migração sql/plano-de-contas-1099-v1.sql. Rode no SQL Editor e abra o relatório de novo.' }, { status: 409 })
        : NextResponse.json({ error: `Relatório não gerado — falhou ao ler o plano de contas: ${errCats.message}` }, { status: 500 })
    }
    // Sem as contas do cliente não dá para separar o cartão: o 1099 sairia
    // com pagamento que não vai nele. Falhar é melhor que errar.
    if (errContas) return NextResponse.json({ error: `Relatório não gerado — falhou ao ler as contas do cliente: ${errContas.message}` }, { status: 500 })
    const formularioDaConta: Record<string, Formulario1099> = {}
    for (const c of (cats || []) as any[]) {
      const f = formularioDoPedido(c.form_1099)
      if (f && ehContaDeDespesa(c.kind)) { formularioDaConta[c.name] = f; contas1099.push({ name: c.name, form: f }) }
    }
    contas1099.sort((a, b) => a.form.localeCompare(b.form) || a.name.localeCompare(b.name))
    apuracao = apurar1099({
      lancamentos: txs || [], formularioDaConta, ano: anoDe(ate),
      contasDeCartao: ((contasBanco || []) as any[]).filter(a => a.type === 'credit_card').map(a => a.id),
    })
  }

  const displayName = client?.business_name || client?.name || ''
  const money = (n: number) => `$${n.toFixed(2)}`
  const dinheiroInteiro = (n: number) => `$${n.toLocaleString('en-US')}`
  const esc = escaparHtml
  const linhas1099 = (lista: Linha1099[], destaque: boolean) => lista.map(l => `<tr${destaque ? ' class="k1099"' : ''}>
      <td><b>${esc(l.prestador)}</b></td>
      <td>${l.contas.map(c => `<span class="badge">${esc(c)}</span>`).join('')}</td>
      <td class="r" style="font-weight:400">${money(l.pago)}</td>
      <td class="r" style="font-weight:400">${l.devolvido ? `-${money(l.devolvido)}` : '—'}</td>
      <td class="r">${money(l.total)}</td>
      <td class="r" style="font-weight:400">${l.pagamentos}</td>
    </tr>`).join('')
  const cabecalho1099 = '<tr><th>Payee</th><th>1099 accounts</th><th style="text-align:right">Paid</th><th style="text-align:right">Refunds</th><th style="text-align:right">Total</th><th style="text-align:right">Payments</th></tr>'
  const secao1099 = !apuracao ? '' : `
  <h3>1099 — calendar year ${apuracao.ano} · threshold ${dinheiroInteiro(apuracao.limite)} per payee and form</h3>
  <p style="font-size:12.5px; margin:0 0 6px">Accounts marked for 1099 in the chart of accounts: ${contas1099.length
    ? contas1099.map(c => `<span class="badge">${esc(c.name)} · ${c.form}</span>`).join('')
    : '<b>none</b>. Mark the expense accounts in Chart of accounts (Plano de contas) and open this report again.'}</p>
  ${FORMULARIOS_1099.map(f => {
    const lista = apuracao!.candidatos.filter(l => l.formulario === f)
    return lista.length ? `
  <h3>⚠️ Form 1099-${f} candidates</h3>
  <table>${cabecalho1099}${linhas1099(lista, true)}</table>` : ''
  }).join('')}
  ${apuracao.candidatos.length ? '' : `<p style="color:#6a7a9a; font-size:13px; margin-top:10px">No payee reached ${dinheiroInteiro(apuracao.limite)} in the accounts marked for 1099.</p>`}
  ${apuracao.abaixoDoLimite.length ? `
  <h3>Below the threshold (no 1099 required)</h3>
  <table>${cabecalho1099}${linhas1099(apuracao.abaixoDoLimite.map(l => ({ ...l, prestador: `${l.prestador} · ${l.formulario}` })), false)}</table>` : ''}
  ${apuracao.foraDoFormulario.cartao > 0 ? `<div class="warn">💳 ${money(apuracao.foraDoFormulario.cartao)} was paid by credit card in the 1099 accounts. Card payments are not reported on 1099-NEC/MISC: the card processor reports them on Form 1099-K.</div>` : ''}
  ${apuracao.foraDoFormulario.plataforma > 0 ? `<div class="warn">📱 ${money(apuracao.foraDoFormulario.plataforma)} was paid through PayPal, Venmo or Cash App in the 1099 accounts. Third-party network payments are reported on Form 1099-K, not on 1099-NEC/MISC. Confirm each one before filing.</div>` : ''}
  ${apuracao.semPrestador.lancamentos > 0 ? `<div class="warn">📌 ${apuracao.semPrestador.lancamentos} payment(s) totaling ${money(apuracao.semPrestador.total)} in the 1099 accounts have no payee identified. Identify the payee, or a 1099 may be missed.</div>` : ''}
  ${apuracao.candidatos.length ? '<div class="warn">Collect Form W-9 from these payees and confirm the entity type. Corporations are generally exempt, except for attorney fees and medical payments. Verify amounts before filing.</div>' : ''}`

  const barra = barraDoRelatorio({
    voltarPara: isClient ? '/portal/reports' : '/dashboard/bookkeeping',
    painelPara: isClient ? '/portal' : '/dashboard',
  })
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">${META_RELATORIO}
<title>${report === '1099' ? '1099' : 'Vendors'} ${rotulo} — ${esc(displayName)}</title>
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
  <h1>${esc(displayName)}</h1>
  <h2>${report === '1099' ? '1099 Report' : 'Vendor / Payee Report'} — ${rotulo} (cash basis, payments only)</h2>

  ${secao1099}

  ${report === 'vendors' ? `<h3>All Vendors by Total Paid</h3>
  <table>
    <tr><th>Payee</th><th>Categories</th><th style="text-align:right">Total Paid</th><th style="text-align:right">Payments</th></tr>
    ${vendors.map(v => `<tr>
      <td>${esc(v.payee)}</td>
      <td>${v.cats.map(c => `<span class="badge">${esc(c)}</span>`).join('')}</td>
      <td class="r">${money(v.total)}</td><td class="r" style="font-weight:400">${v.count}</td>
    </tr>`).join('') || '<tr><td colspan="4" style="color:#9aaab0">No categorized payments with payee yet.</td></tr>'}
  </table>

  ` : ''}

  ${report === 'vendors' && customers.length ? `
  <h3>💰 Customers by Total Received (money in)</h3>
  <table>
    <tr><th>Customer</th><th style="text-align:right">Total Received</th><th style="text-align:right">Payments</th></tr>
    ${customers.map(c => `<tr><td>${esc(c.payee)}</td><td class="r">${money(c.total)}</td><td class="r" style="font-weight:400">${c.count}</td></tr>`).join('')}
  </table>` : ''}

  ${report === 'vendors' && noPayeeCount > 0 ? `<div class="warn">📌 ${noPayeeCount} payment(s) totaling ${money(noPayeeTotal)} have no payee identified — run "Categorizar pendentes" to extract payees, or fill manually.</div>` : ''}

  <div class="foot">${FIRM.name} &middot; ${FIRM.address} &middot; ${FIRM.phone}<br>Prepared · Generated ${new Date().toLocaleDateString('en-US',{ timeZone:'America/New_York', month:'long', day:'numeric', year:'numeric' })} · Internal working document — verify before filing</div>
</div>
</body></html>`

  const output = isClient
    ? html.replace(/Internal working document[^<]*/g, 'Relatório preliminar — sujeito a revisão da nossa equipe')
    : html
  return new NextResponse(output, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0' } })
}
