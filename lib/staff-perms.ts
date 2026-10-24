// lib/staff-perms.ts — Nível de equipe e aprovação por PIN
//
// FONTE ÚNICA do nível: team_members.level (sql/equipe-unica-v1.sql). Até
// ali era a tabela staff_roles, que ficou CONGELADA como rastro — a service
// role não grava mais nela. As regras puras (o que cada papel dá, quem muda
// o nível de quem) estão em lib/equipe.ts.
//
// São duas perguntas, como em lib/papeis.ts: o papel em app_metadata é a
// PORTA (firma × cliente); o nível em team_members é o PODER.
//
// Login da firma sem linha na equipe (o aceite do convite falhou ao gravar)
// cai no nível que o papel do login dá — assim ninguém fica travado por um
// passo que falhou. A migração confere que ninguém está nesse caso, e o
// papel acompanha o nível quando o sócio muda o nível (papelDoNivel), então
// a reserva e a linha não discordam.
//
// CONSULTA QUE FALHA NÃO CAI NA RESERVA. Antes, um erro na leitura virava
// "sem registro" e o papel decidia: um gerente com papel 'firm' virava sócio
// num tropeço de rede. Erro devolve o nível mais restrito — o sócio leva um
// 403 e tenta de novo; o contrário abre os totais da firma a quem não devia.

import { createHash } from 'crypto'
import { serviceDb } from '@/lib/service-db'
import { colunaAusente } from '@/lib/caixa-firma'
import { nivelDoPapel, nivelValido, type StaffLevel } from '@/lib/equipe'
import type { Concessoes, ChavePermissao } from '@/lib/permissoes'

export type { StaffLevel } from '@/lib/equipe'
export { nivelDoPapel } from '@/lib/equipe'

export const MIGRACAO_EQUIPE = 'sql/equipe-unica-v1.sql'

/**
 * Lê o nível em staff_roles, o lugar ANTIGO. Só é chamado quando
 * team_members ainda não tem a coluna `level` — o código subiu antes da
 * migração. Depois dela, ninguém passa por aqui.
 */
async function nivelNaTabelaAntiga(userId: string): Promise<StaffLevel | null | 'erro'> {
  const { data, error } = await serviceDb()
    .from('staff_roles').select('level').eq('user_id', userId).maybeSingle()
  if (error) return 'erro'
  return data ? (nivelValido(data.level) ?? 'junior') : null
}

export async function getStaffLevel(userId: string): Promise<StaffLevel> {
  const db = serviceDb()

  let nivel: StaffLevel | null | 'erro'
  const { data, error } = await db
    .from('team_members')
    .select('level, active')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) nivel = colunaAusente(error) ? await nivelNaTabelaAntiga(userId) : 'erro'
  // Quem SAIU da equipe vale o mais restrito: o login é bloqueado junto, mas
  // a sessão já aberta dura até expirar. E não pode cair na reserva do papel
  // abaixo, que devolveria o nível de quando a pessoa entrou.
  else if (data && data.active === false) nivel = 'junior'
  // Nível que não é nível vale o mais restrito: é como padraoDoNivel já o
  // tratava (não conhece outro), e a coluna tem CHECK.
  else nivel = data ? (nivelValido(data.level) ?? 'junior') : null

  if (nivel === 'erro') return 'junior'
  if (nivel) return nivel

  // Sem linha na equipe: o papel do login.
  try {
    const { data: u } = await db.auth.admin.getUserById(userId)
    // app_metadata, nunca user_metadata: o usuario escreve no segundo, e
    // este ramo decide o NIVEL (um 'owner' forjado sairia daqui).
    const papel = u?.user?.app_metadata?.role
    if (papel) return nivelDoPapel(papel)
  } catch { /* segue para o padrão */ }

  // Padrão mais restritivo
  return 'junior'
}

/**
 * Autorizações individuais gravadas para esta pessoa.
 *
 * Lê a view staff_grants_atual (a última decisão de cada chave). Se a
 * migração ainda não rodou, devolve vazio: o sistema volta a se comportar
 * exatamente como o nível manda, em vez de travar o financeiro inteiro.
 */
export async function concessoesDe(userId: string): Promise<Concessoes> {
  try {
    const { data, error } = await serviceDb()
      .from('staff_grants_atual')
      .select('chave, concedido')
      .eq('user_id', userId)
    if (error || !data) return {}
    const c: Concessoes = {}
    for (const linha of data as { chave: string; concedido: boolean }[]) {
      c[linha.chave as ChavePermissao] = linha.concedido
    }
    return c
  } catch {
    return {}
  }
}

export function hashPin(pin: string): string {
  return createHash('sha256').update(pin.trim()).digest('hex')
}

/**
 * Valida um PIN de aprovação contra qualquer owner/manager ATIVO.
 * Retorna o user_id do aprovador ou null se inválido.
 *
 * Só quem está ativo na equipe: em staff_roles não havia essa noção, e o
 * PIN de um gerente desligado (login bloqueado) continuava liberando
 * desconto de orçamento e troca de acesso de cliente no balcão.
 *
 * Dois aprovadores com o mesmo PIN não dizem QUEM aprovou: maybeSingle
 * recusa, e a aprovação também.
 */
export async function validateManagerPin(pin: string): Promise<string | null> {
  if (!pin?.trim()) return null
  const hash = hashPin(pin)
  const { data, error } = await serviceDb()
    .from('team_members')
    .select('user_id')
    .in('level', ['owner', 'manager'])
    .eq('approval_pin_hash', hash)
    .eq('active', true)
    .not('user_id', 'is', null)
    .maybeSingle()
  if (error && colunaAusente(error)) {
    // O código subiu antes da migração: o PIN ainda mora em staff_roles.
    const antigo = await serviceDb()
      .from('staff_roles')
      .select('user_id')
      .in('level', ['owner', 'manager'])
      .eq('approval_pin_hash', hash)
      .maybeSingle()
    return antigo.data?.user_id ?? null
  }
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
