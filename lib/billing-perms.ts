// lib/billing-perms.ts — quem pode o quê no financeiro
//
// O conjunto sai de DUAS coisas, nesta ordem:
//   1. o NÍVEL (owner · manager · junior), que é a base;
//   2. as AUTORIZAÇÕES individuais que o sócio deu ou retirou daquela
//      pessoa em Settings → Users (tabela staff_grants).
//
// Quem monta o conjunto é `permissoesDe` de lib/permissoes.ts — lógica pura,
// coberta por testes. Aqui só se busca o que está gravado.
//
// Base por nível:
//   Assistente: SOMENTE emite estimate e invoice. Não recebe, não cancela,
//               não duplica, não dá desconto e não vê relatórios.
//               (Separação de funções: quem emite não dá baixa.)
//   Gerente:    emite, recebe, duplica, cancela, apaga, estorna e dá
//               desconto — mas NUNCA acessa relatórios nem totais.
//   Sócio:      tudo. E é imune a concessão negativa: tirar poder de sócio
//               se faz mudando o nível, à vista.
//
// A checagem é sempre no SERVIDOR. Esconder botão na tela não é controle de
// acesso: sem isto, bastaria chamar a rota direto.

import { getStaffLevel, concessoesDe, type StaffLevel } from '@/lib/staff-perms'
import { permissoesDe } from '@/lib/permissoes'

export interface PermissoesFinanceiro {
  nivel: StaffLevel
  criar: boolean          // emitir estimate/invoice
  receber: boolean        // dar baixa em pagamento
  duplicar: boolean       // copiar uma fatura já emitida
  editar: boolean         // alterar uma fatura já criada
  estornar: boolean       // desfazer um pagamento registrado
  senhaNaEdicao: boolean  // quem não é sócio confirma com senha e motivo
  cancelar: boolean
  apagar: boolean
  darDesconto: boolean
  verRelatorios: boolean  // relatórios de faturamento
  verTotais: boolean      // números consolidados do negócio
}

export async function permissoesFinanceiro(userId: string): Promise<PermissoesFinanceiro> {
  const nivel = await getStaffLevel(userId)
  const concessoes = nivel === 'owner' ? null : await concessoesDe(userId)
  const p = permissoesDe(nivel, concessoes)
  return {
    nivel,
    ...p,
    // Sócio edita direto; qualquer outro justifica a alteração — inclusive
    // o assistente que recebeu autorização para editar. A autorização diz
    // que ele PODE, não que ele pode sem deixar rastro.
    senhaNaEdicao: nivel !== 'owner',
  }
}

/** Mensagem padrão de recusa, para as rotas responderem igual. */
export const RECUSA = {
  apagar: 'Apagar fatura exige autorização. Cancele a fatura — ela continua no histórico.',
  totais: 'Os totais de faturamento exigem autorização do sócio.',
  relatorios: 'Relatórios de faturamento exigem autorização do sócio.',
  receber: 'Dar baixa em pagamento exige autorização — fale com o sócio.',
  duplicar: 'Duplicar fatura emitida exige autorização.',
  cancelar: 'Cancelar fatura exige autorização.',
  editar: 'Editar fatura exige autorização.',
  estornar: 'Estornar pagamento exige autorização.',
  desconto: 'Conceder desconto exige autorização.',
}
