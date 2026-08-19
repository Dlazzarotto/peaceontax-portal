// app/api/whatsapp/status/route.ts — recibos de entrega da Twilio
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { admin } from '@/lib/wa-auth'
import { validarAssinaturaTwilio, urlDoWebhook } from '@/lib/wa'

export async function POST(req: Request) {
  const bruto = await req.text()
  const params: Record<string, string> = {}
  new URLSearchParams(bruto).forEach((v, k) => { params[k] = v })

  const url = urlDoWebhook(req, '/api/whatsapp/status')
  if (!validarAssinaturaTwilio(url, params, req.headers.get('x-twilio-signature'), process.env.TWILIO_AUTH_TOKEN || '')) {
    console.error('[wa/status] assinatura inválida. URL usada:', url)
    return new Response('', { status: 403 })
  }

  const sid = params.MessageSid || params.SmsSid
  const status = params.MessageStatus || params.SmsStatus
  if (sid && status) {
    const erro = params.ErrorCode
      ? `Twilio ${params.ErrorCode}${params.ErrorMessage ? ': ' + params.ErrorMessage : ''}`
      : null
    await admin().from('wa_messages').update({ status, error_text: erro }).eq('twilio_sid', sid)
  }
  return new Response('', { status: 204 })
}
