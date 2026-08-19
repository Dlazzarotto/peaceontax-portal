// app/api/whatsapp/assign/route.ts — assumir, resolver, devolver ao bot, vincular cliente
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { admin, autorDaRequisicao, podeAtender, negado } from '@/lib/wa-auth'

export async function POST(req: Request) {
  const autor = await autorDaRequisicao(req)
  if (!autor) return Response.json({ erro: 'Sessão expirada. Entre de novo.' }, { status: 401 })
  if (!podeAtender(autor.nivel)) return negado()

  const { conversa_id, acao, client_id } = (await req.json().catch(() => ({}))) as any
  if (!conversa_id || !acao) return Response.json({ erro: 'Faltou a conversa ou a ação.' }, { status: 400 })

  const db = admin()
  const { data: conversa } = await db.from('wa_conversations').select('*').eq('id', conversa_id).maybeSingle()
  if (!conversa) return Response.json({ erro: 'Conversa não encontrada.' }, { status: 404 })

  const agora = new Date().toISOString()
  let patch: any = {}

  switch (acao) {
    case 'assumir':
      // Gerente não tira conversa do sócio pelas costas; sócio pode tudo.
      if (conversa.atendente_id && conversa.atendente_id !== autor.id && autor.nivel !== 'owner') {
        return Response.json({ erro: 'Esta conversa já está com outra pessoa. Peça para ela liberar.' }, { status: 409 })
      }
      patch = { status: 'humano', atendente_id: autor.id, assumida_em: conversa.assumida_em || agora, resolvida_em: null, nao_lidas: 0 }
      break
    case 'liberar':
      patch = { status: 'fila', atendente_id: null }
      break
    case 'resolver':
      patch = { status: 'resolvida', resolvida_em: agora, nao_lidas: 0 }
      break
    case 'reabrir':
      patch = { status: 'fila', resolvida_em: null }
      break
    case 'bot':
      patch = { status: 'bot', atendente_id: null }
      break
    case 'vincular':
      if (!client_id) return Response.json({ erro: 'Escolha o cliente.' }, { status: 400 })
      patch = { client_id }
      await db.from('wa_messages').update({ client_id }).eq('conversation_id', conversa_id)
      break
    default:
      return Response.json({ erro: 'Ação desconhecida.' }, { status: 400 })
  }

  const { data, error } = await db.from('wa_conversations').update(patch).eq('id', conversa_id).select('*').single()
  if (error) return Response.json({ erro: error.message }, { status: 500 })
  return Response.json({ ok: true, conversa: data })
}

/** Busca de clientes para o botão "vincular" (conversa de número não cadastrado). */
export async function GET(req: Request) {
  const autor = await autorDaRequisicao(req)
  if (!autor) return Response.json({ erro: 'Sessão expirada.' }, { status: 401 })
  if (!podeAtender(autor.nivel)) return negado()

  const termo = (new URL(req.url).searchParams.get('q') || '').trim()
  if (termo.length < 2) return Response.json({ clientes: [] })

  const db = admin()
  const { data } = await db.from('clients').select('*').limit(500)
  const t = termo.toLowerCase()
  const clientes = (data || [])
    .map((c: any) => ({
      id: c.id,
      nome: c.business_name || c.company_name || c.full_name || c.name || c.nome || 'Cliente',
      email: c.email || '',
    }))
    .filter((c: any) => c.nome.toLowerCase().includes(t) || c.email.toLowerCase().includes(t))
    .slice(0, 20)

  return Response.json({ clientes })
}
