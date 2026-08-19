// app/api/whatsapp/webhook/route.ts — entrada das mensagens do cliente
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { admin } from '@/lib/wa-auth'
import { responderBot } from '@/lib/wa-bot'
import {
  deWhatsApp, normalizarTelefone, validarAssinaturaTwilio,
  urlDoWebhook, enviarWhatsApp,
} from '@/lib/wa'

const BUCKET = 'whatsapp-media'
const VAZIO = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

function xml(corpo = VAZIO, status = 200) {
  return new Response(corpo, { status, headers: { 'Content-Type': 'text/xml' } })
}

export async function POST(req: Request) {
  const bruto = await req.text()
  const params: Record<string, string> = {}
  new URLSearchParams(bruto).forEach((v, k) => { params[k] = v })

  // 1. Assinatura — sem isso qualquer um insere mensagem falsa
  const authToken = process.env.TWILIO_AUTH_TOKEN || ''
  const url = urlDoWebhook(req, '/api/whatsapp/webhook')
  const assinatura = req.headers.get('x-twilio-signature')
  if (!validarAssinaturaTwilio(url, params, assinatura, authToken)) {
    console.error('[wa/webhook] assinatura inválida. URL usada no cálculo:', url)
    return xml('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 403)
  }

  const db = admin()
  const canal = (params.From || '').startsWith('whatsapp:') ? 'whatsapp' : 'sms'
  const telefone = normalizarTelefone(deWhatsApp(params.From || ''))
  const sid = params.MessageSid || params.SmsMessageSid || null
  const corpo = params.Body || ''
  const nomePerfil = params.ProfileName || null

  if (!telefone) {
    console.error('[wa/webhook] remetente sem telefone válido:', params.From)
    return xml()
  }

  try {
    // 2. Já processada? (a Twilio reenvia quando não recebe 200)
    if (sid) {
      const { data: ja } = await db.from('wa_messages').select('id').eq('twilio_sid', sid).maybeSingle()
      if (ja) return xml()
    }

    // 3. Conversa (uma por telefone + canal)
    const { data: clienteId } = await db.rpc('wa_client_por_telefone', { p: telefone })

    let { data: conversa } = await db
      .from('wa_conversations')
      .select('*')
      .eq('phone', telefone)
      .eq('canal', canal)
      .maybeSingle()

    if (!conversa) {
      const { data: nova, error } = await db
        .from('wa_conversations')
        .insert({
          phone: telefone, canal, client_id: clienteId || null,
          nome_exibicao: nomePerfil, status: 'bot',
        })
        .select('*')
        .single()
      if (error) throw error
      conversa = nova
    } else {
      const patch: any = {}
      if (!conversa.client_id && clienteId) patch.client_id = clienteId
      if (!conversa.nome_exibicao && nomePerfil) patch.nome_exibicao = nomePerfil
      // Cliente voltou depois de resolvida: o bot atende de novo.
      if (conversa.status === 'resolvida') { patch.status = 'bot'; patch.resolvida_em = null; patch.atendente_id = null }
      if (Object.keys(patch).length) {
        const { data: at } = await db.from('wa_conversations').update(patch).eq('id', conversa.id).select('*').single()
        if (at) conversa = at
      }
    }

    // 4. Anexos — baixa para bucket privado (o link da Twilio expira)
    const anexos = await salvarAnexos(db, params, conversa.id)

    // 5. Grava a mensagem do cliente (o gatilho atualiza a conversa)
    await db.from('wa_messages').insert({
      conversation_id: conversa.id,
      client_id: conversa.client_id,
      canal,
      direction: 'inbound',
      autor: 'cliente',
      autor_nome: nomePerfil,
      body: corpo || (anexos.length ? '[anexo]' : ''),
      media_url: anexos[0] || null,
      twilio_sid: sid,
      status: 'received',
    })

    // 6. O bot só fala quando a conversa é dele
    if (conversa.status === 'bot') {
      const r = await responderBot({ texto: corpo, clientId: conversa.client_id, db })

      if (r.texto) {
        const envio = await enviarWhatsApp({ para: telefone, corpo: r.texto })
        await db.from('wa_messages').insert({
          conversation_id: conversa.id,
          client_id: conversa.client_id,
          canal,
          direction: 'outbound',
          autor: 'bot',
          autor_nome: `bot:${r.motivo}`,
          body: r.texto,
          twilio_sid: envio.sid || null,
          status: envio.ok ? envio.status || 'queued' : 'failed',
          error_text: envio.ok ? null : envio.erro,
        })
      }

      if (r.escalar) {
        await db.from('wa_conversations').update({ status: 'fila' }).eq('id', conversa.id)
      }
    }
  } catch (e: any) {
    // Nunca devolvemos erro para a Twilio: ela reenviaria e duplicaria.
    console.error('[wa/webhook] falha:', e?.message || e)
  }

  return xml()
}

/** Baixa as mídias com as credenciais da Twilio e guarda no bucket privado. */
async function salvarAnexos(db: any, params: Record<string, string>, conversaId: string): Promise<string[]> {
  const qtd = parseInt(params.NumMedia || '0', 10)
  if (!qtd) return []
  const sid = process.env.TWILIO_ACCOUNT_SID!
  const token = process.env.TWILIO_AUTH_TOKEN!
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64')
  const caminhos: string[] = []

  for (let i = 0; i < Math.min(qtd, 10); i++) {
    const url = params[`MediaUrl${i}`]
    const tipo = params[`MediaContentType${i}`] || 'application/octet-stream'
    if (!url) continue
    try {
      const r = await fetch(url, { headers: { Authorization: auth } })
      if (!r.ok) { console.error('[wa/webhook] mídia', i, 'HTTP', r.status); continue }
      const bytes = Buffer.from(await r.arrayBuffer())
      const ext = (tipo.split('/')[1] || 'bin').split(';')[0]
      const caminho = `${conversaId}/${Date.now()}-${i}.${ext}`
      const { error } = await db.storage.from(BUCKET).upload(caminho, bytes, { contentType: tipo, upsert: false })
      if (error) { console.error('[wa/webhook] upload:', error.message); continue }
      caminhos.push(caminho)
    } catch (e: any) {
      console.error('[wa/webhook] mídia falhou:', e?.message || e)
    }
  }
  return caminhos
}
