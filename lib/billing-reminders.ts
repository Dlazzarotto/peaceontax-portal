// lib/billing-reminders.ts — aviso de cobrança N dias antes do débito automático.
//
// Regra (especificação 4.5 / 8): o cliente é avisado três dias antes de cada
// débito de plano ativo — mensalidade (bookkeeping ou outro serviço) e parcela
// de parcelamento. O aviso protege a firma numa contestação (seção 6): fica
// registrado em plan_audit o que foi avisado, quando e por qual canal.
//
// Canal: SMS pela lib/sms.ts (que só envia com consentimento). Sem SMS
// possível, e-mail pelo Resend e aviso no portal, os dois por lib/avisos.ts —
// assim o remetente, o rodapé com a marca e o tratamento de erro do envio são
// os mesmos de todo aviso que sai da firma.
// Idempotente: a chave aviso{N}d:{plano}:{data} em sms_sent_marker impede
// repetir — o cron pode rodar mais de uma vez no dia sem duplicar.

import { serviceDb } from '@/lib/api-auth'
import { enviarSms } from '@/lib/sms'
import { nextBillingDayET, proximaParcela, dataISOEmDias } from '@/lib/plans'
import { enviarEmail, avisarNoPortal, emailComMarca } from '@/lib/avisos'
import { FIRM } from '@/lib/contract-html'
import { fmtUS } from '@/lib/format'

export type Candidato = {
  planId: string; clientId: string; clientName: string; email: string | null; lang: string
  kind: string; data: string; valor: number; descricao: string
}

export type ResultadoAviso = Candidato & {
  canal: 'sms' | 'email' | 'portal' | 'pulado'
  detalhe?: string
}

function textoAviso(c: Candidato, dias: number): { sms: string; assunto: string; html: string } {
  const valor = `$${c.valor.toFixed(2)}`
  const data = fmtUS(c.data)
  const lang = (c.lang || 'en').toLowerCase()
  let sms: string, assunto: string
  if (lang === 'pt') {
    sms = `Lembrete: em ${dias} dias (${data}) será debitado ${valor} referente a ${c.descricao}, no método de pagamento cadastrado. Dúvidas: ${FIRM.phone}.`
    assunto = `Lembrete de cobrança — ${data}`
  } else if (lang === 'es') {
    sms = `Recordatorio: en ${dias} días (${data}) se debitará ${valor} por ${c.descricao} del método de pago registrado. Dudas: ${FIRM.phone}.`
    assunto = `Recordatorio de cobro — ${data}`
  } else {
    sms = `Reminder: in ${dias} days (${data}) ${valor} will be charged for ${c.descricao} to your payment method on file. Questions: ${FIRM.phone}.`
    assunto = `Upcoming charge reminder — ${data}`
  }
  // Saudação e rodapé com a marca vêm de emailComMarca: mudou o endereço ou o
  // telefone da firma num lugar, muda em todo aviso.
  const html = emailComMarca({ lang, nome: c.clientName, corpoHtml: `<p>${sms}</p>` })
  return { sms, assunto, html }
}


/**
 * Encontra os planos ativos cujo próximo débito cai exatamente em `alvo`.
 * Regras de data são as mesmas do checkout e do cronograma (lib/plans.ts).
 */
