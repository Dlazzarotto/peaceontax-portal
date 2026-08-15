// lib/billing-perms.ts — quem pode o quê no financeiro
//
// Assistente: cria fatura, recebe pagamento, cancela — nunca apaga,
//             e nunca vê totais de faturamento.
// Gerente:    tudo acima + apagar fatura.
// Sócio:      tudo, incluindo os números do negócio.
//
// A checagem é sempre no SERVIDOR. Esconder botão na tela não é controle
// de acesso: sem isto, bastaria chamar a rota direto.

import { getStaffLevel, type StaffLevel } from '@/lib/staff-perms'

export interface PermissoesFinanceiro {
  nivel: StaffLevel
  criar: boolean
  receber: boolean
  cancelar: boolean
  apagar: boolean
  verTotais: boolean
  darDesconto: boolean   // sem PIN
}

export async function permissoesFinanceiro(userId: string): Promise<PermissoesFinanceiro> {
  const nivel = await getStaffLevel(userId)
  const senior = nivel === 'owner' || nivel === 'manager'
  return {
    nivel,
    criar: true,
    receber: true,
    cancelar: true,
    apagar: senior,
    verTotais: nivel === 'owner',
    darDesconto: senior,
  }
}

/** Mensagem padrão de recusa, para as rotas responderem igual. */
export const RECUSA = {
  apagar: 'Apagar fatura é permitido apenas a sócio ou gerente. Cancele a fatura — ela continua no histórico.',
  totais: 'Os totais de faturamento são visíveis apenas ao sócio.',
  desconto: 'Desconto exige aprovação de um gerente (PIN).',
}
