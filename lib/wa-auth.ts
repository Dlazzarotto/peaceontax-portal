// lib/wa-auth.ts — quem pode abrir o Atendimento
//
// Regra: as conversas contêm dados fiscais. Só sócio (owner) e
// gerente (manager) entram. Assistente (junior) não vê nada.
//
// A conferência é SEMPRE no servidor. Esconder o menu no
// navegador não é permissão, é decoração.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { ehDaFirma, papelGravado } from '@/lib/papeis'
import { getStaffLevel } from '@/lib/staff-perms'

export type Nivel = 'owner' | 'manager' | 'junior' | null

export function admin(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export type Autor = { id: string; email: string; nome: string; nivel: Nivel }

/**
 * Lê o token do cabeçalho Authorization, confirma o usuário e descobre o
 * nível pelo MESMO caminho do resto do sistema: a porta da firma
 * (lib/papeis.ts) e o nível da equipe (getStaffLevel).
 *
 * Aqui havia uma SEGUNDA definição de nível: lia staff_roles inteira e
 * procurava a pessoa em QUALQUER coluna de texto igual ao id ou ao e-mail, e
 * o nível em role/nivel/level/papel por substring — 'admin' virava gerente,
 * enquanto para o resto do sistema era assistente. Duas definições do mesmo
 * nível discordam no primeiro caso estranho, e é justamente nele que importa.
 */
export async function autorDaRequisicao(req: Request): Promise<Autor | null> {
  const cab = req.headers.get('authorization') || ''
  const token = cab.startsWith('Bearer ') ? cab.slice(7) : ''
  if (!token) return null

  const db = admin()
  const { data: u, error } = await db.auth.getUser(token)
  if (error || !u?.user) return null

  const user = u.user
  const email = (user.email || '').toLowerCase()

  // Cliente não tem nível: a porta decide antes do poder.
  const nivel: Nivel = ehDaFirma(papelGravado(user)) ? await getStaffLevel(user.id) : null

  const nome =
    (user.user_metadata as any)?.full_name ||
    (user.user_metadata as any)?.name ||
    (user.email || '').split('@')[0]

  return { id: user.id, email, nome, nivel }
}

export function podeAtender(nivel: Nivel): boolean {
  return nivel === 'owner' || nivel === 'manager'
}

/** Resposta padrão de recusa. */
export function negado(motivo = 'Sem permissão para o Atendimento.') {
  return Response.json({ erro: motivo }, { status: 403 })
}
