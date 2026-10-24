// lib/contract-html.ts — texto do contrato em um lugar só.
// Usado pela prévia (👁 Ver contrato) e pelo envio via DocuSign,
// para que o que você confere seja exatamente o que o cliente assina.

import { FREQ_LABEL, type Frequency } from '@/lib/plans'
import { barraDoRelatorio, META_RELATORIO, escaparHtml } from '@/lib/relatorio-barra'
import { fmtUS } from '@/lib/format'
import { porPeriodo } from '@/lib/contrato-unico'
import { primeiraCobranca, ehIntervalo } from '@/lib/contrato-recorrente'

export const FIRM = {
  name: 'Peace on Tax Corp',
  address: '75 Pleasant St Suite 119, Malden, MA 02148',
  phone: '(833) 732-2327',
  email: 'info@peaceontax.com',
}

const ORDINAL_PT: Record<number, string> = { 1: 'dia 1º' }

export function diaPorExtenso(dia: number, lang: 'pt' | 'en'): string {
  if (lang === 'pt') return ORDINAL_PT[dia] || `dia ${dia}`
  const sufixo = dia === 1 ? 'st' : dia === 2 ? 'nd' : dia === 3 ? 'rd'
    : dia === 21 ? 'st' : dia === 22 ? 'nd' : dia === 23 ? 'rd' : 'th'
  return `${dia}${sufixo}`
}

const MES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const MES_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export interface LinhaDoContratoHtml { description: string; quantity: number | string; unit_price: number | string }

