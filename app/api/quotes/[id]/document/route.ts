// GET /api/quotes/[id]/document
// Gera o documento da cotação em HTML pronto para imprimir / salvar como PDF.
// status draft/sent → ESTIMATE (validade 30 dias)
// status paid       → INVOICE com carimbo PAID
// Idioma: do cliente (pt/en/es). Equipe e o próprio cliente podem acessar.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

const FIRM = {
  name: 'Peace on Tax Corp',
  address: '75 Pleasant St Suite 119, Malden, MA 02148',
  phone: '(833) 732-2327',
  email: 'info@peaceontax.com',
  site: 'peaceontax.com',
}

const T: Record<string, any> = {
  pt: {
    estimate: 'ORÇAMENTO', invoice: 'FATURA', paid: 'PAGO',
    client: 'Cliente', date: 'Data de emissão', validity: 'Válido até',
    fiscalYear: 'Ano fiscal', service: 'Serviço', qty: 'Qtd',
    unit: 'Valor unit.', subtotal: 'Subtotal', total: 'TOTAL',
    discount: 'Desconto', paidOn: 'Pago em', queuedFor: 'Fila de trabalho',
    terms: 'Condições',
    termsList: [
      'O trabalho inicia somente após a confirmação do pagamento.',
      'Pagamentos confirmados após 16h (horário do Leste) entram na fila do próximo dia útil.',
      'Diferenças identificadas durante o preparo serão cobradas antes da entrega.',
      'Este orçamento é uma estimativa baseada nos documentos apresentados.',
    ],
    thanks: 'Obrigado pela confiança!',
    print: 'Imprimir / Salvar PDF',
  },
  en: {
    estimate: 'ESTIMATE', invoice: 'INVOICE', paid: 'PAID',
    client: 'Client', date: 'Issue date', validity: 'Valid until',
    fiscalYear: 'Tax year', service: 'Service', qty: 'Qty',
    unit: 'Unit price', subtotal: 'Subtotal', total: 'TOTAL',
    discount: 'Discount', paidOn: 'Paid on', queuedFor: 'Work queue date',
    terms: 'Terms',
    termsList: [
      'Work begins only after payment confirmation.',
      'Payments confirmed after 4pm ET are queued for the next business day.',
      'Differences identified during preparation will be billed before delivery.',
      'This estimate is based on the documents provided.',
    ],
    thanks: 'Thank you for your trust!',
    print: 'Print / Save PDF',
  },
  es: {
    estimate: 'PRESUPUESTO', invoice: 'FACTURA', paid: 'PAGADO',
    client: 'Cliente', date: 'Fecha de emisión', validity: 'Válido hasta',
    fiscalYear: 'Año fiscal', service: 'Servicio', qty: 'Cant.',
    unit: 'Precio unit.', subtotal: 'Subtotal', total: 'TOTAL',
    discount: 'Descuento', paidOn: 'Pagado el', queuedFor: 'Fecha de cola',
    terms: 'Condiciones',
    termsList: [
      'El trabajo comienza solo después de la confirmación del pago.',
      'Pagos confirmados después de las 4pm ET entran en la cola del siguiente día hábil.',
      'Diferencias identificadas durante la preparación se facturarán antes de la entrega.',
      'Este presupuesto es una estimación basada en los documentos presentados.',
    ],
    thanks: '¡Gracias por su confianza!',
    print: 'Imprimir / Guardar PDF',
  },
}

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!))

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await getAuth()
  if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  const db = serviceDb()
  const { data: quote } = await db
    .from('quotes')
    .select('*, clients(name, email, phone, address_line1, city, state, zip, language, business_name, type)')
    .eq('id', params.id)
    .single()

  if (!quote) return NextResponse.json({ error: 'Cotação não encontrada' }, { status: 404 })
  if (!(await canAccessClient(auth, quote.client_id))) {
    return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
  }
  if (quote.status === 'cancelled') {
    return NextResponse.json({ error: 'Cotação cancelada não gera documento' }, { status: 409 })
  }

  const client = quote.clients as any
  const lang = ['pt','en','es'].includes(client?.language) ? client.language : 'en'
  const t = T[lang]
  const isPaid = quote.status === 'paid'

  // Garante numeração (fallback caso a migração não tenha numerado)
  let docNumber = isPaid ? quote.inv_number : quote.est_number
  if (!docNumber) {
    const { data: num } = await db.rpc('next_doc_number', { p_type: isPaid ? 'INV' : 'EST' })
    docNumber = num
    await db.from('quotes').update(isPaid ? { inv_number: docNumber } : { est_number: docNumber }).eq('id', params.id)
  }

  const issued = new Date(quote.created_at)
  const validUntil = new Date(issued); validUntil.setDate(validUntil.getDate() + 30)
  const fmtDate = (d: Date) => d.toLocaleDateString(lang === 'pt' ? 'pt-BR' : lang === 'es' ? 'es' : 'en-US', { day:'2-digit', month:'long', year:'numeric', timeZone:'America/New_York' })
  const money = (n: number) => `$${Math.abs(n).toFixed(2)}`

  const items: { label:string; amount:number; qty?:number }[] = quote.items || []
  const positives = items.filter(i => i.amount * (i.qty || 1) >= 0)
  const negatives = items.filter(i => i.amount * (i.qty || 1) < 0)
  const discountTotal = negatives.reduce((s, i) => s + Math.abs(i.amount * (i.qty || 1)), 0)

  const rows = positives.map(i => {
    const qty = i.qty || 1
    const line = i.amount * qty
    return `<tr>
      <td>${esc(i.label)}</td>
      <td class="c">${qty}</td>
      <td class="r">${i.amount === 0 ? '—' : money(i.amount)}</td>
      <td class="r">${line === 0 ? (lang === 'pt' ? 'Incluído' : lang === 'es' ? 'Incluido' : 'Included') : money(line)}</td>
    </tr>`
  }).join('')

  const discountRow = discountTotal > 0
    ? `<tr class="discount"><td colspan="3">${t.discount}</td><td class="r">−${money(discountTotal)}</td></tr>`
    : ''

  const paidInfo = isPaid && quote.paid_at ? `
    <div class="paidbox">
      <div class="stamp">${t.paid}</div>
      <div>${t.paidOn}: <strong>${fmtDate(new Date(quote.paid_at))}</strong></div>
      ${quote.payment_queued_for ? `<div>${t.queuedFor}: <strong>${fmtDate(new Date(quote.payment_queued_for + 'T12:00:00Z'))}</strong></div>` : ''}
    </div>` : ''

  const clientAddr = [client?.address_line1, client?.city, client?.state, client?.zip].filter(Boolean).join(', ')

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${docNumber} — ${FIRM.name}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color:#1a2a3a; background:#f0f4fa; padding:24px; font-size:18px; }
  .sheet { max-width:820px; margin:0 auto; background:#fff; padding:48px 56px; border-radius:8px; box-shadow:0 2px 24px rgba(45,50,120,0.12); }
  .top { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:4px solid #2D3278; padding-bottom:24px; margin-bottom:28px; }
  .firm h1 { font-size:26px; color:#2D3278; margin-bottom:6px; }
  .firm p { font-size:14px; color:#5a6a7a; line-height:1.6; }
  .docmeta { text-align:right; }
  .doctype { font-size:30px; font-weight:800; color:${isPaid ? '#1a6b4a' : '#F47B20'}; letter-spacing:2px; }
  .docnum { font-size:17px; color:#2D3278; font-weight:700; margin-top:4px; }
  .docmeta p { font-size:14px; color:#5a6a7a; margin-top:4px; }
  .clientbox { background:#f8faff; border:1px solid #e2e8f4; border-radius:10px; padding:16px 20px; margin-bottom:26px; }
  .clientbox .label { font-size:12px; text-transform:uppercase; letter-spacing:1px; color:#6a7a9a; font-weight:700; }
  .clientbox .name { font-size:19px; font-weight:700; color:#0f2340; margin-top:2px; }
  .clientbox p { font-size:14px; color:#5a6a7a; margin-top:2px; }
  table { width:100%; border-collapse:collapse; margin-bottom:8px; }
  thead th { background:#2D3278; color:#fff; font-size:13px; text-transform:uppercase; letter-spacing:0.5px; padding:11px 14px; text-align:left; }
  thead th.c, td.c { text-align:center; }
  thead th.r, td.r { text-align:right; }
  tbody td { padding:11px 14px; font-size:15.5px; border-bottom:1px solid #eef2f8; }
  tr.discount td { color:#b02020; font-weight:700; }
  .totalrow { display:flex; justify-content:flex-end; margin-top:10px; }
  .totalbox { background:#2D3278; color:#fff; border-radius:10px; padding:14px 26px; display:flex; gap:32px; align-items:baseline; }
  .totalbox .lbl { font-size:14px; letter-spacing:1px; }
  .totalbox .val { font-size:28px; font-weight:800; }
  .paidbox { margin-top:20px; border:2px solid #1a6b4a; background:#e8f5ee; border-radius:10px; padding:14px 20px; font-size:15px; color:#1a4a34; display:flex; gap:24px; align-items:center; flex-wrap:wrap; }
  .stamp { font-size:22px; font-weight:800; color:#1a6b4a; border:3px solid #1a6b4a; border-radius:8px; padding:4px 16px; transform:rotate(-4deg); }
  .terms { margin-top:32px; border-top:1px solid #e2e8f4; padding-top:18px; }
  .terms h3 { font-size:14px; text-transform:uppercase; letter-spacing:1px; color:#2D3278; margin-bottom:8px; }
  .terms li { font-size:13.5px; color:#5a6a7a; line-height:1.7; margin-left:18px; }
  .thanks { margin-top:26px; font-size:16px; color:#F47B20; font-weight:700; text-align:center; }
  .printbtn { position:fixed; top:18px; right:18px; background:#F47B20; color:#fff; border:none; font-size:16px; font-weight:700; padding:14px 22px; border-radius:10px; cursor:pointer; box-shadow:0 4px 16px rgba(244,123,32,0.4); min-height:48px; }
  @media print {
    body { background:#fff; padding:0; }
    .sheet { box-shadow:none; padding:20px 8px; max-width:100%; }
    .printbtn { display:none; }
  }
</style>
</head>
<body>
<button class="printbtn" onclick="window.print()">🖨️ ${t.print}</button>
<div class="sheet">
  <div class="top">
    <div class="firm">
      <h1>${FIRM.name}</h1>
      <p>${FIRM.address}<br>${FIRM.phone} · ${FIRM.email}<br>${FIRM.site}</p>
    </div>
    <div class="docmeta">
      <div class="doctype">${isPaid ? t.invoice : t.estimate}</div>
      <div class="docnum">${docNumber}</div>
      <p>${t.date}: <strong>${fmtDate(issued)}</strong></p>
      ${!isPaid ? `<p>${t.validity}: <strong>${fmtDate(validUntil)}</strong></p>` : ''}
      <p>${t.fiscalYear}: <strong>${quote.fiscal_year}</strong></p>
    </div>
  </div>

  <div class="clientbox">
    <div class="label">${t.client}</div>
    <div class="name">${esc(client?.business_name || client?.name || '')}</div>
    ${client?.business_name && client?.name ? `<p>${esc(client.name)}</p>` : ''}
    ${clientAddr ? `<p>${esc(clientAddr)}</p>` : ''}
    ${client?.email ? `<p>${esc(client.email)}${client?.phone ? ' · ' + esc(client.phone) : ''}</p>` : ''}
  </div>

  <table>
    <thead>
      <tr><th>${t.service}</th><th class="c">${t.qty}</th><th class="r">${t.unit}</th><th class="r">${t.subtotal}</th></tr>
    </thead>
    <tbody>
      ${rows}
      ${discountRow}
    </tbody>
  </table>

  <div class="totalrow">
    <div class="totalbox"><span class="lbl">${t.total}</span><span class="val">$${Number(quote.total).toFixed(2)}</span></div>
  </div>

  ${paidInfo}

  <div class="terms">
    <h3>${t.terms}</h3>
    <ul>${t.termsList.map((x: string) => `<li>${x}</li>`).join('')}</ul>
  </div>

  <div class="thanks">${t.thanks}</div>
</div>
</body>
</html>`

  return new NextResponse(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}
