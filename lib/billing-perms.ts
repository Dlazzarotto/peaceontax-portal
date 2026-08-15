// lib/billing-perms.ts — quem pode o quê no financeiro
//
// Assistente: SOMENTE emite estimate e invoice. Não recebe, não cancela,
//             não duplica, não dá desconto e não vê relatórios.
//             (Separação de funções: quem emite não dá baixa no pagamento.)
// Gerente:    emite, recebe pagamento, duplica fatura emitida, cancela,
//             apaga e concede desconto — mas NUNCA acessa relatórios.
// Sócio:      tudo, incluindo relatórios e totais do negócio.
//
// A checagem é sempre no SERVIDOR. Esconder botão na tela não é controle
// de acesso: sem isto, bastaria chamar a rota direto.

import { getStaffLevel, type StaffLevel } from '@/lib/staff-perms'

export interface PermissoesFinanceiro {
  nivel: StaffLevel
  criar: boolean          // emitir estimate/invoice
  receber: boolean        // dar baixa em pagamento
  duplicar: boolean       // copiar uma fatura já emitida
  editar: boolean         // alterar uma fatura já criada
  senhaNaEdicao: boolean  // gerente precisa confirmar com senha e motivo
  cancelar: boolean
  apagar: boolean
  darDesconto: boolean
  verRelatorios: boolean  // relatórios de faturamento
  verTotais: boolean      // números consolidados do negócio
}

export async function permissoesFinanceiro(userId: string): Promise<PermissoesFinanceiro> {
  const nivel = await getStaffLevel(userId)
  const senior = nivel === 'owner' || nivel === 'manager'
  return {
    nivel,
    criar: true,             // todos emitem
    receber: senior,         // baixa de pagamento: gerente ou sócio
    duplicar: senior,
    editar: senior,
    // Sócio edita direto; gerente confirma com senha e justifica a alteração
    senhaNaEdicao: nivel === 'manager',
    cancelar: senior,
    apagar: senior,
    // Desconto: só gerente ou sócio. Diferente dos orçamentos, aqui NÃO existe
    // liberação por PIN — assistente não concede desconto de forma alguma.
    darDesconto: senior,
    verRelatorios: nivel === 'owner',
    verTotais: nivel === 'owner',
  }
}

/** Mensagem padrão de recusa, para as rotas responderem igual. */
export const RECUSA = {
  apagar: 'Apagar fatura é permitido apenas a sócio ou gerente. Cancele a fatura — ela continua no histórico.',
  totais: 'Os totais de faturamento são visíveis apenas ao sócio.',
  relatorios: 'Relatórios de faturamento são exclusivos do sócio.',
  receber: 'Dar baixa em pagamento é permitido a gerente ou sócio.',
  duplicar: 'Duplicar fatura emitida é permitido a gerente ou sócio.',
  cancelar: 'Cancelar fatura é permitido a gerente ou sócio.',
  editar: 'Editar fatura é permitido a gerente ou sócio.',
  desconto: 'Desconto só pode ser concedido por gerente ou sócio.',
}
