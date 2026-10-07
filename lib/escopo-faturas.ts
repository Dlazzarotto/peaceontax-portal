// lib/escopo-faturas.ts — quem pode consultar QUAL fatura, e quando
//
// A REGRA, em uma frase: a lista de faturamento é do DIA e é de QUEM EMITIU.
// Sair disso — olhar dia anterior ou fatura de outra pessoa — é um ATO, e o
// ato pede senha e motivo. Só o SÓCIO tem acesso ilimitado.
//
// POR QUE A TELA MUDOU
// A lista abria com o histórico inteiro à mostra para gerente e sócio
// (`verTodasFaturas` vinha por nível). Quem passa pela mesa lê quanto cada
// cliente da firma pagou; e abrir a tela não é a mesma coisa que PRECISAR
// daquele dado. Agora a lista nasce FECHADA: aparece o que se buscou.
//
// NÃO É A TELA QUE DECIDE. A tela pergunta a mesma coisa que a rota exige —
// as duas chamam `decidirConsulta`, e a rota aplica o filtro que ela devolve.
// Botão e trava em arquivos diferentes foi a falha de método que mais custou
// neste projeto.

export type NivelFinanceiro = 'owner' | 'manager' | 'junior'

/** As situações que o filtro oferece, e o que cada uma é no banco. */
export const SITUACOES = {
  todas:     null,
  aberto:    ['sent', 'partial', 'overdue'],
  paga:      ['paid'],
  cancelada: ['void'],
  rascunho:  ['draft'],
} as const

export type SituacaoFiltro = keyof typeof SITUACOES

export const ROTULO_DA_SITUACAO: Record<SituacaoFiltro, string> = {
  todas: 'Todas', aberto: 'Em aberto', paga: 'Pagas',
  cancelada: 'Canceladas', rascunho: 'Rascunhos',
}

export function ehSituacao(v: unknown): v is SituacaoFiltro {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SITUACOES, v)
}

/** `sent`/`partial`/`overdue` são lidos JUNTOS como "em aberto" no sistema
 *  inteiro — o status tem uma definição só, no banco. */
export function statusDaSituacao(s: unknown): string[] | null {
  return ehSituacao(s) ? (SITUACOES[s] as unknown as string[] | null) : null
}

export interface PedidoDeConsulta {
  de?: string | null          // YYYY-MM-DD, início do período
  ate?: string | null         // YYYY-MM-DD, fim do período (inclusivo)
  situacao?: string
  emissor?: string | null     // user_id de quem emitiu; null = qualquer
  busca?: string
}

export interface QuemConsulta {
  nivel: NivelFinanceiro
  userId: string
  /** Concessão individual: dispensa a autorização de um segundo. */
  verTodas: boolean
  /** Há uma janela de consulta ampliada viva para esta pessoa. */
  autorizado: boolean
}

export interface Decisao {
  /** O pedido vai além do próprio dia / das próprias faturas. */
  amplo: boolean
  /** Vai além E a pessoa não tem como ir: a tela tem de pedir autorização. */
  precisaAutorizacao: boolean
  /** O que dizer a quem está pedindo — em palavras, não em regra abstrata. */
  motivo: string | null
  /** O filtro que a rota aplica. `createdBy` nulo = qualquer emissor. */
  filtro: {
    createdBy: string | null
    de: string | null
    ate: string | null
    status: string[] | null
  }
}

const dia = (v: unknown): string | null => {
  const t = String(v ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null
}

/**
 * O pedido sai do que a pessoa alcança sem autorização?
 *
 * Alcança sem autorização: o PRÓPRIO dia, das PRÓPRIAS faturas. Qualquer
 * coisa fora disso é ampla — inclusive pedir "sem filtro de data", que é o
 * jeito mais fácil de ver tudo sem parecer que se pediu.
 */
export function pedidoEhAmplo(pedido: PedidoDeConsulta, userId: string, hoje: string): boolean {
  const de = dia(pedido.de)
  const ate = dia(pedido.ate)
  if (!de || de < hoje) return true          // sem início, ou começando antes de hoje
  if (ate && ate > hoje) return true         // futuro também é fora do dia
  if (pedido.emissor && pedido.emissor !== userId) return true
  if (pedido.emissor === null || pedido.emissor === undefined) return true
  return false
}

export function decidirConsulta(
  pedido: PedidoDeConsulta,
  quem: QuemConsulta,
  hoje: string,
): Decisao {
  const status = statusDaSituacao(pedido.situacao)
  const amplo = pedidoEhAmplo(pedido, quem.userId, hoje)

  // O SÓCIO é o único sem limite. É a frase do dono, e ela vale literalmente:
  // sem janela, sem motivo, sem pedir nada a ninguém.
  if (quem.nivel === 'owner') {
    return {
      amplo, precisaAutorizacao: false, motivo: null,
      filtro: { createdBy: pedido.emissor ?? null, de: dia(pedido.de), ate: dia(pedido.ate), status },
    }
  }

  if (!amplo) {
    // O dia de hoje, as próprias faturas: o trabalho normal, sem cerimônia.
    return {
      amplo: false, precisaAutorizacao: false, motivo: null,
      filtro: { createdBy: quem.userId, de: hoje, ate: hoje, status },
    }
  }

  // Daqui para baixo o pedido é amplo. Quem tem a concessão individual
  // (`verTodasFaturas`) não precisa de um SEGUNDO para liberar — mas a
  // consulta continua sendo registrada: a concessão dispensa a autorização,
  // não o rastro.
  if (quem.verTodas || quem.autorizado) {
    return {
      amplo: true, precisaAutorizacao: false, motivo: null,
      filtro: { createdBy: pedido.emissor ?? null, de: dia(pedido.de), ate: dia(pedido.ate), status },
    }
  }

  return {
    amplo: true,
    precisaAutorizacao: true,
    motivo: 'Ver fatura de outro dia ou de outra pessoa precisa de autorização de gerente ou sócio, com motivo.',
    // O filtro seguro: se a rota resolver responder assim mesmo, responde o
    // que a pessoa já podia ver. Recusa é melhor, mas o padrão nunca pode
    // ser "mostra tudo".
    filtro: { createdBy: quem.userId, de: hoje, ate: hoje, status },
  }
}

/** Minutos que uma autorização de consulta vale. */
export const MINUTOS_DA_JANELA = 30

export function janelaViva(expiraEm: unknown, agora: Date = new Date()): boolean {
  if (!expiraEm) return false
  const t = new Date(String(expiraEm)).getTime()
  return Number.isFinite(t) && t > agora.getTime()
}
