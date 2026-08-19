// lib/wa.ts — camada WhatsApp (Twilio) do Peace on Tax
// Sem dependência do SDK da Twilio: usa fetch e crypto do Node.

import crypto from 'crypto'

export const CANAL = 'whatsapp' as const
export const JANELA_HORAS = 24

// ── Telefone ────────────────────────────────────────────────
export function soDigitos(v: string | null | undefined): string {
  return (v || '').replace(/\D/g, '')
}

/** Converte qualquer formato para E.164. Assume +1 quando vierem 10 dígitos. */
export function normalizarTelefone(bruto: string | null | undefined): string | null {
  const d = soDigitos(bruto)
  if (!d) return null
  if (d.length === 10) return `+1${d}`
  if (d.length === 11 && d.startsWith('1')) return `+${d}`
  if (d.length >= 11 && d.length <= 15) return `+${d}`
  return null
}

export function paraWhatsApp(e164: string): string {
  return e164.startsWith('whatsapp:') ? e164 : `whatsapp:${e164}`
}

export function deWhatsApp(v: string): string {
  return (v || '').replace(/^whatsapp:/, '')
}

/** Telefone bonito para a equipe ler: +1 (617) 899-9461 */
export function formatarTelefone(e164: string | null | undefined): string {
  const d = soDigitos(e164)
  if (d.length === 11 && d.startsWith('1')) {
    return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`
  }
  return e164 || ''
}

// ── Janela de 24 horas ──────────────────────────────────────
export function janelaAberta(ultimaDoCliente: string | null | undefined): boolean {
  if (!ultimaDoCliente) return false
  const limite = new Date(ultimaDoCliente).getTime() + JANELA_HORAS * 3600_000
  return Date.now() < limite
}

/** Minutos restantes da janela. Zero quando fechada. */
export function minutosDeJanela(ultimaDoCliente: string | null | undefined): number {
  if (!ultimaDoCliente) return 0
  const limite = new Date(ultimaDoCliente).getTime() + JANELA_HORAS * 3600_000
  return Math.max(0, Math.round((limite - Date.now()) / 60000))
}

// ── Assinatura do webhook ───────────────────────────────────
/**
 * Confere o cabeçalho X-Twilio-Signature.
 * Sem isso, qualquer pessoa na internet consegue inserir mensagens
 * falsas na conversa de um cliente — inclusive fazendo o bot responder.
 */
export function validarAssinaturaTwilio(
  url: string,
  params: Record<string, string>,
  assinatura: string | null,
  authToken: string
): boolean {
  if (!assinatura || !authToken) return false
  const dados = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url)
  const esperado = crypto.createHmac('sha1', authToken).update(Buffer.from(dados, 'utf-8')).digest('base64')
  const a = Buffer.from(esperado)
  const b = Buffer.from(assinatura)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** URL exata que a Twilio chamou — a assinatura é calculada sobre ela. */
export function urlDoWebhook(req: Request, caminhoPadrao: string): string {
  const fixa = process.env.TWILIO_WEBHOOK_BASE_URL
  if (fixa) return `${fixa.replace(/\/$/, '')}${caminhoPadrao}`
  const u = new URL(req.url)
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || u.host
  return `${proto}://${host}${u.pathname}${u.search}`
}

// ── Envio ───────────────────────────────────────────────────
export type ResultadoEnvio = {
  ok: boolean
  sid?: string
  status?: string
  erro?: string
  codigo?: number
}

type OpcoesEnvio = {
  para: string                       // E.164 do cliente
  corpo?: string                     // texto livre (só dentro da janela)
  contentSid?: string                // template aprovado (fora da janela)
  variaveis?: Record<string, string> // variáveis do template
}

/**
 * Envia pelo número de WhatsApp da firma.
 * A mensagem NUNCA leva o nome de quem escreveu: o cliente vê o
 * perfil comercial "Peace on Tax". A autoria fica só no banco.
 */
export async function enviarWhatsApp(op: OpcoesEnvio): Promise<ResultadoEnvio> {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const de = process.env.TWILIO_WHATSAPP_FROM // ex.: whatsapp:+16178999461

  if (!sid || !token || !de) {
    return { ok: false, erro: 'Twilio não configurado (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM).' }
  }
  const destino = normalizarTelefone(op.para)
  if (!destino) return { ok: false, erro: `Telefone inválido: ${op.para}` }

  const corpoForm = new URLSearchParams()
  corpoForm.set('From', paraWhatsApp(de))
  corpoForm.set('To', paraWhatsApp(destino))

  if (op.contentSid) {
    corpoForm.set('ContentSid', op.contentSid)
    if (op.variaveis) corpoForm.set('ContentVariables', JSON.stringify(op.variaveis))
  } else {
    corpoForm.set('Body', op.corpo || '')
  }

  const base = process.env.TWILIO_WEBHOOK_BASE_URL || process.env.NEXT_PUBLIC_APP_URL
  if (base) corpoForm.set('StatusCallback', `${base.replace(/\/$/, '')}/api/whatsapp/status`)

  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: corpoForm.toString(),
    })
    const j = await r.json()
    if (!r.ok) {
      return { ok: false, erro: j?.message || `Twilio devolveu ${r.status}`, codigo: j?.code }
    }
    return { ok: true, sid: j.sid, status: j.status }
  } catch (e: any) {
    return { ok: false, erro: e?.message || 'Falha de rede ao falar com a Twilio' }
  }
}
