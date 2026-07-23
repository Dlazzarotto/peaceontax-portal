// GET /api/bookkeeping/category-detail?clientId=...&year=YYYY&month=MM?&category=...
// Drill-down do P&L: todos os lançamentos DO REGISTRO daquela categoria,
// para conferência (aberto em nova aba ao clicar na linha do relatório).

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

const FIRM = {
  name: 'Peace on Tax Corp',
  address: '75 Pleasant St Suite 119, Malden, MA 02148',
  phone: '(833) 732-2327',
}

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  const year = parseInt(sp.get('year') || '')
  const month = sp.get('month')
  const category = sp.get('category')
  if (!clientId || !year || !category) {
    return NextResponse.json({ error: 'clientId, year e category obrigatórios' }, { status: 400 })
  }
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const { data: client } = await db.from('clients')
    .select('name, business_name').eq('id', clientId).single()

  let q = db.from('bank_transactions')
    .select('tx_date, description, payee, amount, status, bank_accounts(name)')
    .eq('client_id', clientId)
    .eq('fiscal_year', year)
    .eq('category', category)
    .in('status', ['approved', 'reviewed'])
    .order('tx_date', { ascending: true })
    .limit(5000)
  const { data: txs } = await q

  let list = txs || []
  if (month && /^\d{1,2}$/.test(month)) {
    const mm = month.padStart(2, '0')
    list = list.filter(t => String(t.tx_date).slice(5, 7) === mm)
  }

  const money = (v: number) => {
    const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return v < 0 ? `-$${abs}` : `$${abs}`
  }
  const total = list.reduce((s, t) => s + Number(t.amount), 0)
  const positives = list.filter(t => Number(t.amount) > 0).length
  const negatives = list.filter(t => Number(t.amount) < 0).length
  const displayName = client?.business_name || client?.name || 'Client'
  const period = month ? `${month.padStart(2, '0')}/${year}` : String(year)

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${category} — ${period}</title>
  <style>
    body { font-family: Georgia, serif; max-width: 860px; margin: 34px auto; color: #1a2a3a; padding: 0 20px; }
    h1 { font-size: 18px; color: #2D3278; margin-bottom: 2px; }
    h2 { font-size: 14px; color: #0f2340; margin: 2px 0 18px; font-weight: normal; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.5px;
         color: #fff; background: #2D3278; }
    td { padding: 7px 8px; border-bottom: 1px solid #eef1f6; vertical-align: top; }
    .r { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .neg { color: #b02020; }
    .pos { color: #1a6b4a; }
    .odd { background: #fff7e0; }
    .total td { border-top: 2px solid #2D3278; font-weight: 800; font-size: 14px; }
    .muted { color: #8a9ab0; font-size: 11.5px; }
    .badge { display:inline-block; padding: 2px 10px; border-radius: 14px; font-size: 11px; font-weight: 700; }
    .warn { background: #fff7e0; border: 1px solid #e0c060; border-radius: 8px; padding: 10px 14px;
            font-size: 12.5px; margin: 14px 0; color: #6a5a10; }
    .footer { margin-top: 26px; font-size: 11px; color: #9aaab0; border-top: 1px solid #e2e8f4; padding-top: 10px; }
    @media print { body { margin: 14px auto; } }
  </style></head><body>
  <div class="muted">${FIRM.name} · ${FIRM.address} · ${FIRM.phone}</div>
  <h1>${displayName}</h1>
  <h2>Account detail: <b>${category}</b> — ${period} <span class="muted">(register only: approved entries)</span></h2>

  <div style="margin-bottom:12px">
    <span class="badge" style="background:#f0f4ff;color:#2D3278">${list.length} entries</span>
    <span class="badge" style="background:#e8f5ee;color:#1a6b4a">${positives} money in (+)</span>
    <span class="badge" style="background:#fee2e2;color:#b02020">${negatives} money out (−)</span>
  </div>

  ${positives > 0 && negatives > 0 ? `<div class="warn">⚠️ Esta conta mistura valores positivos e negativos — as linhas destacadas em amarelo têm o sinal MENOS comum nesta conta. Confira se são estornos/reembolsos legítimos ou lançamentos com sinal errado.</div>` : ''}

  <table>
    <tr><th>Date</th><th>Description</th><th>Payee</th><th>Account</th><th style="text-align:right">Amount</th></tr>
    ${list.map(t => {
      const amt = Number(t.amount)
      const minority = (positives > 0 && negatives > 0) && ((negatives >= positives && amt > 0) || (positives > negatives && amt < 0))
      return `<tr${minority ? ' class="odd"' : ''}>
        <td style="white-space:nowrap">${t.tx_date}</td>
        <td>${String(t.description).slice(0, 90)}</td>
        <td>${t.payee || '<span class="muted">—</span>'}</td>
        <td class="muted">${(t as any).bank_accounts?.name || '—'}</td>
        <td class="r ${amt < 0 ? 'neg' : 'pos'}">${money(amt)}</td>
      </tr>`
    }).join('') || '<tr><td colspan="5" class="muted">No approved entries in this account for the period.</td></tr>'}
    <tr class="total"><td colspan="4">Total ${category}</td><td class="r ${total < 0 ? 'neg' : 'pos'}">${money(total)}</td></tr>
  </table>

  <div class="footer">Prepared by ${FIRM.name} · Generated ${new Date().toLocaleDateString('en-US')} · Internal working document — verify before filing</div>
  </body></html>`

  return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}
