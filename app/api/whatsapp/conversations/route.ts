// app/api/whatsapp/conversations/route.ts — a fila da esquerda
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { admin, autorDaRequisicao, podeAtender, negado } from '@/lib/wa-auth'
import { janelaAberta, minutosDeJanela } from '@/lib/wa'

const PARADA_MIN = 30 // conversa esperando há mais de 30 min vira alerta

export async function GET(req: Request) {
  const autor = await autorDaRequisicao(req)
  if (!autor) return Response.json({ erro: 'Sessão expirada. Entre de novo.' }, { status: 401 })
  if (!podeAtender(autor.nivel)) return negado()

  const db = admin()
  const { searchParams } = new URL(req.url)
  const filtro = searchParams.get('filtro') || 'ativas'

  let q = db.from('wa_conversations').select('*').order('ultima_mensagem', { ascending: false, nullsFirst: false }).limit(200)

  if (filtro === 'ativas') q = q.in('status', ['fila', 'humano', 'bot'])
  else if (filtro === 'minhas') q = q.eq('atendente_id', autor.id).in('status', ['humano', 'fila'])
  else if (filtro !== 'todas') q = q.eq('status', filtro)

  const { data: conversas, error } = await q
  if (error) return Response.json({ erro: error.message }, { status: 500 })

  // Nome do cliente (a coluna varia entre cadastros antigos e novos)
  const ids = Array.from(new Set((conversas || []).map((c: any) => c.client_id).filter(Boolean)))
  const nomes: Record<string, string> = {}
  if (ids.length) {
    const { data: cs } = await db.from('clients').select('*').in('id', ids)
    for (const c of (cs || []) as any[]) {
      nomes[c.id] = c.business_name || c.company_name || c.full_name || c.name || c.nome || 'Cliente'
    }
  }

  const agora = Date.now()
  const lista = (conversas || []).map((c: any) => {
    const paradaMin = c.ultima_mensagem ? Math.round((agora - new Date(c.ultima_mensagem).getTime()) / 60000) : 0
    return {
      id: c.id,
      phone: c.phone,
      canal: c.canal,
      status: c.status,
      cliente: c.client_id ? nomes[c.client_id] || 'Cliente' : c.nome_exibicao || 'Não cadastrado',
      cadastrado: !!c.client_id,
      client_id: c.client_id,
      atendente_id: c.atendente_id,
      minha: c.atendente_id === autor.id,
      nao_lidas: c.nao_lidas || 0,
      ultima_mensagem: c.ultima_mensagem,
      janela_aberta: janelaAberta(c.ultima_do_cliente),
      janela_min: minutosDeJanela(c.ultima_do_cliente),
      precisa_de_voce: (c.status === 'fila' || c.status === 'humano') && (c.nao_lidas || 0) > 0 && paradaMin >= PARADA_MIN,
      parada_min: paradaMin,
    }
  })

  return Response.json({
    autor: { id: autor.id, nome: autor.nome, nivel: autor.nivel },
    conversas: lista,
    resumo: {
      esperando: lista.filter((c) => c.status === 'fila').length,
      comigo: lista.filter((c) => c.minha && c.status === 'humano').length,
      bot: lista.filter((c) => c.status === 'bot').length,
      precisa_de_voce: lista.filter((c) => c.precisa_de_voce).length,
    },
  })
}
