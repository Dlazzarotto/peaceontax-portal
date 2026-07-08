// POST /api/signatures/contract — envia o CONTRATO de um plano via DocuSign
// Body: { planId, signerTitle? }   (title obrigatório se cliente business)
// SÓ manager/owner. O contrato é gerado em HTML com os termos do plano.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { sendEnvelope } from '@/lib/docusign'
import { FREQ_LABEL, type Frequency } from '@/lib/plans'

const FIRM = {
  name: 'Peace on Tax Corp',
  address: '75 Pleasant St Suite 119, Malden, MA 02148',
  phone: '(833) 732-2327', email: 'info@peaceontax.com',
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return NextResponse.json({ error: 'Somente manager/owner enviam contratos' }, { status: 403 })
  }

  const { planId, signerTitle } = await req.json()
  if (!planId) return NextResponse.json({ error: 'planId obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: plan } = await db
    .from('payment_plans')
    .select('*, clients(id, name, email, business_name, type, language)')
    .eq('id', planId)
    .single()

  if (!plan) return NextResponse.json({ error: 'Plano não encontrado' }, { status: 404 })
  const client = plan.clients as any
  if (!client?.email || !client.email.includes('@')) {
    return NextResponse.json({ error: 'Cliente sem e-mail válido — corrija no Profile antes de enviar' }, { status: 400 })
  }
  if (client.type === 'business' && !signerTitle?.trim()) {
    return NextResponse.json({ error: 'Cliente business: informe o cargo do assinante (ex.: President, Member)' }, { status: 400 })
  }

  // Já existe contrato ativo para este plano?
  const { data: existing } = await db.from('signature_requests')
    .select('id, status').eq('plan_id', planId)
    .in('status', ['sent','delivered','completed']).maybeSingle()
  if (existing) {
    return NextResponse.json({ error: `Já existe contrato ${existing.status === 'completed' ? 'assinado' : 'enviado'} para este plano` }, { status: 409 })
  }

  const lang = client.language === 'pt' ? 'pt' : 'en'
  const isInstallment = plan.kind === 'installment'
  const money = (n: number) => `$${Number(n).toFixed(2)}`

  const includedTx = (plan as any).included_transactions
  const overageRate = Number((plan as any).overage_rate ?? 1.25).toFixed(2)
  const termsPt = isInstallment
    ? `<li>Valor total dos serviços: <b>${money(plan.total)}</b></li>
       <li>Entrada: <b>${money(plan.entry_amount)} (${plan.entry_pct}%)</b>, paga no ato da contratação.</li>
       <li>Saldo em <b>${plan.installments} parcela(s) de ${money(plan.installment_amount)}</b>, frequência ${FREQ_LABEL[plan.frequency as Frequency]?.toLowerCase()}, com início 1 período após a entrada, por débito automático autorizado (cartão ou conta bancária ACH).</li>
       <li>O CONTRATANTE reconhece que os serviços descritos foram/estão sendo prestados e que as parcelas são devidas integralmente, não sendo suspensas por qualquer motivo.</li>
       <li><b>Entrega:</b> o serviço somente será finalizado e entregue após a quitação de, no mínimo, <b>75% (setenta e cinco por cento)</b> do valor total contratado.</li>`
    : `<li><b>Escopo:</b> serviços mensais de bookkeeping (escrituração contábil) com geração do demonstrativo de resultados (P&L): <b>${money(plan.monthly_amount)}/mês</b>.</li>
       <li><b>Transações incluídas:</b> até <b>${includedTx ?? '—'} transações por mês</b>. Transações excedentes serão cobradas à parte, ao valor de <b>$${overageRate} por transação</b>.</li>
       <li><b>Serviços NÃO incluídos</b> (cobrados à parte mediante orçamento): declaração de imposto de renda da empresa e de seus sócios, Meal Tax, Sales Tax, folha de pagamento, e quaisquer outros serviços fora do escopo de bookkeeping.</li>
       <li>Cobrança por débito automático autorizado, <b>todo dia 5 de cada mês</b>.</li>
       <li>Vigência por prazo indeterminado, podendo ser encerrado por qualquer parte com aviso de 30 dias.</li>`

  const termsEn = isInstallment
    ? `<li>Total service amount: <b>${money(plan.total)}</b></li>
       <li>Down payment: <b>${money(plan.entry_amount)} (${plan.entry_pct}%)</b>, due upon signing.</li>
       <li>Balance in <b>${plan.installments} installment(s) of ${money(plan.installment_amount)}</b> (${plan.frequency}), starting one period after the down payment, via authorized automatic debit (card or ACH bank account).</li>
       <li>CLIENT acknowledges the services described have been/are being rendered and installments are fully due and non-suspendable.</li>
       <li><b>Delivery:</b> the service will only be finalized and delivered after at least <b>75% (seventy-five percent)</b> of the total contract amount has been paid.</li>`
    : `<li><b>Scope:</b> monthly bookkeeping services including Profit & Loss (P&L) statement generation: <b>${money(plan.monthly_amount)}/month</b>.</li>
       <li><b>Included transactions:</b> up to <b>${includedTx ?? '—'} transactions per month</b>. Transactions above this limit are billed separately at <b>$${overageRate} per transaction</b>.</li>
       <li><b>Services NOT included</b> (billed separately upon quote): business and owners' income tax returns, Meal Tax, Sales Tax, payroll, and any other services outside the bookkeeping scope.</li>
       <li>Billed via authorized automatic debit on <b>the 5th of every month</b>.</li>
       <li>Open-ended term; either party may terminate with 30 days notice.</li>`

  const displayName = client.business_name || client.name
  const t = lang === 'pt'
    ? { title: 'CONTRATO DE PRESTAÇÃO DE SERVIÇOS', between: 'entre', and: 'e', services: isInstallment ? (plan.description || 'Serviços contábeis e fiscais') : 'Bookkeeping mensal', terms: 'TERMOS E CONDIÇÕES', pay: 'PAGAMENTO E AUTORIZAÇÃO DE DÉBITO', payText: 'O CONTRATANTE autoriza a Peace on Tax Corp a realizar as cobranças descritas acima por meio do método de pagamento cadastrado via Stripe, nos valores e datas pactuados.', sign: 'ASSINATURAS', contractor: 'CONTRATADA', clientLbl: 'CONTRATANTE' }
    : { title: 'SERVICE AGREEMENT', between: 'between', and: 'and', services: isInstallment ? (plan.description || 'Accounting and tax services') : 'Monthly bookkeeping', terms: 'TERMS AND CONDITIONS', pay: 'PAYMENT AND DEBIT AUTHORIZATION', payText: 'CLIENT authorizes Peace on Tax Corp to charge the payment method on file via Stripe for the amounts and dates agreed above.', sign: 'SIGNATURES', contractor: 'PROVIDER', clientLbl: 'CLIENT' }

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: Georgia, serif; font-size: 13px; color:#1a2a3a; margin: 40px 50px; line-height: 1.7; }
    h1 { font-size: 18px; color:#2D3278; text-align:center; }
    h2 { font-size: 14px; color:#2D3278; margin-top: 24px; }
    .parties { background:#f4f6fb; padding: 12px 16px; border-radius: 6px; }
    .sigline { margin-top: 40px; }
    .siglabel { font-size: 11px; color:#555; }
  </style></head><body>
    <h1>${t.title}</h1>
    <div class="parties">
      <b>${FIRM.name}</b> (${t.contractor}) — ${FIRM.address} — ${FIRM.phone} — ${FIRM.email}<br>
      ${t.between} ${t.and}<br>
      <b>${displayName}</b> (${t.clientLbl})${client.business_name ? ` — ${lang === 'pt' ? 'representada por' : 'represented by'} ${client.name}${signerTitle ? `, ${signerTitle}` : ''}` : ''} — ${client.email}
    </div>
    <h2>${lang === 'pt' ? 'OBJETO' : 'SCOPE'}</h2>
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

  try {
    const { envelopeId } = await sendEnvelope({
      doc: {
        name: lang === 'pt' ? 'Contrato-Peace-on-Tax.html' : 'Agreement-Peace-on-Tax.html',
        base64: Buffer.from(html, 'utf-8').toString('base64'),
        fileExtension: 'html',
      },
      signers: [
        { name: client.name, email: client.email, title: signerTitle || undefined },
        { name: 'David Lazzarotto', email: 'david@peaceontax.com' },
      ],
      emailSubject: lang === 'pt'
        ? `Contrato de serviços — ${FIRM.name}`
        : `Service agreement — ${FIRM.name}`,
      emailBody: lang === 'pt'
        ? 'Por favor, revise e assine o contrato. Qualquer dúvida: (833) 732-2327.'
        : 'Please review and sign the agreement. Questions: (833) 732-2327.',
      anchorMode: true,
    })

    const { data: sig } = await db.from('signature_requests').insert({
      client_id: client.id, plan_id: planId, kind: 'contract',
      envelope_id: envelopeId,
      signers: [{ name: client.name, email: client.email, title: signerTitle || null }, { name: 'David Lazzarotto', email: 'david@peaceontax.com' }],
      created_by: auth.userId,
    }).select('id').single()

    await db.from('plan_audit').insert({
      plan_id: planId, action: 'contract_sent', performed_by: auth.userId,
      snapshot: { envelopeId, signatureRequestId: sig?.id },
    })

    return NextResponse.json({ ok: true, envelopeId })
  } catch (e) {
    console.error('Contract send error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
