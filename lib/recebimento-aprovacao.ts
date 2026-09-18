// lib/recebimento-aprovacao.ts — que formas de recebimento pedem aprovação
//
// A REGRA, decidida pelo sócio:
//   Quem tem autorização para receber registra CARTÃO e ZELLE sozinho.
//   Qualquer outra forma — dinheiro em espécie na frente — só entra com a
//   senha de um gerente ou sócio.
//
// A lista é de LIVRES, não de bloqueadas, de propósito. Forma de pagamento
// nova que apareça amanhã nasce pedindo aprovação até alguém decidir o
// contrário. Errar para o lado da trava custa uma senha; errar para o outro
// custa dinheiro que ninguém consegue reconstituir.
//
// POR QUE ESTAS DUAS
// Cartão passa pelo Stripe: existe cobrança, existe recibo, existe extrato.
// Zelle cai na conta da firma: existe data, valor e remetente no banco.
// Espécie não existe em lugar nenhum até alguém digitar — o único controle
// possível é uma segunda pessoa no momento do lançamento. Cheque, wire,
// Venmo e "outro" ficam do lado da aprovação por decisão, não por descuido:
// soltar cada um é decisão do sócio, uma de cada vez.
//
// Isto virou necessário quando o sócio passou a poder AUTORIZAR `receber` a
// quem também emite fatura (lib/permissoes.ts). Sem a trava, a mesma pessoa
// emitiria por $500, receberia $500 em espécie e registraria $300. Com ela,
// o desvio exige duas pessoas.

/** Formas que quem tem `receber` registra sozinho. Fechada. */
export const FORMAS_LIVRES = ['card', 'zelle'] as const

export function exigeAprovacao(method: string | null | undefined): boolean {
  const m = String(method || '').trim().toLowerCase()
  if (!m) return true   // sem forma declarada, trava
  return !(FORMAS_LIVRES as readonly string[]).includes(m)
}

/** Níveis que podem aprovar. */
export const NIVEIS_APROVADORES = ['owner', 'manager'] as const

export function podeAprovar(nivel: string | null | undefined): boolean {
  return (NIVEIS_APROVADORES as readonly string[]).includes(String(nivel || ''))
}

const NOMES: Record<string, string> = {
  cash: 'Dinheiro em espécie', check: 'Cheque', wire: 'Transferência bancária',
  venmo: 'Venmo', ach: 'Débito em conta', external: 'Financiamento', other: 'Outro',
}

export function nomeDaForma(method: string | null | undefined): string {
  const m = String(method || '').trim().toLowerCase()
  return NOMES[m] || m || 'Esta forma'
}

export const AVISO = {
  falta: (method: string) =>
    `${nomeDaForma(method)} só é registrado com a autorização de um gerente ou sócio: ` +
    `peça o código da aba Autorização. Cartão e Zelle você registra sozinho.`,
  senha: (email: string) => `Senha não confere para ${email}.`,
  nivel: 'Quem aprovou não é gerente nem sócio. Chame alguém com esse nível.',
  tentativas: 'Muitas tentativas. Aguarde 1 minuto.',
}

/** Texto que vai para a trilha da fatura. */
export function notaDaAprovacao(emailAprovador: string, valor: number, method: string): string {
  return `${nomeDaForma(method)}: $${valor.toFixed(2)} aprovado por ${emailAprovador}.`
}
