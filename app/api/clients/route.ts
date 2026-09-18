// GET  /api/clients — lista de clientes da firma (só equipe)
// POST /api/clients — cadastra cliente (só equipe)
//
// O middleware só garante que existe sessão: sem a conferência abaixo, um
// cliente logado no portal enxergava a carteira inteira da firma.
//
// E dentro da firma o escopo também não é livre: sem a autorização
// `verEmpresas`, a lista e as contagens ficam em PESSOA FÍSICA. Filtrar aqui
// é o que faz o cartão "Empresas" e o quadro delas simplesmente não
// existirem para quem atende o balcão — a tela não precisa esconder nada,
// porque o dado não chega.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'
import { getAuth, SEM_ACESSO_EMPRESA } from '@/lib/api-auth'
import { permissoesFinanceiro } from '@/lib/billing-perms'
import { camposDoCliente, criticarCliente, deveConvidar } from '@/lib/novo-cliente'
import { ETAPAS, resumirEtapas, buscaLiteral } from '@/lib/clientes-grupos'

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuth()
    if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
    const perms = await permissoesFinanceiro(auth.userId)
    const db = supabaseAdmin()
    const { searchParams } = new URL(req.url)
    const search = searchParams.get('search')
    const stage  = searchParams.get('stage')

    const tipoPedido = searchParams.get('type')

    // Pedir empresas sem autorização RECUSA. Trocar em silêncio por pessoa
    // física devolveria uma lista que não é a pedida, e quem abriu o link ia
    // concluir que a carteira de empresas está vazia.
    if (tipoPedido === 'business' && !perms.verEmpresas) {
      return NextResponse.json({ error: SEM_ACESSO_EMPRESA }, { status: 403 })
    }
    const type = tipoPedido
    const TIPOS_VISIVEIS = perms.verEmpresas
      ? ['business', 'individual']
      : ['individual']

    // ?resumo=1 devolve só as CONTAGENS, por tipo e etapa. É o que os cartões
    // de entrada precisam. Com quase mil cadastros, trazer todas as linhas só
    // para contar no navegador é transferir a carteira inteira a cada abertura
    // da tela — e nenhuma delas aparece.
    if (searchParams.get('resumo') === '1') {
      const contar = async (t: string, etapa: string) => {
        const { count } = await db.from('clients')
          .select('id', { count: 'exact', head: true })
          .eq('active', true).eq('type', t).eq('stage', etapa)
        return count ?? 0
      }
      const porTipo: Record<string, { stage: string; quantidade: number }[]> = {}
      // Só os tipos que esta pessoa pode ver. Contar empresas para quem não
      // pode abri-las vazaria o tamanho da carteira e desenharia um cartão
      // que não leva a nada.
      for (const t of TIPOS_VISIVEIS) {
        porTipo[t] = await Promise.all(
          ETAPAS.map(async e => ({ stage: e, quantidade: await contar(t, e) })))
      }
      // Etapa fora da lista (cadastro antigo, importação) não pode sumir da conta
      const totalDe = async (t: string) => {
        const { count } = await db.from('clients')
          .select('id', { count: 'exact', head: true }).eq('active', true).eq('type', t)
        return count ?? 0
      }
      const resumo: Record<string, any> = {}
      for (const t of TIPOS_VISIVEIS) {
        const r = resumirEtapas(porTipo[t])
        const total = await totalDe(t)
        const fora = total - r.total
        resumo[t] = { ...r, total, pendente: r.pendente + Math.max(fora, 0) }
      }
      // A tela precisa saber que o cartão de Empresas não existe para ela —
    // senão parece que a carteira zerou.
    return NextResponse.json({ resumo, tipos: TIPOS_VISIVEIS })
    }

    let query = db.from('clients').select('*').eq('active', true).order('name')
    // Curinga do LIKE escapado: buscar "100%" casava com "1000" e "100X"
    if (search) query = query.ilike('name', `%${buscaLiteral(search)}%`)
    if (type) query = query.eq('type', type)
    // Sem type na URL e sem `verEmpresas`, a lista sai só com pessoa física:
    // um `GET /api/clients` sem filtro não pode devolver a carteira inteira.
    else if (!perms.verEmpresas) query = query.in('type', TIPOS_VISIVEIS)
    if (stage)  query = query.eq('stage', stage)

    const { data, error } = await query.limit(2000)
    if (error) throw error

    // Estado do acesso ao portal, para a tela saber a quem oferecer o convite.
    // Uma consulta só para todos os convites pendentes, casada em memória —
    // com quase mil clientes, uma consulta por linha derrubaria a tela.
    const semAcesso = (data || []).filter(c => !c.user_id && c.email).map(c => String(c.email).toLowerCase())
    const convidados = new Map<string, string>()
    if (semAcesso.length) {
      const { data: convites } = await db.from('client_invitations')
        .select('client_email, created_at, status')
        .in('client_email', semAcesso.slice(0, 1000))
        .order('created_at', { ascending: false })
      for (const c of convites || []) {
        const e = String(c.client_email || '').toLowerCase()
        if (!convidados.has(e) && c.status !== 'registered') convidados.set(e, c.created_at)
      }
    }

    const clients = (data || []).map(c => ({
      ...c,
      acesso: c.user_id ? 'com_acesso'
        : !c.email ? 'sem_email'
        : convidados.has(String(c.email).toLowerCase()) ? 'convidado'
        : 'sem_acesso',
      convidadoEm: c.email ? convidados.get(String(c.email).toLowerCase()) || null : null,
    }))
    return NextResponse.json({ clients, tipos: TIPOS_VISIVEIS, perms })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuth()
    if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
    const body = await req.json()
    const db = supabaseAdmin()

    // O corpo NÃO vai direto para o insert: antes ia, e qualquer campo enviado
    // entrava na tabela — inclusive user_id, que amarra o cadastro a um login.
    const campos = camposDoCliente(body)
    const critica = criticarCliente(campos)
    if (critica) return NextResponse.json({ error: critica }, { status: 400 })
    let avisoEmail: string | null = null

    // Duplicata é MESMO E-MAIL COM MESMO NOME. E-mail repetido sozinho não é:
    // na carteira real, 56 e-mails aparecem em mais de um cadastro e só um é
    // duplicata de verdade — o resto é o dono e a empresa dele no mesmo gmail
    // ("Bruno Parreira" e "ABM Capital Group Inc"). São clientes diferentes,
    // com declarações diferentes. Recusar pelo e-mail barrava 55 cadastros
    // legítimos.
    if (campos.email) {
      const { data: mesmoEmail } = await db.from('clients')
        .select('id, name, business_name').eq('email', campos.email).limit(20)
      const chave = (n: any) => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[.,'"]/g, '').replace(/\s+/g, ' ').trim()
      const igual = (mesmoEmail || []).find(c =>
        chave(c.name) === chave(campos.name) || (c.business_name && chave(c.business_name) === chave(campos.name)))
      if (igual) {
        return NextResponse.json({
          error: `Já existe cliente com este nome e e-mail: ${igual.name}.`,
          clientId: igual.id,
        }, { status: 409 })
      }
      // Mesmo e-mail, nome diferente: passa, mas quem cadastra precisa saber —
      // o acesso ao portal é por e-mail e só serve a um dos dois.
      if (mesmoEmail?.length) {
        avisoEmail = `Atenção: este e-mail já é de ${mesmoEmail.map(c => c.name).join(', ')}.`
          + ' O acesso ao portal atende um cadastro só — confira qual deve ter o login.'
      }
    }

    const { data, error } = await db.from('clients').insert(campos).select().single()
    if (error) throw error

    // Cadastrar e convidar eram duas telas separadas, e o cliente ficava no
    // sistema sem nunca receber o login. Agora sai junto — o convite falhar
    // não desfaz o cadastro, mas a resposta diz que não foi.
    let convite: { enviado: boolean; motivo?: string } = { enviado: false }
    if (deveConvidar(body, campos)) {
      try {
        const r = await fetch(`${req.nextUrl.origin}/api/send-invite`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: req.headers.get('cookie') || '' },
          body: JSON.stringify({
            clientName: campos.name, clientEmail: campos.email,
            clientType: campos.type || 'individual', language: campos.language || 'en',
            assignee: campos.assignee || 'Peace on Tax', channels: ['email'],
          }),
        })
        const d = await r.json().catch(() => ({}))
        convite = r.ok && d?.emailSent !== false
          ? { enviado: true }
          : { enviado: false, motivo: d?.error || 'o e-mail não saiu' }
      } catch (e) {
        convite = { enviado: false, motivo: (e as Error).message }
      }
      if (!convite.enviado) console.error('convite do cliente novo:', campos.email, convite.motivo)
    }

    return NextResponse.json({ client: data, convite, aviso: avisoEmail })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