export async function candidatosDoDia(db: any, alvo: string, agora: Date): Promise<Candidato[]> {
  const { data: planos, error } = await db.from('payment_plans')
    .select('id, client_id, kind, status, description, monthly_amount, due_day, invoice_id, ' +
            'installment_amount, installments, paid_installments, frequency, next_charge_date, ' +
            'clients(id, name, business_name, email, language)')
    .eq('status', 'active')
  if (error) throw new Error(`payment_plans: ${error.message}`)

  const out: Candidato[] = []
  for (const p of planos || []) {
    const cli = (p as any).clients || {}
    const base = {
      planId: p.id, clientId: p.client_id, clientName: cli.name || cli.business_name || '',
      email: cli.email || null, lang: cli.language || 'en', kind: p.kind,
    }

    if (p.kind === 'installment') {
      if (p.invoice_id) {
        // Parcelamento nascido de fatura: o cronograma é a fonte
        const { data: parcelas } = await db.from('invoice_installments')
          .select('seq, due_date, amount, status')
          .eq('invoice_id', p.invoice_id).eq('due_date', alvo).neq('status', 'paid')
        for (const par of parcelas || []) {
          out.push({ ...base, data: alvo, valor: Number(par.amount || 0),
            descricao: `parcela ${par.seq}/${p.installments}` })
        }
      } else if (proximaParcela(p) === alvo) {
        out.push({ ...base, data: alvo, valor: Number(p.installment_amount || 0),
          descricao: `parcela ${Number(p.paid_installments || 0) + 1}/${p.installments}` })
      }
      continue
    }

    // Mensalidade (bookkeeping ou outro serviço): dia acordado, mesma regra do Stripe
    const prox = nextBillingDayET(p.due_day, agora).toISOString().slice(0, 10)
    if (prox === alvo) {
      out.push({ ...base, data: alvo, valor: Number(p.monthly_amount || 0),
        descricao: p.description || (p.kind === 'bookkeeping' ? 'bookkeeping mensal' : 'serviço mensal') })
    }
  }
  return out
}

/**
 * Roda o aviso do dia. `dry` só lista quem seria avisado.
 * Devolve o que aconteceu com cada candidato — o cron grava no log da Vercel.
 */
export async function executarAvisosDeCobranca(opts: { diasAntes?: number; dry?: boolean; agora?: Date } = {}) {
  const dias = opts.diasAntes ?? 3
  const agora = opts.agora ?? new Date()
  const alvo = dataISOEmDias(dias, agora)
  const db = serviceDb()

  const candidatos = await candidatosDoDia(db, alvo, agora)
  const resultados: ResultadoAviso[] = []

  for (const c of candidatos) {
    const chave = `aviso${dias}d:${c.planId}:${c.data}`

    // Já avisado hoje (por qualquer canal)? Então não repete.
    const { data: ja } = await db.from('sms_sent_marker').select('chave').eq('chave', chave).maybeSingle()
    if (ja) { resultados.push({ ...c, canal: 'pulado', detalhe: 'já avisado' }); continue }
    if (opts.dry) { resultados.push({ ...c, canal: 'pulado', detalhe: 'simulação' }); continue }

    const txt = textoAviso(c, dias)
    let canal: ResultadoAviso['canal'] = 'portal'
    let detalhe: string | undefined

    // 1. SMS — a lib recusa sem consentimento, STOP ou celular inválido
    const sms = await enviarSms({ clientId: c.clientId, body: txt.sms, kind: 'billing_reminder', planId: c.planId, chaveUnica: chave })
    if (sms.ok) canal = 'sms'
    else {
      detalhe = sms.motivo
      // 2. E-mail
      if (c.email && await enviarEmail(c.email, txt.assunto, txt.html)) canal = 'email'
      // Marca a chave à mão: enviarSms só marca quando envia
      await db.from('sms_sent_marker').insert({ chave, client_id: c.clientId }).then(() => null, () => null)
    }

    // 3. Portal — sempre, é o registro que o cliente vê ao entrar
    await avisarNoPortal(db, c.clientId, `🔔 ${txt.sms}`)

    // 4. Trilha: o que foi avisado, quando e por onde
    await db.from('plan_audit').insert({
      plan_id: c.planId, action: 'reminder_sent',
      snapshot: { canal, data: c.data, valor: c.valor, descricao: c.descricao, diasAntes: dias, motivoSemSms: detalhe || null },
    }).then(() => null, () => null)

    resultados.push({ ...c, canal, detalhe })
  }

  return { alvo, diasAntes: dias, total: candidatos.length, resultados }
}
