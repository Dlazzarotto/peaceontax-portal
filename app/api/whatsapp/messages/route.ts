// app/api/whatsapp/messages/route.ts — a conversa da direita
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { admin, autorDaRequisicao, podeAtender, negado } from '@/lib/wa-auth'
import { janelaAberta, minutosDeJanela, formatarTelefone } from '@/lib/wa'

const BUCKET = 'whatsapp-media'

export async function GET(req: Request) {
  const autor = await autorDaRequisicao(req)
  if (!autor) return Response.json({ erro: 'Sessão expirada. Entre de novo.' }, { status: 401 })
  if (!podeAtender(autor.nivel)) return negado()

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  const ler = searchParams.get('ler') === '1'
  if (!id) return Response.json({ erro: 'Conversa não informada.' }, { status: 400 })

  const db = admin()
  const { data: conversa, error } = await db.from('wa_conversations').select('*').eq('id', id).maybeSingle()
  if (error || !conversa) return Response.json({ erro: 'Conversa não encontrada.' }, { status: 404 })

  const { data: msgs } = await db
    .from('wa_messages').select('*')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })
    .limit(500)

  // Anexos: link assinado de 1 hora (bucket é privado de propósito)
  const mensagens = await Promise.all((msgs || []).map(async (m: any) => {
    let anexo: string | null = null
    if (m.media_url) {
      if (/^https?:\/\//.test(m.media_url)) anexo = null // link antigo da Twilio: não abre sem senha
      else {
        const { data } = await db.storage.from(BUCKET).createSignedUrl(m.media_url, 3600)
        anexo = data?.signedUrl || null
      }
    }
    return {
      id: m.id, direction: m.direction, autor: m.autor,
      autor_nome: m.autor_nome, body: m.body, anexo,
      status: m.status, erro: m.error_text,
      template: m.template_name, created_at: m.created_at,
    }
  }))

  if (ler && (conversa.nao_lidas || 0) > 0) {
    await db.from('wa_conversations').update({ nao_lidas: 0 }).eq('id', id)
  }

  return Response.json({
    conversa: {
      id: conversa.id, phone: conversa.phone,
      telefone_formatado: formatarTelefone(conversa.phone),
      canal: conversa.canal, status: conversa.status,
      atendente_id: conversa.atendente_id, minha: conversa.atendente_id === autor.id,
      cliente_id: conversa.client_id, nome_exibicao: conversa.nome_exibicao,
      janela_aberta: janelaAberta(conversa.ultima_do_cliente),
      janela_min: minutosDeJanela(conversa.ultima_do_cliente),
    },
    mensagens,
    contexto: await contextoDoCliente(db, conversa.client_id),
    templates: await templatesAtivos(db),
    autor: { id: autor.id, nome: autor.nome, nivel: autor.nivel },
  })
}

/** Contexto ao lado da conversa. Tudo tolerante a falta de tabela/coluna. */
async function contextoDoCliente(db: any, clientId: string | null) {
  if (!clientId) return null
  const { data: c } = await db.from('clients').select('*').eq('id', clientId).maybeSingle()
  if (!c) return null

  const ctx: any = {
    id: c.id,
    nome: c.business_name || c.company_name || c.full_name || c.name || c.nome || 'Cliente',
    email: c.email || null,
    etapa: c.stage ?? c.etapa ?? c.pipeline_stage ?? c.status ?? null,
    tipo: c.client_type ?? c.tipo ?? c.business_kind ?? null,
    responsavel: c.assignee ?? c.assigned_to ?? c.responsavel ?? null,
  }

  try {
    const { data: inv } = await db.from('invoices').select('*').eq('client_id', clientId).limit(100)
    const abertas = (inv || []).filter((i: any) =>
      !['paid', 'pago', 'cancelled', 'canceled', 'cancelada', 'void', 'draft'].includes(String(i.status || '').toLowerCase()))
    ctx.faturas_abertas = abertas.length
  } catch { /* módulo ainda não instalado */ }

  try {
    const { count } = await db.from('documents').select('id', { count: 'exact', head: true }).eq('client_id', clientId)
    ctx.documentos = count ?? null
  } catch { /* sem tabela documents */ }

  return ctx
}

async function templatesAtivos(db: any) {
  try {
    const { data } = await db.from('wa_templates').select('*').eq('ativo', true).order('nome')
    return (data || []).map((t: any) => ({
      id: t.id, nome: t.nome, corpo: t.corpo, variaveis: t.variaveis, content_sid: t.content_sid,
    }))
  } catch { return [] }
}
