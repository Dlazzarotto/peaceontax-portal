// /api/team
//
// A equipe como RESPONSÁVEL no CRM — o seletor dos clientes lê daqui.
//
//  GET    ?all=1        → lista (por padrão só os ativos) — qualquer pessoa da equipe
//  POST   { name, email? }                 → inclui alguém SEM login (só o sócio)
//  PATCH  { id, name?, email?, active?, oldName? } → edita ou desativa quem
//                                            NÃO tem login (só o sócio)
//
// Desde a unificação (lib/equipe.ts) a linha daqui é a PESSOA: o nível mora
// nela (level). Por isso:
//  - o corpo não escolhe mais nível nem "função". A coluna `role` era um
//    rótulo que QUALQUER assistente trocava, e a tela mostrava "Sócio" para
//    quem o sistema tratava como assistente. O nível muda em Equipe, pelo
//    sócio, com senha e motivo (/api/firm/users/[id]).
//  - quem tem LOGIN não se edita aqui: desativar só a linha deixaria o login
//    entrando, e renomear não mudaria o nome do login. Essa pessoa se edita
//    pela linha dela (/api/firm/users/[id]).
//  - escrever é do sócio, como o resto da equipe. Ler continua aberto à
//    equipe: é o seletor de responsável.
//
// Desativar preserva o histórico: o nome some das listas novas, mas os
// clientes já atribuídos continuam mostrando quem cuidava deles.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { colunaAusente } from '@/lib/caixa-firma'
import { gravarNaTrilha, AVISO_MIGRACAO } from '@/lib/equipe-servidor'

export const dynamic = 'force-dynamic'

async function exigeSocio() {
  const auth = await getAuth()
  if (!auth?.isStaff) return { erro: NextResponse.json({ error: 'Acesso restrito' }, { status: 403 }) }
  if ((await getStaffLevel(auth.userId)) !== 'owner') {
    return { erro: NextResponse.json({ error: 'Somente o sócio altera a equipe.' }, { status: 403 }) }
  }
  return { auth }
}

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const todos = req.nextUrl.searchParams.get('all') === '1'
  const ler = (colunas: string) => {
    let q = serviceDb().from('team_members').select(colunas)
    if (!todos) q = q.eq('active', true)
    return q.order('name', { ascending: true })
  }

  let { data, error } = await ler('id, name, email, active, user_id')
  // Antes da migração as colunas novas não existem: o seletor continua
  // funcionando com o que havia.
  if (error && colunaAusente(error)) ({ data, error } = await ler('id, name, email, active'))
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // O seletor só precisa do nome. O nível não sai daqui: quem precisa dele
  // pergunta em /api/firm/users, que é do sócio e do gerente.
  const members = (data || []).map((m: any) => ({
    id: m.id, name: m.name, email: m.email, active: m.active, temLogin: !!m.user_id,
  }))
  return NextResponse.json({ members })
}

export async function POST(req: NextRequest) {
  const guarda = await exigeSocio()
  if (guarda.erro) return guarda.erro

  const b = await req.json()
  const name = String(b.name || '').trim()
  if (name.length < 2) return NextResponse.json({ error: 'Informe o nome de quem entra na equipe.' }, { status: 400 })
  const email = String(b.email || '').trim().toLowerCase() || null

  // Sem login: o nível é o mais restrito e não vale nada até a pessoa ser
  // convidada — quem dá o nível é o convite.
  const { data, error } = await serviceDb().from('team_members')
    .insert({ name, email, role: 'junior', active: true })
    .select('id, name, email, active').single()

  if (error) {
    const dup = /duplicate|unique/i.test(error.message)
    return NextResponse.json(
      { error: dup ? 'Já existe alguém com esse nome na equipe.' : error.message },
      { status: dup ? 409 : 500 })
  }
  await gravarNaTrilha({
    memberId: String(data.id), userId: null, acao: 'criado', porQuem: guarda.auth!.userId,
    motivo: 'responsável no CRM, sem login', depois: { name, email },
  })
  return NextResponse.json({ ok: true, member: data })
}

export async function PATCH(req: NextRequest) {
  const guarda = await exigeSocio()
  if (guarda.erro) return guarda.erro

  const b = await req.json()
  if (!b.id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: atual, error: errAtual } = await db.from('team_members')
    .select('id, name, email, active, user_id').eq('id', b.id).maybeSingle()
  if (errAtual) {
    return NextResponse.json({ error: colunaAusente(errAtual) ? AVISO_MIGRACAO : errAtual.message },
      { status: colunaAusente(errAtual) ? 409 : 500 })
  }
  if (!atual) return NextResponse.json({ error: 'Pessoa não encontrada na equipe.' }, { status: 404 })
  if (atual.user_id) {
    return NextResponse.json({
      error: 'Esta pessoa tem login: edite, desative ou reative pela linha dela em Equipe.',
    }, { status: 409 })
  }

  const upd: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (b.name !== undefined) {
    const n = String(b.name).trim()
    if (n.length < 2) return NextResponse.json({ error: 'Nome muito curto.' }, { status: 400 })
    upd.name = n
  }
  if (b.email !== undefined) upd.email = String(b.email).trim().toLowerCase() || null
  if (b.active !== undefined) upd.active = !!b.active

  const { data, error } = await db.from('team_members')
    .update(upd).eq('id', b.id)
    .select('id, name, active').single()
  if (error) {
    const dup = /duplicate|unique/i.test(error.message)
    return NextResponse.json({ error: dup ? 'Já existe alguém com esse nome na equipe.' : error.message },
      { status: dup ? 409 : 500 })
  }

  // Renomeou? Atualiza os clientes que apontavam para o nome antigo
  let renomeados = 0
  if (upd.name !== undefined && upd.name !== atual.name) {
    const { data: mudou } = await db.from('clients')
      .update({ assignee: upd.name }).eq('assignee', atual.name).select('id')
    renomeados = (mudou || []).length
  }

  await gravarNaTrilha({
    memberId: String(atual.id), userId: null, porQuem: guarda.auth!.userId,
    acao: upd.active === false ? 'desativado' : upd.active === true && !atual.active ? 'reativado' : 'editado',
    antes: { name: atual.name, email: atual.email, active: atual.active },
    depois: { ...upd, clientesRenomeados: renomeados },
  }, db)

  return NextResponse.json({ ok: true, member: data, renomeados })
}
