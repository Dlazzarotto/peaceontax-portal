// lib/staff-perms.ts — Níveis de equipe e aprovação por PIN
// owner/manager: editam cotações livremente
// junior: precisa de PIN de um manager + motivo para alterar/cancelar

import { createHash } from 'crypto'
import { serviceDb } from '@/lib/api-auth'

export type StaffLevel = 'owner' | 'manager' | 'junior'

export async function getStaffLevel(userId: string): Promise<StaffLevel> {
  const { data } = await serviceDb()
    .from('staff_roles')
    .select('level')
    .eq('user_id', userId)
    .maybeSingle()
  // Sem registro = junior (mais restritivo por padrão)
  return (data?.level as StaffLevel) ?? 'junior'
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
