// lib/equipe-servidor.ts — a equipe no banco (o que lib/equipe.ts decide)
//
// Leitura e gravação de team_members, da trilha team_member_audit e da lista
// de logins do Supabase Auth. As regras ficam em lib/equipe.ts, que é puro e
// tem teste; aqui só se busca, grava e devolve o erro — consulta que falha
// não vira lista vazia (a tela diria "ninguém na equipe").

import { serviceDb } from '@/lib/service-db'
import { colunaAusente } from '@/lib/caixa-firma'
import { MIGRACAO_EQUIPE } from '@/lib/staff-perms'
import {
  escolherMembroParaVincular, type StaffLevel, type MembroDaLista, type LoginDaLista,
} from '@/lib/equipe'

type Db = ReturnType<typeof serviceDb>

export const AVISO_MIGRACAO =
  `A equipe ainda não foi unificada no banco — rode ${MIGRACAO_EQUIPE} no SQL Editor (ou pelo workflow Migrações do banco).`

/**
 * TODOS os logins. `listUsers()` sem página devolve só os primeiros 50 — e
 * com centenas de clientes no portal, gente da equipe sumia da tela. Pára na
 * primeira página VAZIA, e não na primeira curta: se o servidor limitar a
 * página abaixo do pedido, "veio menos que o pedido" pararia cedo e a lista
 * sairia cortada sem aviso. O teto de páginas é só contra laço sem fim.
 */
export async function todosOsLogins(db: Db = serviceDb()): Promise<{ logins: LoginDaLista[]; erro: string | null }> {
  const logins: LoginDaLista[] = []
  const porPagina = 1000
  for (let pagina = 1; pagina <= 100; pagina++) {
    const { data, error } = await db.auth.admin.listUsers({ page: pagina, perPage: porPagina })
    if (error) return { logins, erro: error.message }
    const users = data?.users || []
    if (!users.length) return { logins, erro: null }
    for (const u of users as any[]) {
      logins.push({
        id: u.id,
        email: u.email ?? null,
        papel: typeof u.app_metadata?.role === 'string' ? u.app_metadata.role : null,
        nome: u.user_metadata?.full_name ?? null,
        title: u.user_metadata?.title ?? null,
        phone: u.user_metadata?.phone ?? null,
        // banned_until no futuro = bloqueado ('none' ou vazio = livre)
        banido: !!u.banned_until && new Date(u.banned_until).getTime() > Date.now(),
        ultimoAcesso: u.last_sign_in_at ?? null,
      })
    }
  }
  return { logins, erro: 'a lista de logins não terminou em 100 páginas' }
}

/** As linhas da equipe. `semMigracao`: o código subiu antes de sql/equipe-unica-v1.sql. */
export async function lerMembros(db: Db = serviceDb()): Promise<{
  membros: MembroDaLista[]; erro: string | null; semMigracao: boolean
}> {
  const { data, error } = await db
    .from('team_members')
    .select('id, name, email, user_id, level, active, approval_pin_hash')
  if (error) {
    return { membros: [], erro: colunaAusente(error) ? AVISO_MIGRACAO : error.message, semMigracao: !!colunaAusente(error) }
  }
  const membros = (data || []).map((m: any) => ({
    id: String(m.id), name: m.name, email: m.email, user_id: m.user_id,
    level: m.level, active: m.active, temPin: !!m.approval_pin_hash,
  }))
  return { membros, erro: null, semMigracao: false }
}

/** A linha da equipe de um login (ou null). Erro viaja. */
export async function membroDoLogin(userId: string, db: Db = serviceDb()) {
  const { data, error } = await db
    .from('team_members')
    .select('id, name, email, user_id, level, active, approval_pin_hash')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return { membro: null, erro: colunaAusente(error) ? AVISO_MIGRACAO : error.message }
  return { membro: data as any, erro: null }
}

export type AcaoDaTrilha =
  | 'criado' | 'vinculado' | 'editado' | 'nivel' | 'pin_zerado' | 'desativado' | 'reativado'

