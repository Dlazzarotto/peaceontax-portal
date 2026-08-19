// app/api/whatsapp/send/route.ts — a equipe responde
//
// Duas travas que não podem sair daqui:
// 1) fora da janela de 24h, só template aprovado — texto livre é
//    recusado pela Meta e o cliente nunca recebe;
// 2) a mensagem sai como Peace on Tax. O nome de quem escreveu é
//    gravado no banco para o relatório, nunca no texto enviado.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { admin, autorDaRequisicao, podeAtender, negado } from '@/lib/wa-auth'
import { enviarWhatsApp, janelaAberta } from '@/lib/wa'

export async function POST(req: Request) {
  const autor = await autorDaRequisicao(req)
  if (!autor) return Response.json({ erro: 'Sessão expirada. Entre de novo.' }, { status: 401 })
  if (!podeAtender(autor.nivel)) return negado()

  const corpoReq = await req.json().catch(() => ({}))
  const { conversa_id, texto, template_id, variaveis } = corpoReq || {}
  if (!conversa_id) return Response.json({ erro: 'Conversa não informada.' }, { status: 400 })

  const db = admin()
  const { data: conversa } = await db.from('wa_conversations').select('*').eq('id', conversa_id).maybeSingle()
  if (!conversa) return Response.json({ erro: 'Conversa não encontrada.' }, { status: 404 })

  const aberta = janelaAberta(conversa.ultima_do_cliente)
  let envio, corpoGravado: string, nomeTemplate: string | null = null

  if (aberta && !template_id) {
    const t = String(texto || '').trim()
    if (!t) return Response.json({ erro: 'Escreva a mensagem.' }, { status: 400 })
    if (t.length > 1500) return Response.json({ erro: 'Mensagem longa demais para o WhatsApp (máx. 1500).' }, { status: 400 })
    corpoGravado = t
    envio = await enviarWhatsApp({ para: conversa.phone, corpo: t })
  } else {
    if (!template_id) {
      return Response.json({
        erro: 'Passaram-se mais de 24 horas desde a última mensagem do cliente. Fora dessa janela o WhatsApp só entrega template aprovado — escolha um na lista.',
        janela_fechada: true,
      }, { status: 409 })
    }
    const { data: tpl } = await db.from('wa_templates').select('*').eq('id', template_id).maybeSingle()
    if (!tpl || !tpl.ativo) return Response.json({ erro: 'Template não encontrado ou desativado.' }, { status: 400 })

    const vars: Record<string, string> = {}
    const lista: string[] = Array.isArray(variaveis) ? variaveis : []
    for (let i = 0; i < (tpl.variaveis || 0); i++) {
      const v = String(lista[i] ?? '').trim()
      if (!v) return Response.json({ erro: `Preencha a variável ${i + 1} do template.` }, { status: 400 })
      vars[String(i + 1)] = v
    }
    nomeTemplate = tpl.nome
    corpoGravado = previa(tpl.corpo, vars)
    envio = await enviarWhatsApp({ para: conversa.phone, contentSid: tpl.content_sid, variaveis: vars })
  }

  // Grava sempre — inclusive a falha, para a equipe ver o que houve
  const { data: msg } = await db.from('wa_messages').insert({
    conversation_id: conversa.id,
    client_id: conversa.client_id,
    canal: conversa.canal,
    direction: 'outbound',
    autor: 'equipe',
    autor_nome: autor.nome,   // interno: alimenta o relatório do sócio
    autor_id: autor.id,
    body: corpoGravado,
    twilio_sid: envio.sid || null,
    status: envio.ok ? envio.status || 'queued' : 'failed',
    error_text: envio.ok ? null : envio.erro,
    template_name: nomeTemplate,
  }).select('*').single()

  // Quem responde assume a conversa
  if (envio.ok && conversa.status !== 'humano') {
    await db.from('wa_conversations').update({
      status: 'humano',
      atendente_id: autor.id,
      assumida_em: conversa.assumida_em || new Date().toISOString(),
      resolvida_em: null,
    }).eq('id', conversa.id)
  }

  if (!envio.ok) {
    return Response.json({ erro: envio.erro || 'A Twilio não aceitou a mensagem.', codigo: envio.codigo, mensagem: msg }, { status: 502 })
  }
  return Response.json({ ok: true, mensagem: msg })
}

function previa(corpo: string, vars: Record<string, string>) {
  return String(corpo || '').replace(/\{\{(\d+)\}\}/g, (_, n) => vars[n] ?? `{{${n}}}`)
}