export function montarContratoHtml(params: {
  plan: any
  client: any
  signerTitle?: string | null
  previa?: boolean          // marca d'água e aviso, sem áreas de assinatura reais
  /** As linhas do contrato recorrente (payment_plan_items): o que compõe o valor de cada cobrança. */
  itens?: LinhaDoContratoHtml[]
}): string {
  const { plan, client, previa } = params
  // Tudo o que vem do banco ou da URL entra ESCAPADO: o `title` da prévia vem
  // da querystring, e um link com <script> no cargo rodaria na sessão do sócio.
  const esc = escaparHtml
  const signerTitle = params.signerTitle ? esc(params.signerTitle) : null
  const lang: 'pt' | 'en' = client.language === 'pt' ? 'pt' : 'en'
  const isInstallment = plan.kind === 'installment'
  // 'monthly' = outro serviço mensal (payroll, sales tax…): escopo vem da descrição,
  // sem cláusula de transações incluídas, que é exclusiva do bookkeeping.
  const isMonthlyService = plan.kind === 'monthly'
  const money = (n: number) => `$${Number(n || 0).toFixed(2)}`

  const includedTx = plan.included_transactions
  const overageRate = Number(plan.overage_rate ?? 1.25).toFixed(2)
  // Data-base da cobrança: definida no acordo (coluna due_day); 5 permanece como padrão histórico
  const diaCobranca = Number(plan.due_day ?? 5)
  const servicoMensal = esc(String(plan.description || '').trim())

  // ── O contrato recorrente: intervalo, forma de cobrar, linhas e vigência ──
  // O valor é o de CADA COBRANÇA (num trimestral, o do trimestre). Antes o
  // texto dizia "/mês" e "débito automático" sempre — no contrato por fatura,
  // o cliente assinaria uma autorização de débito que não existe.
  const iv = ehIntervalo(plan.billing_interval) ? plan.billing_interval : 'monthly'
  const porFatura = plan.collection_method === 'fatura'
  const prazo = Math.max(0, Number(plan.due_days || 0))
  const periodo = porPeriodo(iv, lang)
  const valor = `${money(plan.monthly_amount)}${periodo}`
  const desconto = Number(plan.discount || 0)
  const linhas = (params.itens || []).filter(l => String(l?.description || '').trim())
  const composicao = (linhas.length > 1 || desconto > 0)
    ? `<li><b>${lang === 'pt' ? 'Composição do valor' : 'Breakdown'}:</b><ul>${linhas.map(l => {
        const q = Number(l.quantity) || 0, u = Number(l.unit_price) || 0
        return `<li>${esc(String(l.description).trim())}${q !== 1 ? ` — ${q} × ${money(u)}` : ''}: ${money(Math.round(q * u * 100) / 100)}</li>`
      }).join('')}${desconto > 0 ? `<li>${lang === 'pt' ? 'Desconto' : 'Discount'}: −${money(desconto)}</li>` : ''}</ul></li>`
    : ''
  // Mês da cobrança anual: o da régua do contrato (início, ou a data já marcada).
  const ref = plan.start_date ? primeiraCobranca(diaCobranca, String(plan.start_date).slice(0, 10))
    : plan.next_charge_date ? String(plan.next_charge_date).slice(0, 10) : null
  const mesAnual = ref ? Number(ref.slice(5, 7)) - 1 : null
  const quandoPt = iv === 'quarterly' ? `no ${diaPorExtenso(diaCobranca, 'pt')}, a cada três meses`
    : iv === 'annual' ? `uma vez por ano, no ${diaPorExtenso(diaCobranca, 'pt')}${mesAnual !== null ? ` de ${MES_PT[mesAnual]}` : ''}`
    : `todo ${diaPorExtenso(diaCobranca, 'pt')} de cada mês`
  const quandoEn = iv === 'quarterly' ? `on the ${diaPorExtenso(diaCobranca, 'en')}, every three months`
    : iv === 'annual' ? `once a year, on ${mesAnual !== null ? `${MES_EN[mesAnual]} ` : 'the '}${diaPorExtenso(diaCobranca, 'en')}`
    : `on the ${diaPorExtenso(diaCobranca, 'en')} of every month`
  const cobrancaPt = porFatura
    ? `<li>Cobrança por fatura emitida <b>${quandoPt}</b>, com vencimento ${prazo ? `em <b>${prazo} dia(s)</b>` : '<b>na data da emissão</b>'}. A fatura fica no portal do cliente e é enviada por e-mail; o pagamento é feito pelo portal ou diretamente à Peace on Tax Corp.</li>`
    : `<li>Cobrança por débito automático autorizado, <b>${quandoPt}</b>.</li>`
  const cobrancaEn = porFatura
    ? `<li>Billed by invoice issued <b>${quandoEn}</b>, due ${prazo ? `<b>${prazo} day(s)</b> after issue` : '<b>on the issue date</b>'}. Each invoice is posted to the client portal and e-mailed; payment is made through the portal or directly to Peace on Tax Corp.</li>`
    : `<li>Billed via authorized automatic debit <b>${quandoEn}</b>.</li>`
  const fim = plan.end_date ? fmtUS(String(plan.end_date).slice(0, 10)) : ''
  const vigenciaPt = fim
    ? `<li>Vigência até <b>${fim}</b>, podendo ser encerrado antes por qualquer parte com aviso de 30 dias.</li>`
    : '<li>Vigência por prazo indeterminado, podendo ser encerrado por qualquer parte com aviso de 30 dias.</li>'
  const vigenciaEn = fim
    ? `<li>Term ends on <b>${fim}</b>; either party may terminate earlier with 30 days notice.</li>`
    : '<li>Open-ended term; either party may terminate with 30 days notice.</li>'

  const termsPt = isInstallment
    ? `<li>Valor total dos serviços: <b>${money(plan.total)}</b></li>
       <li>Entrada: <b>${money(plan.entry_amount)} (${plan.entry_pct}%)</b>, paga no ato da contratação.</li>
       <li>Saldo em <b>${plan.installments} parcela(s) de ${money(plan.installment_amount)}</b>, frequência ${FREQ_LABEL[plan.frequency as Frequency]?.toLowerCase()}, com início 1 período após a entrada, por débito automático autorizado (cartão ou conta bancária ACH).</li>
       <li>O CONTRATANTE reconhece que os serviços descritos foram/estão sendo prestados e que as parcelas são devidas integralmente, não sendo suspensas por qualquer motivo.</li>
       <li><b>Entrega:</b> o serviço somente será finalizado e entregue após a quitação de, no mínimo, <b>75% (setenta e cinco por cento)</b> do valor total contratado.</li>`
    : isMonthlyService
    ? `<li><b>Escopo:</b> ${servicoMensal || 'serviço recorrente'}: <b>${valor}</b>.</li>
       ${composicao}
       <li><b>Serviços NÃO incluídos</b> (cobrados à parte mediante orçamento): quaisquer serviços fora do escopo descrito acima, inclusive declaração de imposto de renda da empresa e de seus sócios e escrituração contábil (bookkeeping).</li>
       ${cobrancaPt}
       ${vigenciaPt}`
    : `<li><b>Escopo:</b> serviços mensais de bookkeeping (escrituração contábil) com geração do demonstrativo de resultados (P&L): <b>${valor}</b>.</li>
       ${composicao}
       <li><b>Transações incluídas:</b> até <b>${includedTx ?? '—'} transações por mês</b>. Transações excedentes serão cobradas à parte, ao valor de <b>$${overageRate} por transação</b>.</li>
       <li><b>Serviços NÃO incluídos</b> (cobrados à parte mediante orçamento): declaração de imposto de renda da empresa e de seus sócios, Meal Tax, Sales Tax, folha de pagamento, e quaisquer outros serviços fora do escopo de bookkeeping.</li>
       ${cobrancaPt}
       ${vigenciaPt}`

  const termsEn = isInstallment
    ? `<li>Total service amount: <b>${money(plan.total)}</b></li>
       <li>Down payment: <b>${money(plan.entry_amount)} (${plan.entry_pct}%)</b>, due upon signing.</li>
       <li>Balance in <b>${plan.installments} installment(s) of ${money(plan.installment_amount)}</b> (${plan.frequency}), starting one period after the down payment, via authorized automatic debit (card or ACH bank account).</li>
       <li>CLIENT acknowledges the services described have been/are being rendered and installments are fully due and non-suspendable.</li>
       <li><b>Delivery:</b> the service will only be finalized and delivered after at least <b>75% (seventy-five percent)</b> of the total contract amount has been paid.</li>`
    : isMonthlyService
    ? `<li><b>Scope:</b> ${servicoMensal || 'recurring service'}: <b>${valor}</b>.</li>
       ${composicao}
       <li><b>Services NOT included</b> (billed separately upon quote): any services outside the scope described above, including business and owners' income tax returns and bookkeeping.</li>
       ${cobrancaEn}
       ${vigenciaEn}`
    : `<li><b>Scope:</b> monthly bookkeeping services including Profit &amp; Loss (P&amp;L) statement generation: <b>${valor}</b>.</li>
       ${composicao}
       <li><b>Included transactions:</b> up to <b>${includedTx ?? '—'} transactions per month</b>. Transactions above this limit are billed separately at <b>$${overageRate} per transaction</b>.</li>
       <li><b>Services NOT included</b> (billed separately upon quote): business and owners' income tax returns, Meal Tax, Sales Tax, payroll, and any other services outside the bookkeeping scope.</li>
       ${cobrancaEn}
       ${vigenciaEn}`

  const displayName = esc(client.business_name || client.name)
  const nomeAssinante = esc(client.name)
  const descricaoParcelado = esc(plan.description || '')
  // Contrato por fatura não autoriza débito: o título e o texto do pagamento
  // dizem o que o cliente de fato aceita.
  const debito = isInstallment || !porFatura
  const t = lang === 'pt'
    ? { title: 'CONTRATO DE PRESTAÇÃO DE SERVIÇOS', between: 'entre', and: 'e',
        services: isInstallment ? (descricaoParcelado || 'Serviços contábeis e fiscais') : isMonthlyService ? (servicoMensal || 'Serviço recorrente') : 'Bookkeeping mensal',
        terms: 'TERMOS E CONDIÇÕES', pay: debito ? 'PAGAMENTO E AUTORIZAÇÃO DE DÉBITO' : 'PAGAMENTO',
        payText: debito
          ? 'O CONTRATANTE autoriza a Peace on Tax Corp a realizar as cobranças descritas acima por meio do método de pagamento cadastrado via Stripe, nos valores e datas pactuados.'
          : 'O CONTRATANTE pagará cada fatura até o vencimento. Não há débito automático neste contrato: cada cobrança é uma fatura, com o valor e a data pactuados acima.',
        sign: 'ASSINATURAS', contractor: 'CONTRATADA', clientLbl: 'CONTRATANTE', scope: 'OBJETO' }
    : { title: 'SERVICE AGREEMENT', between: 'between', and: 'and',
        services: isInstallment ? (descricaoParcelado || 'Accounting and tax services') : isMonthlyService ? (servicoMensal || 'Recurring service') : 'Monthly bookkeeping',
        terms: 'TERMS AND CONDITIONS', pay: debito ? 'PAYMENT AND DEBIT AUTHORIZATION' : 'PAYMENT',
        payText: debito
          ? 'CLIENT authorizes Peace on Tax Corp to charge the payment method on file via Stripe for the amounts and dates agreed above.'
          : 'CLIENT will pay each invoice by its due date. There is no automatic debit under this agreement: each charge is an invoice, for the amount and on the date agreed above.',
        sign: 'SIGNATURES', contractor: 'PROVIDER', clientLbl: 'CLIENT', scope: 'SCOPE' }

  const avisoPrevia = previa
    ? `<div class="previa">${lang === 'pt'
        ? 'PRÉVIA — este documento ainda NÃO foi enviado ao cliente. Confira os termos e feche esta aba para voltar.'
        : 'PREVIEW — this document has NOT been sent to the client yet.'}</div>`
    : ''

  // Na PRÉVIA vale a barra dos impressos (Voltar, Dashboard, Imprimir). No
  // documento que vai ao DocuSign não entra botão nenhum: é o que o cliente
  // assina.
  const barra = previa
    ? barraDoRelatorio({ voltarPara: '/dashboard/billing', painelPara: '/dashboard', rotuloImprimir: 'Imprimir' })
    : null

  return `<!DOCTYPE html><html><head><meta charset="utf-8">${META_RELATORIO}<title>${t.title}</title><style>
    body { font-family: Georgia, "Times New Roman", serif; font-size: 13px; color:#000; margin: 40px 50px; line-height: 1.7; }
    h1 { font-size: 18px; text-align:center; font-weight:700; }
    h2 { font-size: 14px; margin-top: 24px; border-bottom:1px solid #000; padding-bottom:3px; }
    .parties { border:1px solid #000; padding: 12px 16px; }
    .sigline { margin-top: 40px; }
    .siglabel { font-size: 11px; color:#444; }
    .previa { background:#FFF3E6; border:2px solid #C06010; color:#8A4A08; font-weight:700;
              padding:12px 16px; margin-bottom:22px; text-align:center; font-size:13px; }
    ${barra?.css || ''}
    @media print { .previa { display:none; } body { margin: 0; } }
  </style></head><body>
    ${avisoPrevia}
    ${barra?.html || ''}
    <h1>${t.title}</h1>
    <div class="parties">
      <b>${FIRM.name}</b> (${t.contractor}) — ${FIRM.address} — ${FIRM.phone} — ${FIRM.email}<br>
      ${t.between} ${t.and}<br>
      <b>${displayName}</b> (${t.clientLbl})${client.business_name ? ` — ${lang === 'pt' ? 'representada por' : 'represented by'} ${nomeAssinante}${signerTitle ? `, ${signerTitle}` : ''}` : ''} — ${esc(client.email)}
    </div>
    <h2>${t.scope}</h2>
    <p>${t.services}</p>
    <h2>${t.terms}</h2>
    <ul>${lang === 'pt' ? termsPt : termsEn}</ul>
    <h2>${t.pay}</h2>
    <p>${t.payText}</p>
    <h2>${t.sign}</h2>
    <div class="sigline">
      <p class="siglabel">${t.clientLbl}: ${nomeAssinante}${signerTitle ? ` — ${signerTitle}` : ''}</p>
      <p>/sig1/ &nbsp;&nbsp;&nbsp; /date1/</p>
    </div>
    <div class="sigline">
      <p class="siglabel">${t.contractor}: David Lazzarotto — Peace on Tax Corp</p>
      <p>/sig2/ &nbsp;&nbsp;&nbsp; /date2/</p>
    </div>
  </body></html>`
}