/**
 * Uma linha na trilha. Devolve o erro em vez de engolir: quem muda o NÍVEL
 * grava a trilha ANTES e recusa a mudança se ela falhar — mudança de poder
 * sem rastro é pior que mudança não feita (princípio 2).
 */
export async function gravarNaTrilha(p: {
  memberId: string | null
  userId: string | null
  acao: AcaoDaTrilha
  porQuem: string | null
  motivo?: string | null
  antes?: unknown
  depois?: unknown
}, db: Db = serviceDb()): Promise<string | null> {
  const { error } = await db.from('team_member_audit').insert({
    member_id: p.memberId,
    user_id: p.userId,
    action: p.acao,
    performed_by: p.porQuem,
    reason: p.motivo ?? null,
    previous_state: p.antes ?? null,
    new_state: p.depois ?? null,
  })
  if (!error) return null
  return /team_member_audit/.test(error.message) && /exist/i.test(error.message)
    ? AVISO_MIGRACAO
    : error.message
}

/**
 * O aceite do convite: liga o login à linha da equipe.
 *
 * Quem já tem linha NÃO tem o nível tocado — o nível de quem já está na
 * equipe só muda pelo sócio, à vista. Era o buraco do convite antigo: aceito
 * depois de a pessoa ter sido rebaixada, ele devolvia o nível de antes.
 * Linha do CRM livre (mesmo e-mail, ou mesmo nome sem e-mail) é COMPLETADA;
 * só sem nenhuma se insere.
 */
export async function vincularNaEquipe(p: {
  userId: string
  email: string
  nome: string
  nivel: StaffLevel
}, db: Db = serviceDb()): Promise<{ ok: boolean; memberId: string | null; acao: string; erro: string | null }> {
  const { membros, erro } = await lerMembros(db)
  if (erro) return { ok: false, memberId: null, acao: 'nenhuma', erro }

  const v = escolherMembroParaVincular(membros, { userId: p.userId, email: p.email, nome: p.nome })
  const email = p.email.trim().toLowerCase()

  if (v.tipo === 'ja-vinculado') return { ok: true, memberId: v.id, acao: 'ja-vinculado', erro: null }

  if (v.tipo === 'vincular') {
    const antes = membros.find(m => m.id === v.id)
    // `.is('user_id', null)`: se outro aceite pegou a linha no meio do
    // caminho, este não a rouba — volta zero linhas e cai no erro abaixo.
    const { data, error } = await db.from('team_members')
      .update({ user_id: p.userId, email, level: p.nivel, active: true, updated_at: new Date().toISOString() })
      .eq('id', v.id).is('user_id', null)
      .select('id')
    if (error) return { ok: false, memberId: null, acao: 'vincular', erro: error.message }
    if (!data?.length) return { ok: false, memberId: null, acao: 'vincular', erro: 'a linha da equipe foi ligada a outro login no meio do aceite' }
    const trilha = await gravarNaTrilha({
      memberId: v.id, userId: p.userId, acao: 'vinculado', porQuem: p.userId,
      motivo: `aceite do convite (mesmo ${v.por === 'email' ? 'e-mail' : 'nome'})`,
      antes: antes ? { name: antes.name, email: antes.email, active: antes.active } : null,
      depois: { level: p.nivel, email },
    }, db)
    return { ok: true, memberId: v.id, acao: 'vinculado', erro: trilha }
  }

  const { data, error } = await db.from('team_members')
    .insert({ name: v.nome, email, role: p.nivel, user_id: p.userId, level: p.nivel, active: true })
    .select('id').single()
  if (error) return { ok: false, memberId: null, acao: 'inserir', erro: error.message }
  const trilha = await gravarNaTrilha({
    memberId: String(data.id), userId: p.userId, acao: 'criado', porQuem: p.userId,
    motivo: 'aceite do convite', depois: { name: v.nome, email, level: p.nivel },
  }, db)
  return { ok: true, memberId: String(data.id), acao: 'criado', erro: trilha }
}
