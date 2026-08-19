// lib/wa-auth.ts — quem pode abrir o Atendimento
//
// Regra: as conversas contêm dados fiscais. Só sócio (owner) e
// gerente (manager) entram. Assistente (junior) não vê nada.
//
// A conferência é SEMPRE no servidor. Esconder o menu no
// navegador não é permissão, é decoração.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

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
 * Lê o token do cabeçalho Authorization, confirma o usuário e
 * descobre o nível em staff_roles. A leitura de staff_roles é
 * tolerante ao nome das colunas (user_id / staff_id / email).
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

  let nivel: Nivel = null
  const { data: papeis } = await db.from('staff_roles').select('*').limit(200)
  if (papeis?.length) {
    const linha = papeis.find((p: any) =>
      Object.values(p).some(
        (v) => typeof v === 'string' && (v === user.id || v.toLowerCase() === email)
      )
    )
    const bruto = linha
      ? String(linha.role ?? linha.nivel ?? linha.level ?? linha.papel ?? '').toLowerCase()
      : ''
    if (bruto.includes('owner') || bruto.includes('socio') || bruto.includes('sócio')) nivel = 'owner'
    else if (bruto.includes('manager') || bruto.includes('gerente') || bruto.includes('admin')) nivel = 'manager'
    else if (bruto) nivel = 'junior'
  }

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
