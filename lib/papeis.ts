// lib/papeis.ts — FONTE ÚNICA de "esta pessoa é da firma ou é cliente?"
//
// POR QUE ISTO EXISTE
// O sistema tinha duas linguagens para a mesma coisa e elas nunca se
// encontraram:
//
//   convite da equipe grava  role = firm | admin | manager | staff
//   porta de entrada lia     role === 'firm' ? 'firm' : 'client'
//
// Resultado: quem era convidado como Staff (o padrão do formulário),
// Manager ou Admin virava CLIENTE na hora de entrar — caía no /portal,
// via um portal vazio (não há linha em clients para ele) e levava 403 em
// toda rota de API. Só o Owner funcionava.
//
// Agora middleware, layouts e getAuth perguntam AQUI, e só aqui.
//
// A lista é FECHADA de propósito: papel desconhecido é CLIENTE, nunca
// firma. Errar para o lado restritivo tranca um funcionário (que o sócio
// conserta em um minuto); errar para o outro abre a carteira inteira.
//
// Isto é só a PORTA (firma × cliente). O poder de cada um dentro da firma
// — owner, manager, junior — continua vindo de staff_roles, por
// lib/staff-perms.ts. São duas perguntas diferentes.

/** Papéis que dão acesso à área da firma. Fechada. */
export const PAPEIS_DA_FIRMA = ['firm', 'owner', 'admin', 'manager', 'staff'] as const

export type PapelDeAcesso = 'firm' | 'client'

/** O papel gravado no login pertence à firma? */
export function ehDaFirma(papel: unknown): boolean {
  if (typeof papel !== 'string') return false
  return (PAPEIS_DA_FIRMA as readonly string[]).includes(papel.trim().toLowerCase())
}

/** Porta de entrada: firma ou cliente. Desconhecido é cliente. */
export function papelDoLogin(user: { user_metadata?: any } | null | undefined): PapelDeAcesso {
  return ehDaFirma(user?.user_metadata?.role) ? 'firm' : 'client'
}
