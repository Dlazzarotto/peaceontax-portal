// lib/aviso-da-fatura.ts — o aviso ao cliente quando a fatura (ou o
// orçamento) chega a ele: no portal e por e-mail, com a marca.
//
// Saiu de /api/billing/invoices porque a rotina diária dos contratos
// (/api/cron/contratos) emite fatura e precisa do MESMO aviso — duas cópias
// do texto divergiriam no primeiro ajuste. Não derruba quem chama se o
// e-mail falhar: devolve o motivo, que vai para a trilha e para a tela.

import { enviarEmail, avisarNoPortal, emailComMarca, APP_URL } from '@/lib/avisos'
import { fmtUS, money } from '@/lib/format'
import { dataDaFirma } from '@/lib/dia-da-firma'

/** E-mail e aviso no portal quando a fatura é enviada. Não derruba a operação se o e-mail falhar. */
export async function avisarClienteDaFatura(
  db: any, inv: any, tom: 'envio' | 'lembrete' = 'envio',
): Promise<{ email: boolean; motivo?: string }> {
  const { data: c } = await db.from('clients').select('id, name, email, language').eq('id', inv.client_id).maybeSingle()
  if (!c) return { email: false, motivo: 'cliente não encontrado' }
  const lang = (c.language || 'en').toLowerCase()
  const valor = money(Math.round((Number(inv.total) - Number(inv.paid_total || 0)) * 100) / 100)
  const venc = fmtUS(inv.due_date)
  const parcelada = inv.payment_plan === 'installments'
  // Vencida? Comparação por data civil do ESCRITÓRIO: em UTC, às 20h de
  // Malden a fatura que vence hoje já saía "venceu" no lembrete.
  const hoje = dataDaFirma()
  const vencida = !!inv.due_date && String(inv.due_date).slice(0, 10) < hoje

  // Envio e cobrança não dizem a mesma coisa. Quem pede o documento de novo
  // não é quem está atrasado, e o cliente percebe a diferença.
  const T: Record<string, { texto: string; assunto: string; botao: string }> = {
    pt: {
      texto: tom === 'lembrete'
        ? (parcelada
            ? `⏰ Lembrete: a fatura ${inv.number} está parcelada e o débito automático não foi concluído. Em Pagamentos você regulariza ou refaz o cadastro do débito.`
            : `⏰ Lembrete: a fatura ${inv.number} de ${valor}${venc ? (vencida ? ` venceu em ${venc}` : ` vence em ${venc}`) : ''}. Em Pagamentos você paga com cartão, débito em conta ou Klarna.`)
        : (parcelada
            ? `🧾 Fatura ${inv.number} (${valor}) enviada. Ela é parcelada: em Pagamentos, cadastre o débito automático.`
            : `🧾 Fatura ${inv.number} de ${valor}${venc ? `, vencimento ${venc}` : ''}. Em Pagamentos você paga com cartão, débito em conta ou Klarna.`),
      assunto: tom === 'lembrete' ? `Lembrete: fatura ${inv.number} — Peace on Tax` : `Fatura ${inv.number} — Peace on Tax`,
      botao: tom === 'lembrete' ? 'Pagar agora' : (parcelada ? 'Cadastrar débito automático' : 'Ver e pagar a fatura'),
    },
    es: {
      texto: tom === 'lembrete'
        ? (parcelada
            ? `⏰ Recordatorio: la factura ${inv.number} está en cuotas y el débito automático no se completó. En Pagos puede regularizar o registrar el débito de nuevo.`
            : `⏰ Recordatorio: la factura ${inv.number} de ${valor}${venc ? (vencida ? ` venció el ${venc}` : ` vence el ${venc}`) : ''}. En Pagos puede pagar con tarjeta, débito en cuenta o Klarna.`)
        : (parcelada
            ? `🧾 Factura ${inv.number} (${valor}) enviada. Es en cuotas: en Pagos, registre el débito automático.`
            : `🧾 Factura ${inv.number} de ${valor}${venc ? `, vence el ${venc}` : ''}. En Pagos puede pagar con tarjeta, débito en cuenta o Klarna.`),
      assunto: tom === 'lembrete' ? `Recordatorio: factura ${inv.number} — Peace on Tax` : `Factura ${inv.number} — Peace on Tax`,
      botao: tom === 'lembrete' ? 'Pagar ahora' : (parcelada ? 'Registrar débito automático' : 'Ver y pagar la factura'),
    },
    en: {
      texto: tom === 'lembrete'
        ? (parcelada
            ? `⏰ Reminder: invoice ${inv.number} is on an installment plan and the automatic debit did not go through. Under Payments you can settle it or set up the debit again.`
            : `⏰ Reminder: invoice ${inv.number} for ${valor}${venc ? (vencida ? ` was due on ${venc}` : ` is due on ${venc}`) : ''}. Under Payments you can pay by card, bank debit (ACH) or Klarna.`)
        : (parcelada
            ? `🧾 Invoice ${inv.number} (${valor}) sent. It is an installment plan: under Payments, set up automatic debit.`
            : `🧾 Invoice ${inv.number} for ${valor}${venc ? `, due ${venc}` : ''}. Under Payments you can pay by card, bank debit (ACH) or Klarna.`),
      assunto: tom === 'lembrete' ? `Reminder: invoice ${inv.number} — Peace on Tax` : `Invoice ${inv.number} — Peace on Tax`,
      botao: tom === 'lembrete' ? 'Pay now' : (parcelada ? 'Set up automatic debit' : 'View and pay invoice'),
    },
  }
  // ORÇAMENTO não é cobrança. O texto da fatura ("Fatura EST-… — Ver e
  // pagar") ia para o orçamento também, e o botão levava a Pagamentos, que
  // só listava faturas: o cliente era chamado a pagar e não achava nada.
  // Agora o orçamento aparece em Pagamentos → Orçamentos, e o aviso diz isso.
  const TO: Record<string, { texto: string; assunto: string; botao: string }> = {
    pt: {
      texto: `📄 Orçamento ${inv.number} de ${valor}. Os itens estão em Pagamentos → Orçamentos. Para aprovar, responda este e-mail ou fale com a nossa equipe em Mensagens.`,
      assunto: `Orçamento ${inv.number} — Peace on Tax`,
      botao: 'Ver o orçamento',
    },
    es: {
      texto: `📄 Presupuesto ${inv.number} de ${valor}. Los detalles están en Pagos → Presupuestos. Para aprobarlo, responda este correo o escríbanos en Mensajes.`,
      assunto: `Presupuesto ${inv.number} — Peace on Tax`,
      botao: 'Ver el presupuesto',
    },
    en: {
      texto: `📄 Estimate ${inv.number} for ${valor}. The details are under Payments → Estimates. To approve it, reply to this e-mail or message us under Messages.`,
      assunto: `Estimate ${inv.number} — Peace on Tax`,
      botao: 'View estimate',
    },
  }
  const t = inv.doc_type === 'estimate' ? (TO[lang] || TO.en) : (T[lang] || T.en)
  // O portal e o canal que SEMPRE deveria funcionar: se ele falhar tambem, o
  // cliente nao fica sabendo por nenhum caminho, e quem enviou precisa saber.
  const noPortal = await avisarNoPortal(db, c.id, t.texto)

  // O motivo vem de enviarEmail e e ESPECIFICO: falta de chave no servidor,
  // cadastro sem e-mail, ou a recusa do Resend com o texto dele. "Falha no
  // envio" nao dizia se o sócio tinha de mexer no Vercel ou a equipe na ficha.
  const r = await enviarEmail(c.email, t.assunto,
    emailComMarca({ lang, nome: c.name, corpoHtml: `<p>${t.texto.replace(/^[🧾⏰📄] /u, '')}</p>`,
      botao: { texto: t.botao, url: `${APP_URL}/portal/payments` } }))
  return {
    email: r.ok,
    motivo: noPortal.ok ? r.motivo
      : `${r.motivo ? r.motivo + ' · ' : ''}e o aviso no portal também falhou: ${noPortal.motivo}`,
  }
}
