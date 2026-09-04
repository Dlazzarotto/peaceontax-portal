// GET /api/bookkeeping/category-detail?clientId=...&year=YYYY&month=MM?&category=...
// Drill-down do P&L: todos os lançamentos DO REGISTRO daquela categoria,
// para conferência. Abre na mesma aba a partir da linha do P&L; a barra
// fixa tem "Voltar ao P&L" e "Print / Save PDF" (some na impressão).

import { NextRequest, NextResponse } from 'next/server'
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
  const year = parseInt(sp.get('year') || '')
  const month = sp.get('month')
  const category = sp.get('category')
  if (!clientId || !year || !category) {
    return NextResponse.json({ error: 'clientId, year e category obrigatórios' }, { status: 400 })
  }
  // Acesso: equipe (com permissão neste cliente) OU o próprio cliente business, pelo portal
  let isClient = false
  if (auth?.isStaff) {
    if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
  } else {
    const user = await getUser()
    if (!user) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
    const { data: own } = await serviceDb().from('clients').select('id, type').eq('user_id', user.id)
    const mine = (own || []).find((c: any) => c.id === clientId)
    if (!mine || mine.type !== 'business') return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
    isClient = true
  }

  const db = serviceDb()
  const { data: client } = await db.from('clients')
    .select('name, business_name').eq('id', clientId).single()

  let q = db.from('bank_transactions')
    .select('tx_date, description, payee, amount, status, account_id')
    .eq('client_id', clientId)
    .eq('fiscal_year', year)
    .eq('category', category)
    .in('status', ['approved', 'reviewed'])
    .order('tx_date', { ascending: true })
    .limit(5000)
  const { data: txs, error: qErr } = await q
  if (qErr) {
    return new NextResponse(
      `<html><body style="font-family:Georgia,serif;max-width:700px;margin:40px auto;padding:0 20px">
        <h2 style="color:#b02020">Erro ao carregar o detalhe da conta</h2>
        <p style="font-size:14px;color:#4a5a70">${qErr.message}</p>
        <p style="font-size:12px;color:#9aaab0">Conta: ${category} · Ano: ${year}</p>
      </body></html>`,
      { status: 500, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
  }

  // Nomes das contas buscados à parte (join embutido pode falhar em silêncio)
  const { data: contas } = await db.from('bank_accounts')
    .select('id, name').eq('client_id', clientId)
  const nomeConta = new Map((contas || []).map((a: any) => [a.id, a.name]))

  let list = txs || []
  if (month && /^\d{1,2}$/.test(month)) {
    const mm = month.padStart(2, '0')
    list = list.filter((t: any) => String(t.tx_date).slice(5, 7) === mm)
  }

  // Vazio? Descobre ONDE estão os lançamentos desta conta (ano e status)
  let diagnostico = ''
  if (list.length === 0) {
    const { data: todos } = await db
      .from('bank_transactions')
      .select('fiscal_year, status, amount')
      .eq('client_id', clientId)
      .eq('category', category)
      .limit(5000)

    if (!todos || todos.length === 0) {
      diagnostico = `Nenhum lançamento com a conta "${category}" foi encontrado para este cliente em nenhum ano.`
    } else {
      const porAno: Record<string, Record<string, number>> = {}
      for (const t of todos as any[]) {
        const y = String(t.fiscal_year ?? 'sem ano')
        porAno[y] = porAno[y] || {}
        porAno[y][t.status] = (porAno[y][t.status] || 0) + 1
      }
      const partes = Object.entries(porAno)
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([y, st]) => `${y}: ` + Object.entries(st)
          .map(([k, v]) => `${v} ${k === 'approved' ? 'aprovados' : k === 'reviewed' ? 'revisados' : k === 'auto' ? 'reconhecidos (aguardando aprovação)' : k === 'pending' ? 'em aberto' : k}`)
          .join(', '))
      diagnostico = `Esta conta tem lançamentos, mas fora deste período/registro — ${partes.join(' · ')}.`
    }
  }

  // Datas no padrão dos EUA (MM/DD/YYYY)
  const fmtDate = (d: string) => {
    const [y, m, day] = String(d).slice(0, 10).split('-')
    return (y && m && day) ? `${m}/${day}/${y}` : String(d)
  }

  const money = (v: number) => {
    const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return v < 0 ? `-$${abs}` : `$${abs}`
  }
  const total = list.reduce((acc: number, t: any) => acc + Number(t.amount), 0)
  const positives = list.filter((t: any) => Number(t.amount) > 0).length
  const negatives = list.filter((t: any) => Number(t.amount) < 0).length
  const displayName = client?.business_name || client?.name || 'Client'
  const period = month ? `${month.padStart(2, '0')}/${year}` : String(year)

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${category} — ${period}</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; max-width: 860px; margin: 34px auto; color: #000; padding: 0 20px; }
    .timbre { display:flex; align-items:center; gap:13px; border-bottom:2px solid #000;
              padding-bottom:11px; margin-bottom:14px; }
    .timbre img { height:42px; }
    .timbre .marca { font-size:18px; font-weight:700; letter-spacing:0.3px; }
    .timbre .contato { font-size:10px; line-height:1.45; }
    h1 { font-size: 18px; font-weight: 700; margin-bottom: 2px; text-align: center; }
    h2 { font-size: 14px; margin: 2px 0 20px; font-weight: normal; text-align: center; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 7px 8px; font-size: 11px; font-weight: 700; border-bottom: 1px solid #000; }
    td { padding: 5px 8px; border-bottom: 1px solid #e8e8e8; }
    .r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .muted { font-size: 11.5px; }
    .total td { border-top: 1px solid #000; border-bottom: 3px double #000; font-weight: 700; }
    .warn { border: 1px solid #000; padding: 9px 12px; font-size: 12px; margin: 14px 0; }
    .badge { display:inline-block; font-size:11px; border:1px solid #000; padding:1px 8px; margin-right:5px; }
    .footer { margin-top: 30px; font-size: 11px; border-top: 1px solid #000; padding-top: 10px; text-align: center; line-height: 1.6; }
    /* Linhas com o sinal menos comum nesta conta (o aviso acima fala delas) */
    tr.odd td { background: #fff3b0; }
    .barra { position: fixed; top: 18px; right: 18px; display: flex; gap: 8px; }
    .barra button { border: none; font-size: 15px; font-weight: 700; padding: 13px 20px; border-radius: 8px; cursor: pointer; min-height: 48px; font-family: inherit; }
    .voltar { background: #fff; color: #2D3278; border: 1.5px solid #2D3278 !important; }
    .printbtn { background: #2D3278; color: #fff; }
    @media print { body { margin: 14px auto; } .barra { display: none; } }
  </style></head><body>
  <div class="barra">
    <button class="voltar" onclick="voltarAoPnl()">← Voltar ao P&amp;L</button>
    <button class="printbtn" onclick="window.print()">🖨️ Print / Save PDF</button>
  </div>
  <script>
    // Veio do P&L na mesma aba: volta pelo histórico. Abriu por link direto
    // ou em aba nova: abre o P&L do mesmo período.
    function voltarAoPnl() {
      var pnl = ${JSON.stringify(`/api/bookkeeping/pnl?clientId=${clientId}&year=${year}${month ? `&month=${month}` : ''}`)};
      if (window.history.length > 1 && document.referrer && document.referrer.indexOf('/api/bookkeeping/pnl') !== -1) window.history.back();
      else window.location.href = pnl;
    }
  </script>
  <div class="timbre">
    <img src="https://peaceontax-portal.vercel.app/logo.png" alt="Peace on Tax Corp" />
    <div>
      <div class="marca">Peace on Tax Corp</div>
      <div class="contato">75 Pleasant St Suite 119, Malden, MA 02148<br>(833) 732-2327 &middot; info@peaceontax.com &middot; peaceontax.com</div>
    </div>
  </div>

  <div class="muted">${FIRM.name} · ${FIRM.address} · ${FIRM.phone}</div>
  <h1>${displayName}</h1>
  <h2>Account detail: <b>${category}</b> — ${period} <span class="muted">(register only: approved entries)</span></h2>

  <div style="margin-bottom:12px">
    <span class="badge">${list.length} entries</span>
    <span class="badge">${positives} money in (+)</span>
    <span class="badge">${negatives} money out (−)</span>
  </div>

  ${positives > 0 && negatives > 0 ? `<div class="warn">⚠️ Esta conta mistura valores positivos e negativos — as linhas destacadas em amarelo têm o sinal MENOS comum nesta conta. Confira se são estornos/reembolsos legítimos ou lançamentos com sinal errado.</div>` : ''}

  ${diagnostico ? `<div class="warn">🔎 ${diagnostico}</div>` : ''}

  <table>
    <tr><th>Date</th><th>Description</th><th>Payee</th><th>Account</th><th style="text-align:right">Amount</th></tr>
    ${list.map((t: any) => {
      const amt = Number(t.amount)
      const minority = (positives > 0 && negatives > 0) && ((negatives >= positives && amt > 0) || (positives > negatives && amt < 0))
      return `<tr${minority ? ' class="odd"' : ''}>
        <td style="white-space:nowrap">${fmtDate(t.tx_date)}</td>
        <td>${String(t.description).slice(0, 90)}</td>
        <td>${t.payee || '<span class="muted">—</span>'}</td>
        <td class="muted">${nomeConta.get((t as any).account_id) || '—'}</td>
        <td class="r ${amt < 0 ? 'neg' : 'pos'}">${money(amt)}</td>
      </tr>`
    }).join('') || '<tr><td colspan="5" class="muted">No approved entries in this account for the period.</td></tr>'}
    <tr class="total"><td colspan="4">Total ${category}</td><td class="r ${total < 0 ? 'neg' : 'pos'}">${money(total)}</td></tr>
  </table>

  <div class="footer">Peace on Tax Corp · 75 Pleasant St Suite 119, Malden, MA 02148 · (833) 732-2327<br>Prepared by ${FIRM.name} · Generated ${new Date().toLocaleDateString('en-US')} · Internal working document — verify before filing</div>
  </body></html>`

  const output = isClient
    ? html.replace(/Internal working document[^<]*/g, 'Relatório preliminar — sujeito a revisão da nossa equipe')
    : html
  return new NextResponse(output, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0' } })
}
