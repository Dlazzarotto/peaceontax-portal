// lib/sms.ts — envio de SMS pela Twilio, com consentimento obrigatório.
//
// A regra que sustenta tudo: NADA sai sem consentimento registrado.
// A verificação é aqui, não em cada tela — assim nenhum fluxo novo
// consegue burlar por esquecimento.
//
// Requer no ambiente:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID

import { createClient } from '@supabase/supabase-js'

const API = 'https://api.twilio.com/2010-04-01'

function db() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY
  if (!key) throw new Error('Service key não configurada')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key)
}

/** Formato E.164 exigido pela Twilio: +1XXXXXXXXXX */
export function normalizarTelefone(bruto: string | null | undefined): string | null {
  if (!bruto) return null
  const so = String(bruto).replace(/\D/g, '')
  if (so.length === 10) return `+1${so}`
  if (so.length === 11 && so.startsWith('1')) return `+${so}`
  if (so.length > 11) return `+${so}`          // internacional já com país
  return null
}

export interface ResultadoSms {
  ok: boolean
  sid?: string
  motivo?: string
}

/**
 * Envia um SMS. Recusa quando:
 *   - o cliente não autorizou
 *   - o cliente pediu STOP
 *   - o telefone é inválido
 *   - as credenciais não estão configuradas
 */
export async function enviarSms(params: {
  clientId: string
  body: string
  kind?: string
  invoiceId?: string
  planId?: string
  sentBy?: string
  /** Chave de idempotência: se já houver marca igual, não reenvia. */
  chaveUnica?: string
}): Promise<ResultadoSms> {
  const sb = db()

  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const servico = process.env.TWILIO_MESSAGING_SERVICE_SID
  if (!sid || !token || !servico) {
    return { ok: false, motivo: 'Credenciais da Twilio não configuradas no ambiente.' }
  }

  // Idempotência: o mesmo aviso não sai duas vezes
  if (params.chaveUnica) {
    const { data: jaFoi } = await sb.from('sms_sent_marker')
      .select('chave').eq('chave', params.chaveUnica).maybeSingle()
    if (jaFoi) return { ok: false, motivo: 'Este aviso já foi enviado.' }
  }

  const { data: cli } = await sb.from('clients')
    .select('id, name, business_name, phone, sms_phone, sms_consent, sms_opted_out_at')
    .eq('id', params.clientId).maybeSingle()
  if (!cli) return { ok: false, motivo: 'Cliente não encontrado.' }

  // ── As três travas de consentimento ──
  if (!cli.sms_consent) {
    return { ok: false, motivo: 'Cliente não autorizou receber mensagens de texto.' }
  }
  if (cli.sms_opted_out_at) {
    return { ok: false, motivo: 'Cliente pediu para não receber mensagens (STOP).' }
  }
  const telefone = normalizarTelefone(cli.sms_phone || cli.phone)
  if (!telefone) {
    return { ok: false, motivo: 'Cliente sem celular válido cadastrado.' }
  }

  // Toda mensagem carrega a identificação e a saída
  let corpo = params.body.trim()
  if (!/STOP/i.test(corpo)) corpo = `${corpo} Reply STOP to opt out.`
  if (!/Peace on Tax/i.test(corpo)) corpo = `Peace on Tax: ${corpo}`

  const { data: registro } = await sb.from('sms_messages').insert({
    client_id: cli.id, direction: 'outbound', phone: telefone, body: corpo,
    kind: params.kind || null, status: 'queued',
    invoice_id: params.invoiceId || null, plan_id: params.planId || null,
    sent_by: params.sentBy || null,
  }).select('id').single()

  try {
    const resp = await fetch(`${API}/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: telefone,
        MessagingServiceSid: servico,
        Body: corpo,
      }).toString(),
    })

    const bruto = await resp.text()
    let dados: any
    try { dados = JSON.parse(bruto) } catch { dados = {} }

    if (!resp.ok) {
      const msg = dados?.message || `Twilio respondeu ${resp.status}`
      await sb.from('sms_messages').update({
        status: 'failed', error_code: String(dados?.code || resp.status), error_text: msg,
        updated_at: new Date().toISOString(),
      }).eq('id', registro?.id)
      return { ok: false, motivo: msg }
    }

    await sb.from('sms_messages').update({
      twilio_sid: dados.sid, status: dados.status || 'sent',
      updated_at: new Date().toISOString(),
    }).eq('id', registro?.id)

    if (params.chaveUnica) {
      await sb.from('sms_sent_marker')
        .insert({ chave: params.chaveUnica, client_id: cli.id })
        .then(() => null, () => null)
    }

    return { ok: true, sid: dados.sid }
  } catch (e) {
    const msg = (e as Error).message
    await sb.from('sms_messages').update({
      status: 'failed', error_text: msg, updated_at: new Date().toISOString(),
    }).eq('id', registro?.id)
    return { ok: false, motivo: msg }
  }
}

/** Registra consentimento com a trilha de auditoria completa. */
export async function registrarConsentimento(params: {
  clientId: string
  phone: string
  action: 'opt_in' | 'opt_out'
  source: 'portal' | 'staff' | 'sms_keyword'
  consentText?: string
  ip?: string
  userAgent?: string
  performedBy?: string
}): Promise<{ ok: boolean; motivo?: string }> {
  const sb = db()
  const telefone = normalizarTelefone(params.phone)
  if (!telefone) return { ok: false, motivo: 'Telefone inválido.' }

  await sb.from('sms_consent_log').insert({
    client_id: params.clientId, phone: telefone, action: params.action,
    source: params.source, consent_text: params.consentText || null,
    ip: params.ip || null, user_agent: params.userAgent || null,
    performed_by: params.performedBy || null,
  })

  const agora = new Date().toISOString()
  const { error } = await sb.from('clients').update(
    params.action === 'opt_in'
      ? { sms_phone: telefone, sms_consent: true, sms_consent_at: agora,
          sms_consent_ip: params.ip || null, sms_consent_source: params.source,
          sms_opted_out_at: null }
      : { sms_consent: false, sms_opted_out_at: agora }
  ).eq('id', params.clientId)

  if (error) return { ok: false, motivo: error.message }
  return { ok: true }
}
