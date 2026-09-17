// lib/permissoes.ts — autorizações por pessoa, em cima do nível
//
// O sistema tem TRÊS níveis (owner · manager · junior) e eles continuam
// sendo a base. O que muda aqui: o sócio pode AUTORIZAR ou RETIRAR uma
// permissão específica de uma pessoa específica, sem promovê-la de nível.
//
// O caso que originou isto: uma assistente que precisa emitir a fatura E
// receber o pagamento no balcão, mas NUNCA pode ver o total vendido.
// Pelo modelo de níveis isso era impossível — receber exigia virar
// gerente, e gerente é um degrau que traz junto cancelar, apagar e
// estornar.
//
// COMO LÊ
//   1. O nível dá o conjunto base.
//   2. Cada concessão é um SIM ou um NÃO explícito, que vence o nível.
//   3. O sócio nunca perde nada — senão a firma se tranca para fora.
//
// SEPARAÇÃO DE FUNÇÕES (princípio 1 da especificação)
// "Quem emite não dá baixa." Autorizar `receber` ou `estornar` a quem
// também emite quebra essa separação. Não é proibido — é decisão do
// sócio — mas `conflitoDeSeparacao` devolve o texto do que está sendo
// quebrado, a tela mostra antes de salvar e o motivo fica na trilha.
// Autorização assim é decisão registrada, não clique.

import type { StaffLevel } from '@/lib/staff-perms'

export type ChavePermissao =
  | 'criar' | 'enviar' | 'verTodasFaturas' | 'receber' | 'duplicar' | 'editar' | 'estornar'
  | 'cancelar' | 'apagar' | 'darDesconto' | 'editarCliente'
  | 'verRelatorios' | 'verTotais'

export interface Permissao {
  chave: ChavePermissao
  titulo: string
  descricao: string
  /** Aviso de separação de funções quando concedida a quem emite. */
  separacao?: string
}

/** A ordem é a da tela: do dia a dia ao que mexe em dinheiro e em números. */
export const PERMISSOES: Permissao[] = [
  { chave: 'criar',         titulo: 'Emitir orçamento e fatura',
    descricao: 'Preencher e enviar a fatura ao cliente.' },
  { chave: 'enviar',        titulo: 'Enviar a fatura ao cliente',
    descricao: 'Tirar do rascunho: o cliente recebe e-mail e vê em Pagamentos.' },
  { chave: 'verTodasFaturas', titulo: 'Ver as faturas de todo mundo',
    descricao: 'Sem isto, a pessoa vê apenas as faturas que ela mesma emitiu hoje.' },
  { chave: 'receber',       titulo: 'Receber pagamento',
    descricao: 'Dar baixa: dinheiro, cheque, Zelle, cartão no balcão.',
    separacao: 'quem emite a fatura passaria a dar baixa nela' },
  { chave: 'editar',        titulo: 'Editar fatura emitida',
    descricao: 'Alterar valor ou itens depois de enviada. Pede senha e motivo.' },
  { chave: 'duplicar',      titulo: 'Duplicar fatura',
    descricao: 'Copiar uma fatura já emitida para um novo período.' },
  { chave: 'cancelar',      titulo: 'Cancelar fatura',
    descricao: 'Encerrar a cobrança. O documento continua no histórico.' },
  { chave: 'darDesconto',   titulo: 'Conceder desconto',
    descricao: 'Abater valor do que foi orçado.' },
  { chave: 'estornar',      titulo: 'Estornar pagamento',
    descricao: 'Desfazer uma baixa já registrada. Pede senha e motivo.',
    separacao: 'quem recebe passaria a poder desfazer o próprio recebimento' },
  { chave: 'apagar',        titulo: 'Apagar fatura',
    descricao: 'Exceção. Bloqueado quando já houve pagamento.' },
  { chave: 'editarCliente', titulo: 'Editar cadastro do cliente',
    descricao: 'Nome, e-mail, telefone, endereço, EIN. Pede senha e motivo.' },
  { chave: 'verRelatorios', titulo: 'Ver relatórios do faturamento',
    descricao: 'Aging, recorrência, histórico de cobrança.' },
  { chave: 'verTotais',     titulo: 'Ver totais do negócio',
    descricao: 'Quanto a firma faturou. É o "total vendido".' },
]

