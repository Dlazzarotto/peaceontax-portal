// POST /api/sms/webhook — SMS recebido no número da firma (Twilio)
//
// Quem chama: a Twilio (rota pública no middleware; a trava é a assinatura
// X-Twilio-Signature, conferida abaixo — sem ela qualquer um "cancelaria"
// o consentimento de um cliente ou inseriria mensagem falsa).
//
// O que faz:
//   STOP / PARAR / CANCELAR…  → grava opt-out em sms_consent_log e marca
//                               sms_opted_out_at; lib/sms.ts passa a recusar envios.
//   START / UNSTOP / YES      → reativa SÓ se já houve um opt-in registrado antes.
//                               Um START de quem nunca autorizou não cria consentimento.
//   HELP                      → só registra (a Twilio responde a ajuda).
//   Qualquer outro texto      → registra em sms_messages e entra na fila do
//                               Atendimento (canal 'sms') para a equipe responder.
//
// Nunca devolve erro à Twilio: ela reenvia e a mensagem duplica. Falha vai
// para o log do Vercel. Dedupe por MessageSid.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { serviceDb } from '@/lib/api-auth'
import { normalizarTelefone, registrarConsentimento } from '@/lib/sms'
import { validarAssinaturaTwilio, urlDoWebhook } from '@/lib/wa'

const VAZIO = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
const xml = (status = 200) => new Response(VAZIO, { status, headers: { 'Content-Type': 'text/xml' } })

// Palavras-chave. As inglesas são as que a Twilio reconhece; as em português
// entram por proteção — recusar envio a quem pediu para parar nunca é erro.
const OPT_OUT = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'PARAR', 'PARE', 'CANCELAR', 'SAIR'])
const OPT_IN  = new Set(['START', 'UNSTOP', 'YES', 'SIM', 'VOLTAR'])
const HELP    = new Set(['HELP', 'INFO', 'AJUDA', 'AYUDA'])

type Tipo = 'opt_out' | 'opt_in' | 'help' | 'texto'

function classificar(corpo: string, optOutType: string | undefined): Tipo {
  // A Twilio (Advanced Opt-Out ligado) já diz o que reconheceu
  const t = (optOutType || '').toUpperCase()
  if (t === 'STOP') return 'opt_out'
  if (t === 'START') return 'opt_in'
  if (t === 'HELP') return 'help'
  // Senão, primeira palavra da mensagem, sem pontuação
  const palavra = corpo.trim().split(/\s+/)[0]?.replace(/[^A-Za-zÀ-ú]/g, '').toUpperCase() || ''
  if (OPT_OUT.has(palavra)) return 'opt_out'
  if (OPT_IN.has(palavra)) return 'opt_in'
  if (HELP.has(palavra)) return 'help'
  return 'texto'
}

/** Cliente pelo telefone: função do banco (sms_phone, depois phone); sem ela, só o E.164 exato. */
async function clientePorTelefone(db: any, telefone: string): Promise<string | null> {
  const { data, error } = await db.rpc('sms_client_por_telefone', { p: telefone })
  if (!error && data) return String(data)
  const { data: c } = await db.from('clients').select('id').eq('sms_phone', telefone).maybeSingle()
  return c?.id || null
}

