// /api/billing/print?id=... — fatura ou orçamento em formato de impressão
//
// Mesmo padrão dos relatórios contábeis: preto e branco, Georgia,
// timbre com a logo, pronto para imprimir ou salvar em PDF pelo navegador.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { permissoesFinanceiro } from '@/lib/billing-perms'

export const dynamic = 'force-dynamic'

const FIRM = {
  name: 'Peace on Tax Corp',
  address: '75 Pleasant St Suite 119, Malden, MA 02148',
  phone: '(833) 732-2327',
  email: 'info@peaceontax.com',
  site: 'peaceontax.com',
  logo: 'https://peaceontax-portal.vercel.app/logo.png',
}

const money = (v: any) =>
  `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const dataUS = (d: string | null) => {
  if (!d) return '—'
  const [y, m, dia] = String(d).slice(0, 10).split('-')
  return `${m}/${dia}/${y}`
}

const FORMAS: Record<string, string> = {
  card: 'Cartão', ach: 'Débito em conta (ACH)', zelle: 'Zelle', venmo: 'Venmo',
  cash: 'Dinheiro', check: 'Cheque', wire: 'Wire', external: 'Financiadora', other: 'Outro',
}

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return new NextResponse('Acesso restrito', { status: 403 })
  await permissoesFinanceiro(auth.userId)   // qualquer nível pode imprimir

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return new NextResponse('id obrigatório', { status: 400 })

  const db = serviceDb()

  // Busca sem enumerar colunas do cliente: assim a impressão não quebra
  // se a tabela não tiver algum campo de endereço.
  const { data: inv, error: errInv } = await db.from('invoices')
    .select('*').eq('id', id).maybeSingle()

  if (errInv) {
    return new NextResponse(`Erro ao buscar o documento: ${errInv.message}`, { status: 500 })
  }
  if (!inv) return new NextResponse('Documento não encontrado', { status: 404 })

  const [{ data: cli }, { data: itens }, { data: pagos }, { data: parcelas }] = await Promise.all([
    db.from('clients').select('*').eq('id', inv.client_id).maybeSingle(),
    db.from('invoice_items').select('*').eq('invoice_id', id).order('sort'),
    db.from('invoice_payments').select('amount, method, reference, received_at, financier')
      .eq('invoice_id', id).order('received_at'),
    db.from('invoice_installments').select('seq, due_date, amount, status')
      .eq('invoice_id', id).order('seq'),
  ])

  const c: any = cli || {}
  const nome = c.business_name || c.name || '—'
  const ehOrcamento = inv.doc_type === 'estimate'
  const saldo = Number(inv.total) - Number(inv.paid_total)

  const endereco = [c.address, [c.city, c.state].filter(Boolean).join(', '), c.zip]
    .filter(Boolean).join(' · ')

  const linhasItens = (itens || []).map((i: any) => `
    <tr>
      <td>${i.description}</td>
      <td class="num">${Number(i.qty)}</td>
      <td class="num">${money(i.unit_price)}</td>
      <td class="num">${money(i.amount)}</td>
    </tr>`).join('')

  const blocoParcelas = (parcelas || []).length ? `
    <h3>Parcelamento</h3>
    <table class="lista">
      <thead><tr><th>Parcela</th><th>Vencimento</th><th class="num">Valor</th><th>Situação</th></tr></thead>
      <tbody>
        ${(parcelas || []).map((p: any) => `
          <tr>
            <td>${p.seq}ª</td>
            <td>${dataUS(p.due_date)}</td>
            <td class="num">${money(p.amount)}</td>
            <td>${p.status === 'paid' ? 'paga' : p.status === 'failed' ? 'recusada' : 'a vencer'}</td>
          </tr>`).join('')}
      </tbody>
    </table>` : ''

  const blocoPagamentos = (pagos || []).length ? `
    <h3>Pagamentos recebidos</h3>
    <table class="lista">
      <thead><tr><th>Data</th><th>Forma</th><th>Referência</th><th class="num">Valor</th></tr></thead>
      <tbody>
        ${(pagos || []).map((p: any) => `
          <tr>
            <td>${dataUS(String(p.received_at).slice(0, 10))}</td>
            <td>${FORMAS[p.method] || p.method}${p.financier ? ` — ${p.financier}` : ''}</td>
            <td>${p.reference || '—'}</td>
            <td class="num">${money(p.amount)}</td>
          </tr>`).join('')}
      </tbody>
    </table>` : ''

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${inv.number} — ${FIRM.name}</title><style>
  body { font-family: Georgia, "Times New Roman", serif; font-size: 12.5px; color:#000;
         margin: 34px 44px; line-height: 1.6; }
  .timbre { display:flex; align-items:center; gap:14px; border-bottom:2px solid #000;
            padding-bottom:12px; margin-bottom:18px; }
  .timbre img { height:44px; }
  .marca { font-size:19px; font-weight:700; }
  .contato { font-size:10.5px; line-height:1.5; }
  .topo { display:flex; justify-content:space-between; gap:30px; margin-bottom:18px; }
  .titulo { font-size:22px; font-weight:700; letter-spacing:1px; text-align:right; }
  .numero { font-size:13px; text-align:right; }
  .para { border:1px solid #000; padding:10px 13px; font-size:12px; min-width:270px; }
  .rotulo { font-size:9.5px; letter-spacing:0.6px; color:#444; text-transform:uppercase; }
  table { width:100%; border-collapse:collapse; margin:14px 0; font-size:12px; }
  th { text-align:left; font-size:10px; letter-spacing:0.6px; text-transform:uppercase;
       border-bottom:1.5px solid #000; padding:7px 8px; }
  td { padding:7px 8px; border-bottom:1px solid #ccc; }
  .num { text-align:right; font-variant-numeric: tabular-nums; white-space:nowrap; }
  .totais { width:290px; margin-left:auto; margin-top:6px; }
  .totais td { border:none; padding:4px 8px; }
  .totais .destaque td { border-top:1.5px solid #000; border-bottom:3px double #000;
                         font-weight:700; font-size:14px; }
  h3 { font-size:12px; text-transform:uppercase; letter-spacing:0.8px;
       border-bottom:1px solid #000; padding-bottom:3px; margin:22px 0 4px; }
  .obs { border-left:3px solid #000; padding-left:10px; font-size:11.5px; margin-top:16px; }
  .rodape { margin-top:26px; border-top:1px solid #000; padding-top:8px;
            font-size:10px; text-align:center; }
  .imprimir { position:fixed; top:14px; right:14px; background:#2D3278; color:#fff; border:none;
              padding:12px 18px; border-radius:8px; font-size:14px; font-weight:700; cursor:pointer; }
  @media print { .imprimir { display:none; } body { margin:0; } }
</style></head><body>
  <button class="imprimir" onclick="window.print()">Imprimir / Salvar PDF</button>

  <div class="timbre">
    <img src="${FIRM.logo}" alt="${FIRM.name}" />
    <div>
      <div class="marca">${FIRM.name}</div>
      <div class="contato">${FIRM.address}<br>${FIRM.phone} · ${FIRM.email} · ${FIRM.site}</div>
    </div>
  </div>

  <div class="topo">
    <div class="para">
      <div class="rotulo">${ehOrcamento ? 'Orçamento para' : 'Fatura para'}</div>
      <b>${nome}</b><br>
      ${endereco ? endereco + '<br>' : ''}
      ${c.email || ''}${c.phone ? ' · ' + c.phone : ''}
    </div>
    <div>
      <div class="titulo">${ehOrcamento ? 'ORÇAMENTO' : 'FATURA'}</div>
      <div class="numero">
        <b>${inv.number}</b><br>
        Emissão: ${dataUS(inv.issue_date)}<br>
        ${inv.due_date ? `Vencimento: ${dataUS(inv.due_date)}` : ''}
      </div>
    </div>
  </div>

  <table>
    <thead>
      <tr><th>Descrição</th><th class="num">Qtd</th><th class="num">Preço</th><th class="num">Valor</th></tr>
    </thead>
    <tbody>${linhasItens || '<tr><td colspan="4">Sem itens.</td></tr>'}</tbody>
  </table>

  <table class="totais">
    <tr><td>Subtotal</td><td class="num">${money(inv.subtotal)}</td></tr>
    ${Number(inv.discount) > 0 ? `<tr><td>Desconto</td><td class="num">- ${money(inv.discount)}</td></tr>` : ''}
    <tr class="destaque"><td>Total</td><td class="num">${money(inv.total)}</td></tr>
    ${Number(inv.paid_total) > 0 ? `
      <tr><td>Recebido</td><td class="num">- ${money(inv.paid_total)}</td></tr>
      <tr class="destaque"><td>${saldo > 0 ? 'Saldo devedor' : 'Quitada'}</td>
          <td class="num">${money(Math.max(saldo, 0))}</td></tr>` : ''}
  </table>

  ${blocoParcelas}
  ${blocoPagamentos}

  ${inv.notes ? `<div class="obs"><b>Observações:</b> ${inv.notes}</div>` : ''}

  ${ehOrcamento
    ? `<div class="obs">Este orçamento é válido por 30 dias a partir da data de emissão.</div>`
    : saldo > 0
      ? `<div class="obs">Pagamento até ${dataUS(inv.due_date)}. Dúvidas: ${FIRM.phone}.</div>`
      : `<div class="obs">Documento quitado. Obrigado pela preferência.</div>`}

  <div class="rodape">${FIRM.name} — ${FIRM.address} — ${FIRM.phone} — ${FIRM.site}</div>
</body></html>`

  return new NextResponse(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}
