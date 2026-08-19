// lib/staff-perms.ts — Níveis de equipe e aprovação por PIN
//
// FONTE ÚNICA de permissão: a tabela staff_roles.
// O papel escolhido no convite (firm/admin/manager/staff) é traduzido
// para os três níveis reais do sistema:
//
//   convite 'firm'  → owner    (sócio)
//   convite 'admin' → owner    (administrador: mesmo poder, inclusive relatórios)
//   convite 'manager' → manager
//   convite 'staff' → junior
//
// Se a pessoa ainda não estiver em staff_roles (convite aceito mas registro
// não criado), usamos o papel do login como reserva — assim ninguém fica
// travado por um passo esquecido.

import { createHash } from 'crypto'
import { serviceDb } from '@/lib/api-auth'

export type StaffLevel = 'owner' | 'manager' | 'junior'

/** Traduz o papel do convite para o nível de permissão do sistema. */
export function nivelDoPapel(papel: string | null | undefined): StaffLevel {
  switch (String(papel || '').toLowerCase()) {
    case 'firm':
    case 'owner':
    case 'admin':    return 'owner'
    case 'manager':  return 'manager'
    default:         return 'junior'
  }
}

export async function getStaffLevel(userId: string): Promise<StaffLevel> {
  const db = serviceDb()

  const { data } = await db
    .from('staff_roles')
    .select('level')
    .eq('user_id', userId)
    .maybeSingle()

  if (data?.level) return data.level as StaffLevel

  // Sem registro em staff_roles: cai para o papel do login.
  // Não grava nada aqui — quem grava é o aceite do convite.
  try {
    const { data: u } = await db.auth.admin.getUserById(userId)
    const papel = u?.user?.user_metadata?.role
    if (papel) return nivelDoPapel(papel)
  } catch { /* segue para o padrão */ }

  // Padrão mais restritivo
  return 'junior'
}

/** Garante o registro em staff_roles — usado no aceite do convite. */
export async function registrarNivel(params: {
  userId: string
  papelDoConvite: string
  displayName?: string
}): Promise<StaffLevel> {
  const nivel = nivelDoPapel(params.papelDoConvite)
  await serviceDb().from('staff_roles').upsert({
    user_id: params.userId,
    level: nivel,
    display_name: params.displayName || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' })
  return nivel
}

export function hashPin(pin: string): string {
  return createHash('sha256').update(pin.trim()).digest('hex')
}

/**
 * Valida um PIN de aprovação contra qualquer owner/manager.
 * Retorna o user_id do aprovador ou null se inválido.
 */
export async function validateManagerPin(pin: string): Promise<string | null> {
  if (!pin?.trim()) return null
  const hash = hashPin(pin)
  const { data } = await serviceDb()
    .from('staff_roles')
    .select('user_id')
    .in('level', ['owner', 'manager'])
    .eq('approval_pin_hash', hash)
    .maybeSingle()
  return data?.user_id ?? null
}

/** Grava evento de auditoria de cotação */
export async function auditQuote(params: {
  quoteId: string
  action: 'created'|'edited'|'sent'|'cancelled'|'deleted'|'paid'
  performedBy: string
  approvedBy?: string | null
  reason?: string | null
  previousState?: unknown
  newState?: unknown
}): Promise<void> {
  await serviceDb().from('quote_audit').insert({
    quote_id:       params.quoteId,
    action:         params.action,
    performed_by:   params.performedBy,
    approved_by:    params.approvedBy ?? null,
    reason:         params.reason ?? null,
    previous_state: params.previousState ?? null,
    new_state:      params.newState ?? null,
  })
}