export async function POST(req: Request) {
  const bruto = await req.text()
  const params: Record<string, string> = {}
  new URLSearchParams(bruto).forEach((v, k) => { params[k] = v })

  // 1. Assinatura
  const authToken = process.env.TWILIO_AUTH_TOKEN || ''
  const url = urlDoWebhook(req, '/api/sms/webhook')
  if (!validarAssinaturaTwilio(url, params, req.headers.get('x-twilio-signature'), authToken)) {
    console.error('[sms/webhook] assinatura inválida. URL usada no cálculo:', url)
    return xml(403)
  }

  // WhatsApp tem o próprio webhook; aqui só SMS
  if ((params.From || '').startsWith('whatsapp:')) return xml()

  const telefone = normalizarTelefone(params.From)
  const sid = params.MessageSid || params.SmsMessageSid || null
  const corpo = (params.Body || '').trim()
  if (!telefone) { console.error('[sms/webhook] remetente inválido:', params.From); return xml() }

  const db = serviceDb()
  try {
    // 2. Já processada?
    if (sid) {
      const { data: ja } = await db.from('sms_messages').select('id').eq('twilio_sid', sid).maybeSingle()
      if (ja) return xml()
    }

    const tipo = classificar(corpo, params.OptOutType)
    const clientId = await clientePorTelefone(db, telefone)

    // 3. Trilha: toda mensagem recebida fica em sms_messages
    const { error: erroMsg } = await db.from('sms_messages').insert({
      client_id: clientId, direction: 'inbound', phone: telefone, body: corpo,
      kind: tipo === 'texto' ? 'inbound' : `keyword_${tipo}`,
      status: 'received', twilio_sid: sid,
    })
    if (erroMsg) console.error('[sms/webhook] sms_messages:', erroMsg.message)

    // 4. Consentimento
    if (tipo === 'opt_out' && clientId) {
      const r = await registrarConsentimento({
        clientId, phone: telefone, action: 'opt_out', source: 'sms_keyword',
        consentText: `Cliente respondeu "${corpo.slice(0, 80)}" por SMS`,
      })
      if (!r.ok) console.error('[sms/webhook] opt-out não gravado:', r.motivo)
    }

    if (tipo === 'opt_in' && clientId) {
      // Só reativa quem já tinha autorizado antes — START sozinho não é consentimento
      const { data: anterior } = await db.from('sms_consent_log')
        .select('id, created_at').eq('client_id', clientId).eq('action', 'opt_in')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (anterior) {
        const r = await registrarConsentimento({
          clientId, phone: telefone, action: 'opt_in', source: 'sms_keyword',
          consentText: `Cliente respondeu "${corpo.slice(0, 80)}" por SMS, reativando a autorização registrada em ${String(anterior.created_at).slice(0, 10)}`,
        })
        if (!r.ok) console.error('[sms/webhook] reativação não gravada:', r.motivo)
      } else {
        console.warn('[sms/webhook] START sem opt-in anterior — ignorado:', telefone)
      }
    }

    // 5. Texto comum vai para a fila do Atendimento (canal 'sms'), sem bot
    if (tipo === 'texto' && corpo) await encaminharParaAtendimento(db, telefone, clientId, corpo, sid)
  } catch (e: any) {
    console.error('[sms/webhook] falha:', e?.message || e)
  }

  return xml()
}

async function encaminharParaAtendimento(db: any, telefone: string, clientId: string | null, corpo: string, sid: string | null) {
  try {
    let { data: conversa } = await db.from('wa_conversations')
      .select('id, client_id, status').eq('phone', telefone).eq('canal', 'sms').maybeSingle()
    if (!conversa) {
      const { data: nova, error } = await db.from('wa_conversations')
        .insert({ phone: telefone, canal: 'sms', client_id: clientId, status: 'fila' })
        .select('id, client_id, status').single()
      if (error) throw error
      conversa = nova
    } else if (conversa.status === 'resolvida' || conversa.status === 'bot') {
      // SMS não passa pelo bot: reabre direto na fila humana
      await db.from('wa_conversations').update({ status: 'fila', resolvida_em: null, atendente_id: null }).eq('id', conversa.id)
    }
    await db.from('wa_messages').insert({
      conversation_id: conversa.id, client_id: conversa.client_id || clientId, canal: 'sms',
      direction: 'inbound', autor: 'cliente', body: corpo, twilio_sid: sid, status: 'received',
    })
  } catch (e: any) {
    // Tabelas do Atendimento ausentes ou fora do padrão: a mensagem já está em sms_messages
    console.error('[sms/webhook] atendimento:', e?.message || e)
  }
}