export const CHAVES = PERMISSOES.map(p => p.chave)

const ehChave = (k: unknown): k is ChavePermissao =>
  typeof k === 'string' && (CHAVES as string[]).includes(k)

export type Concessoes = Partial<Record<ChavePermissao, boolean>>
export type Conjunto = Record<ChavePermissao, boolean>

/** O que cada nível dá por si só, sem nenhuma concessão. */
export function padraoDoNivel(nivel: StaffLevel): Conjunto {
  const senior = nivel === 'owner' || nivel === 'manager'
  return {
    criar:         true,          // todos emitem
    // Enviar é o passo em que o documento deixa de ser rascunho e chega ao
    // cliente. Andava pendurado em `cancelar`: soltar um soltava o outro.
    enviar:        senior,
    // Sem isto, a lista mostra só o que a própria pessoa emitiu HOJE.
    // Quem emite não precisa da carteira inteira à vista para trabalhar.
    verTodasFaturas: senior,
    receber:       senior,
    duplicar:      senior,
    editar:        senior,
    estornar:      senior,
    cancelar:      senior,
    apagar:        senior,
    darDesconto:   senior,
    // Dado de cliente é cadastro, não rascunho: mexe em quem a firma
    // atende e em como ela o alcança.
    editarCliente: senior,
    verRelatorios: nivel === 'owner',
    verTotais:     nivel === 'owner',
  }
}

/**
 * Conjunto final: nível + concessões.
 *
 * O sócio é imune: uma concessão negativa gravada por engano (ou por quem
 * não devia) não tira poder de quem responde pela firma. Tirar acesso de
 * sócio se faz mudando o NÍVEL, à vista, não por uma chave solta.
 */
export function permissoesDe(nivel: StaffLevel, concessoes?: Concessoes | null): Conjunto {
  const base = padraoDoNivel(nivel)
  if (nivel === 'owner' || !concessoes) return base
  for (const k of Object.keys(concessoes)) {
    if (!ehChave(k)) continue
    const v = concessoes[k]
    if (typeof v === 'boolean') base[k] = v
  }
  return base
}

/** Só o que difere do nível vale como concessão — o resto é ruído na trilha. */
export function normalizarConcessoes(nivel: StaffLevel, bruto: any): Concessoes {
  const base = padraoDoNivel(nivel)
  const limpo: Concessoes = {}
  for (const k of CHAVES) {
    const v = bruto?.[k]
    if (typeof v === 'boolean' && v !== base[k]) limpo[k] = v
  }
  return limpo
}

/**
 * O que esta concessão quebra, em uma frase — ou null se não quebra nada.
 * Só vale para SIM: retirar permissão nunca cria conflito.
 */
export function conflitoDeSeparacao(
  chave: ChavePermissao, conceder: boolean, resultado: Conjunto,
): string | null {
  if (!conceder) return null
  const p = PERMISSOES.find(x => x.chave === chave)
  if (!p?.separacao) return null
  if (chave === 'receber'  && !resultado.criar)   return null
  if (chave === 'estornar' && !resultado.receber) return null
  return `Separação de funções: ${p.separacao}.`
}

/** Todos os conflitos de um conjunto já montado — para a tela e a trilha. */
export function conflitosDoConjunto(c: Conjunto): string[] {
  return PERMISSOES
    .map(p => (c[p.chave] ? conflitoDeSeparacao(p.chave, true, c) : null))
    .filter((x): x is string => !!x)
}

/** Resumo de uma linha para a lista da equipe. */
export function resumoDeAcesso(nivel: StaffLevel, concessoes?: Concessoes | null): string {
  const extras = Object.entries(concessoes || {})
  if (!extras.length || nivel === 'owner') return ''
  const mais = extras.filter(([, v]) => v === true).length
  const menos = extras.filter(([, v]) => v === false).length
  const partes: string[] = []
  if (mais)  partes.push(`+${mais} autorização${mais > 1 ? 'ões' : ''}`)
  if (menos) partes.push(`−${menos} retirada${menos > 1 ? 's' : ''}`)
  return partes.join(' · ')
}
