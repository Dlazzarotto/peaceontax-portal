// lib/contract-html.ts — texto do contrato em um lugar só.
// Usado pela prévia (👁 Ver contrato) e pelo envio via DocuSign,
// para que o que você confere seja exatamente o que o cliente assina.

import { FREQ_LABEL, type Frequency } from '@/lib/plans'

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

export function montarContratoHtml(params: {
  plan: any
  client: any
  signerTitle?: string | null
  previa?: boolean          // marca d'água e aviso, sem áreas de assinatura reais
}): string {
  const { plan, client, signerTitle, previa } = params
  const lang: 'pt' | 'en' = client.language === 'pt' ? 'pt' : 'en'
  const isInstallment = plan.kind === 'installment'
  const money = (n: number) => `$${Number(n || 0).toFixed(2)}`

  const includedTx = plan.included_transactions
  const overageRate = Number(plan.overage_rate ?? 1.25).toFixed(2)
  // Data-base da cobrança: definida no acordo; 5 permanece como padrão histórico
  const diaCobranca = Number(plan.billing_day ?? 5)

  const termsPt = isInstallment
    ? `<li>Valor total dos serviços: <b>${money(plan.total)}</b></li>
       <li>Entrada: <b>${money(plan.entry_amount)} (${plan.entry_pct}%)</b>, paga no ato da contratação.</li>
       <li>Saldo em <b>${plan.installments} parcela(s) de ${money(plan.installment_amount)}</b>, frequência ${FREQ_LABEL[plan.frequency as Frequency]?.toLowerCase()}, com início 1 período após a entrada, por débito automático autorizado (cartão ou conta bancária ACH).</li>
       <li>O CONTRATANTE reconhece que os serviços descritos foram/estão sendo prestados e que as parcelas são devidas integralmente, não sendo suspensas por qualquer motivo.</li>
       <li><b>Entrega:</b> o serviço somente será finalizado e entregue após a quitação de, no mínimo, <b>75% (setenta e cinco por cento)</b> do valor total contratado.</li>`
    : `<li><b>Escopo:</b> serviços mensais de bookkeeping (escrituração contábil) com geração do demonstrativo de resultados (P&L): <b>${money(plan.monthly_amount)}/mês</b>.</li>
       <li><b>Transações incluídas:</b> até <b>${includedTx ?? '—'} transações por mês</b>. Transações excedentes serão cobradas à parte, ao valor de <b>$${overageRate} por transação</b>.</li>
       <li><b>Serviços NÃO incluídos</b> (cobrados à parte mediante orçamento): declaração de imposto de renda da empresa e de seus sócios, Meal Tax, Sales Tax, folha de pagamento, e quaisquer outros serviços fora do escopo de bookkeeping.</li>
       <li>Cobrança por débito automático autorizado, <b>todo ${diaPorExtenso(diaCobranca, 'pt')} de cada mês</b>.</li>
       <li>Vigência por prazo indeterminado, podendo ser encerrado por qualquer parte com aviso de 30 dias.</li>`

  const termsEn = isInstallment
    ? `<li>Total service amount: <b>${money(plan.total)}</b></li>
       <li>Down payment: <b>${money(plan.entry_amount)} (${plan.entry_pct}%)</b>, due upon signing.</li>
       <li>Balance in <b>${plan.installments} installment(s) of ${money(plan.installment_amount)}</b> (${plan.frequency}), starting one period after the down payment, via authorized automatic debit (card or ACH bank account).</li>
       <li>CLIENT acknowledges the services described have been/are being rendered and installments are fully due and non-suspendable.</li>
       <li><b>Delivery:</b> the service will only be finalized and delivered after at least <b>75% (seventy-five percent)</b> of the total contract amount has been paid.</li>`
    : `<li><b>Scope:</b> monthly bookkeeping services including Profit &amp; Loss (P&amp;L) statement generation: <b>${money(plan.monthly_amount)}/month</b>.</li>
       <li><b>Included transactions:</b> up to <b>${includedTx ?? '—'} transactions per month</b>. Transactions above this limit are billed separately at <b>$${overageRate} per transaction</b>.</li>
       <li><b>Services NOT included</b> (billed separately upon quote): business and owners' income tax returns, Meal Tax, Sales Tax, payroll, and any other services outside the bookkeeping scope.</li>
       <li>Billed via authorized automatic debit on <b>the ${diaPorExtenso(diaCobranca, 'en')} of every month</b>.</li>
       <li>Open-ended term; either party may terminate with 30 days notice.</li>`

  const displayName = client.business_name || client.name
  const t = lang === 'pt'
    ? { title: 'CONTRATO DE PRESTAÇÃO DE SERVIÇOS', between: 'entre', and: 'e',
        services: isInstallment ? (plan.description || 'Serviços contábeis e fiscais') : 'Bookkeeping mensal',
        terms: 'TERMOS E CONDIÇÕES', pay: 'PAGAMENTO E AUTORIZAÇÃO DE DÉBITO',
        payText: 'O CONTRATANTE autoriza a Peace on Tax Corp a realizar as cobranças descritas acima por meio do método de pagamento cadastrado via Stripe, nos valores e datas pactuados.',
        sign: 'ASSINATURAS', contractor: 'CONTRATADA', clientLbl: 'CONTRATANTE', scope: 'OBJETO' }
    : { title: 'SERVICE AGREEMENT', between: 'between', and: 'and',
        services: isInstallment ? (plan.description || 'Accounting and tax services') : 'Monthly bookkeeping',
        terms: 'TERMS AND CONDITIONS', pay: 'PAYMENT AND DEBIT AUTHORIZATION',
        payText: 'CLIENT authorizes Peace on Tax Corp to charge the payment method on file via Stripe for the amounts and dates agreed above.',
        sign: 'SIGNATURES', contractor: 'PROVIDER', clientLbl: 'CLIENT', scope: 'SCOPE' }

  const avisoPrevia = previa
    ? `<div class="previa">${lang === 'pt'
        ? 'PRÉVIA — este documento ainda NÃO foi enviado ao cliente. Confira os termos e feche esta aba para voltar.'
        : 'PREVIEW — this document has NOT been sent to the client yet.'}</div>`
    : ''

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${t.title}</title><style>
    body { font-family: Georgia, "Times New Roman", serif; font-size: 13px; color:#000; margin: 40px 50px; line-height: 1.7; }
    h1 { font-size: 18px; text-align:center; font-weight:700; }
    h2 { font-size: 14px; margin-top: 24px; border-bottom:1px solid #000; padding-bottom:3px; }
    .parties { border:1px solid #000; padding: 12px 16px; }
    .sigline { margin-top: 40px; }
    .siglabel { font-size: 11px; color:#444; }
    .previa { background:#FFF3E6; border:2px solid #C06010; color:#8A4A08; font-weight:700;
              padding:12px 16px; margin-bottom:22px; text-align:center; font-size:13px; }
    .imprimir { position:fixed; top:16px; right:16px; background:#2D3278; color:#fff; border:none;
                padding:12px 18px; border-radius:8px; font-size:14px; font-weight:700; cursor:pointer; }
    @media print { .previa, .imprimir { display:none; } body { margin: 0; } }
  </style></head><body>
    ${avisoPrevia}
    ${previa ? '<button class="imprimir" onclick="window.print()">Imprimir</button>' : ''}
    <h1>${t.title}</h1>
    <div class="parties">
      <b>${FIRM.name}</b> (${t.contractor}) — ${FIRM.address} — ${FIRM.phone} — ${FIRM.email}<br>
      ${t.between} ${t.and}<br>
      <b>${displayName}</b> (${t.clientLbl})${client.business_name ? ` — ${lang === 'pt' ? 'representada por' : 'represented by'} ${client.name}${signerTitle ? `, ${signerTitle}` : ''}` : ''} — ${client.email}
    </div>
    <h2>${t.scope}</h2>
    <p>${t.services}</p>
    <h2>${t.terms}</h2>
    <ul>${lang === 'pt' ? termsPt : termsEn}</ul>
    <h2>${t.pay}</h2>
    <p>${t.payText}</p>
    <h2>${t.sign}</h2>
    <div class="sigline">
      <p class="siglabel">${t.clientLbl}: ${client.name}${signerTitle ? ` — ${signerTitle}` : ''}</p>
      <p>/sig1/ &nbsp;&nbsp;&nbsp; /date1/</p>
    </div>
    <div class="sigline">
      <p class="siglabel">${t.contractor}: David Lazzarotto — Peace on Tax Corp</p>
      <p>/sig2/ &nbsp;&nbsp;&nbsp; /date2/</p>
    </div>
  </body></html>`
}
