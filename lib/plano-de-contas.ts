// lib/plano-de-contas.ts — o que pode mudar numa conta do plano, e o que a
// mudança leva junto. Módulo puro: a rota (/api/bookkeeping/categories) e a
// tela (/dashboard/accounts) chamam as MESMAS funções. A tela mostra antes o
// que vai acontecer; a rota decide; o banco grava numa transação só
// (sql/plano-de-contas-edicao-funcao-v1.sql).
//
// Três fatos do sistema desenham as regras:
//
//  1. O lançamento guarda o NOME da conta (`bank_transactions.category`), não
//     o id. Renomear leva junto lançamentos, regras e contas a pagar — e tem
//     de ser tudo junto: o P&L trata conta que não está no plano como
//     DESPESA (`kindMap[c] || 'expense'`), então um renomear pela metade
//     manda a receita da conta antiga para as despesas de todos os clientes.
//  2. Pelo mesmo motivo, as contas cujo nome o CÓDIGO grava não mudam de
//     nome, de grupo nem saem do plano (`CONTAS_DO_SISTEMA`). Renomear
//     'Transfer' faria toda transferência nova entrar como despesa.
//  3. Sub-conta é "Mãe: Filha" no nome, um nível só e no MESMO grupo da mãe:
//     o P&L agrupa pelo prefixo. Mudar o grupo da mãe leva as filhas junto.

import { CONTA_DO_RECEBIMENTO, CONTA_DA_TAXA, CONTA_DO_DEPOSITO } from './deposito-match.ts'
import { ehContaDeDespesa, formularioDoPedido, type Formulario1099 } from './relatorio-1099.ts'

export const GRUPOS_DO_PLANO = [
  'income', 'cogs', 'expense', 'other_income', 'other_expense', 'liability', 'asset', 'non_pnl',
] as const
export type GrupoDoPlano = (typeof GRUPOS_DO_PLANO)[number]

export const ROTULO_DO_GRUPO: Record<GrupoDoPlano, string> = {
  income:        'Receitas',
  cogs:          'Custo dos serviços',
  expense:       'Despesas',
  other_income:  'Outras receitas',
  other_expense: 'Outras despesas',
  liability:     'Passivo',
  asset:         'Ativo',
  non_pnl:       'Fora do resultado',
}

export function ehGrupoDoPlano(k: unknown): k is GrupoDoPlano {
  return (GRUPOS_DO_PLANO as readonly string[]).includes(String(k ?? ''))
}

function rotulo(k: string): string {
  return ehGrupoDoPlano(k) ? ROTULO_DO_GRUPO[k] : k
}

/**
 * As contas cujo nome o código grava, e quem grava. 'Transfer' e
 * 'Credit Card Payment' estão escritas à mão nos três pontos do motor
 * (lib/apply-rules.ts, categorize e rules) — que precisam continuar
 * idênticos, por isso não viram constante importada daqui.
 */
export const CONTAS_DO_SISTEMA: Record<string, string> = {
  'Transfer':            'o motor grava este nome em toda transferência entre contas do próprio cliente',
  'Credit Card Payment': 'o motor grava este nome em todo pagamento de cartão de crédito',
  [CONTA_DO_RECEBIMENTO]: 'o caixa da firma lança aqui cada recebimento de fatura',
  [CONTA_DA_TAXA]:        'a conciliação do depósito lança aqui a taxa do Stripe',
  [CONTA_DO_DEPOSITO]:    'a conciliação do depósito lança aqui a saída da conta de passagem',
}

/** Por que a conta é do sistema, ou null. */
export function contaDoSistema(nome: string): string | null {
  return Object.prototype.hasOwnProperty.call(CONTAS_DO_SISTEMA, nome) ? CONTAS_DO_SISTEMA[nome] : null
}

/** "Mãe: Filha" → { mae: 'Mãe', base: 'Filha' }; "Conta" → { mae: null, base: 'Conta' }. */
export function partesDoNome(nome: string): { mae: string | null; base: string } {
  const i = nome.indexOf(':')
  if (i < 0) return { mae: null, base: nome.trim() }
  return { mae: nome.slice(0, i).trim(), base: nome.slice(i + 1).trim() }
}

export function nomeCompleto(base: string, mae: string | null): string {
  return mae ? `${mae}: ${base}` : base
}

/**
 * Chave para dizer se dois nomes são a mesma conta: sem diferença de
 * maiúscula, acento e espaço. "Office supplies" ao lado de "Office Supplies"
 * divide o P&L de todos os clientes em duas linhas que parecem uma.
 */
export function chaveDaConta(nome: string): string {
  return String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Nome digitado (sem a mãe). Devolve o motivo da recusa, ou null. */
export function recusaDoNome(base: string): string | null {
  if (base.length < 2 || base.length > 60) return 'Nome: 2 a 60 caracteres.'
  if (base.includes(':')) return 'Não use ":" no nome — para fazer sub-conta, escolha a conta-mãe.'
  return null
}

/** Motivo de mudança que alcança o livro: o mesmo mínimo das outras trilhas da casa. */
export const MOTIVO_MINIMO = 5

export interface ContaDoPlano {
  id: string
  name: string
  kind: string
  active: boolean
  form_1099?: string | null
}

/** As sub-contas de uma conta, pelo prefixo exato (sem curinga de LIKE). */
export function filhasDe(conta: { id: string; name: string }, plano: ContaDoPlano[]): ContaDoPlano[] {
  const prefixo = `${conta.name}: `
  return plano.filter(c => c.id !== conta.id && c.name.startsWith(prefixo))
}

/** Conta com o mesmo nome (pela chave), fora as que a própria edição move. */
function jaExiste(nome: string, plano: ContaDoPlano[], fora: Set<string>): ContaDoPlano | undefined {
  const k = chaveDaConta(nome)
  return plano.find(c => !fora.has(c.id) && chaveDaConta(c.name) === k)
}

type Recusa = { ok: false; erro: string; status: 400 | 409 }
const recusa = (erro: string, status: 400 | 409 = 400): Recusa => ({ ok: false, erro, status })

export interface PedidoDeEdicao {
  /** O nome sem a mãe. Ausente = mantém. */
  nome?: unknown
  /** O grupo. Ausente = mantém. Numa sub-conta, o grupo é o da mãe. */
  kind?: unknown
  /** O nome da conta-mãe; null ou '' = conta principal. Ausente = mantém. */
  mae?: unknown
  /** 'NEC' | 'MISC' | null. Ausente = mantém (e sai do 1099 se o grupo deixar de ser despesa). */
  form1099?: unknown
}

export interface PlanoDaEdicao {
  ok: true
  /** Nome completo depois da edição ("Mãe: Filha" ou "Conta"). */
  nome: string
  kind: GrupoDoPlano
  form1099: Formulario1099 | null
  mudouNome: boolean
  mudouGrupo: boolean
  mudouMae: boolean
  mudou1099: boolean
  /** Sub-contas que acompanham a mudança, com o nome de antes e o de depois. */
  filhas: { id: string; de: string; para: string }[]
  /** Sub-contas que estavam no 1099 e saem porque o grupo deixou de ser despesa. */
  filhasSaemDo1099: number
  /** Lançamentos da conta e das sub-contas: é o que a mudança alcança no livro. */
  lancamentos: number
  /** Conta em uso mudando de nome, grupo ou mãe: o livro de todos os clientes muda. */
  exigeMotivo: boolean
  /**
   * Conta em uso mudando de GRUPO: os números do P&L e do Balanço de
   * períodos passados mudam, inclusive de anos já declarados. Ação
   * sensível (princípio 3): senha e motivo.
   */
  exigeSenha: boolean
  /** O que muda, em uma linha: vai para a tela, para a trilha e para a resposta. */
  resumo: string
  avisos: string[]
}

/**
 * Decide o que uma edição faz, antes de gravar. A rota recusa o que isto
 * recusa; a tela mostra o que isto prevê. A função do banco confere de novo o
 * que pode ter mudado entre a leitura e a gravação (mãe renomeada, nome
 * tomado por outra pessoa no meio).
 */
export function planoDaEdicao(args: {
  conta: ContaDoPlano
  pedido: PedidoDeEdicao
  plano: ContaDoPlano[]
  /** Lançamentos por nome de conta (o `usos` do GET ?all=1). */
  usos: Record<string, number>
}): PlanoDaEdicao | Recusa {
  const { conta, pedido, plano, usos } = args
  const atual = partesDoNome(conta.name)
  const filhasAtuais = filhasDe(conta, plano)

  // Nome
  let base = atual.base
  if (pedido.nome !== undefined) {
    base = String(pedido.nome ?? '').trim()
    const r = recusaDoNome(base)
    if (r) return recusa(r)
  }

  // Conta-mãe
  let mae = atual.mae
  if (pedido.mae !== undefined) {
    const m = pedido.mae === null ? '' : String(pedido.mae).trim()
    mae = m || null
  }
  let contaMae: ContaDoPlano | undefined
  if (mae) {
    if (mae === conta.name) return recusa('Uma conta não pode ser sub-conta dela mesma.')
    contaMae = plano.find(c => c.name === mae)
    if (!contaMae) return recusa(`Conta-mãe "${mae}" não encontrada.`)
    if (contaMae.name.includes(':')) return recusa(`"${mae}" já é sub-conta: o plano tem um nível de sub-conta só.`)
    if (!contaMae.active) return recusa(`A conta-mãe "${mae}" está inativa. Reative-a ou escolha outra.`)
    if (filhasAtuais.length > 0 && mae !== atual.mae) {
      return recusa(`"${conta.name}" tem ${filhasAtuais.length} sub-conta(s): conta com sub-contas não vira sub-conta (o plano tem um nível só).`, 409)
    }
  }

  // Grupo: na sub-conta, é o da mãe
  let kind: string = conta.kind
  if (contaMae) {
    if (pedido.kind !== undefined && String(pedido.kind) !== contaMae.kind) {
      return recusa(`A sub-conta fica no grupo da conta-mãe (${rotulo(contaMae.kind)}). Para mudar o grupo, escolha outra conta-mãe ou deixe como conta principal.`)
    }
    kind = contaMae.kind
  } else if (pedido.kind !== undefined) {
    if (!ehGrupoDoPlano(pedido.kind)) return recusa('Grupo inválido.')
    kind = pedido.kind
  }
  if (!ehGrupoDoPlano(kind)) return recusa(`A conta está num grupo desconhecido ("${kind}"). Escolha o grupo.`)

  const nome = nomeCompleto(base, mae)
  const mudouNome = nome !== conta.name
  const mudouMae = (mae ?? null) !== (atual.mae ?? null)
  const mudouGrupo = kind !== conta.kind

  // Conta do sistema: o código grava o nome dela
  const sistema = contaDoSistema(conta.name)
  if (sistema && (mudouNome || mudouGrupo)) {
    return recusa(`"${conta.name}" é conta do sistema: ${sistema}. Nome, grupo e conta-mãe dela não mudam.`, 409)
  }

  // 1099: só em despesa; o grupo que deixa de ser despesa leva a marca embora
  const marcaAtual = formularioDoPedido(conta.form_1099 ?? null) ?? null
  let form1099: Formulario1099 | null
  if (pedido.form1099 !== undefined) {
    const f = formularioDoPedido(pedido.form1099)
    if (f === undefined) return recusa('Formulário do 1099 inválido: use NEC, MISC ou nenhum.')
    if (f && !ehContaDeDespesa(kind)) return recusa('Só conta de despesa vai para o 1099.')
    form1099 = f
  } else {
    form1099 = ehContaDeDespesa(kind) ? marcaAtual : null
  }
  const mudou1099 = form1099 !== marcaAtual

  if (!mudouNome && !mudouGrupo && !mudou1099) return recusa('Nada para alterar.')

  // Sub-contas: acompanham o nome e o grupo da mãe
  const filhas = mudouNome
    ? filhasAtuais.map(f => ({ id: f.id, de: f.name, para: `${nome}: ${partesDoNome(f.name).base}` }))
    : filhasAtuais.map(f => ({ id: f.id, de: f.name, para: f.name }))
  const filhasSaemDo1099 = mudouGrupo && !ehContaDeDespesa(kind)
    ? filhasAtuais.filter(f => !!f.form_1099).length : 0

  // Nome repetido, contado sem maiúscula nem acento. As contas que a própria
  // edição move não contam (corrigir "office supplies" para "Office
  // Supplies" é permitido).
  if (mudouNome) {
    const fora = new Set([conta.id, ...filhasAtuais.map(f => f.id)])
    const igual = jaExiste(nome, plano, fora)
    if (igual) {
      return recusa(`Já existe a conta "${igual.name}". Para juntar as duas, apague esta e mova os lançamentos para lá.`, 409)
    }
    for (const f of filhas) {
      const ja = jaExiste(f.para, plano, fora)
      if (ja) return recusa(`A sub-conta "${f.de}" viraria "${f.para}", e já existe "${ja.name}".`, 409)
    }
  }

  const lancamentos = (usos[conta.name] || 0) + filhasAtuais.reduce((s, f) => s + (usos[f.name] || 0), 0)
  const mexeNoLivro = mudouNome || mudouGrupo
  const exigeMotivo = mexeNoLivro && lancamentos > 0
  const exigeSenha = mudouGrupo && lancamentos > 0

  const partes: string[] = []
  if (mudouNome) partes.push(`nome: "${conta.name}" → "${nome}"`)
  if (mudouGrupo) partes.push(`grupo: ${rotulo(conta.kind)} → ${rotulo(kind)}`)
  if (mudou1099) partes.push(`1099: ${marcaAtual ? `1099-${marcaAtual}` : 'fora'} → ${form1099 ? `1099-${form1099}` : 'fora'}`)

  const avisos: string[] = []
  // Dado antigo: a rota deixava mudar o grupo da sub-conta sozinha. Editar
  // uma assim a devolve ao grupo da mãe — dito antes, nunca em silêncio.
  if (contaMae && conta.kind !== contaMae.kind && pedido.kind === undefined) {
    avisos.push(`Esta sub-conta estava em ${rotulo(conta.kind)}, e a mãe em ${rotulo(contaMae.kind)}: ela passa para o grupo da mãe.`)
  }
  if (mudouGrupo && lancamentos > 0) {
    avisos.push(`Mudar o grupo muda os relatórios de TODOS os clientes, inclusive de períodos já fechados e declarados: ${lancamentos} lançamento(s) passam de ${rotulo(conta.kind)} para ${rotulo(kind)}.`)
  }
  if (mudouNome && lancamentos > 0) {
    avisos.push(`${lancamentos} lançamento(s), as regras e as contas a pagar passam a usar o nome novo.`)
  }
  if (filhas.length > 0 && (mudouNome || mudouGrupo)) {
    avisos.push(`${filhas.length} sub-conta(s) acompanham${mudouGrupo ? ' a mudança de grupo' : ' o nome novo'}.`)
  }
  if (marcaAtual && !form1099 && pedido.form1099 === undefined) {
    avisos.push('A conta sai do 1099: o grupo novo não é de despesa.')
  }
  if (filhasSaemDo1099 > 0) {
    avisos.push(`${filhasSaemDo1099} sub-conta(s) saem do 1099: o grupo novo não é de despesa.`)
  }

  return {
    ok: true, nome, kind, form1099,
    mudouNome, mudouGrupo, mudouMae, mudou1099,
    filhas: mudouNome || mudouGrupo ? filhas : [],
    filhasSaemDo1099, lancamentos,
    exigeMotivo, exigeSenha,
    resumo: partes.join(' · '),
    avisos,
  }
}

/**
 * O que o formulário da tela manda: só o que mudou, porque campo ausente é
 * "mantém" para `planoDaEdicao`. `form.mae` vazio é conta principal;
 * `form.kind` vazio é "não escolhi" (conta em grupo desconhecido).
 */
export function pedidoDoFormulario(
  conta: ContaDoPlano,
  form: { nome: string; mae: string; kind: string; form1099: string },
  plano: ContaDoPlano[],
  com1099: boolean,
): PedidoDeEdicao {
  const atual = partesDoNome(conta.name)
  const mae = form.mae ? plano.find(x => x.name === form.mae) : undefined
  const kindFinal = form.mae ? (mae?.kind ?? conta.kind) : (form.kind || conta.kind)
  const pedido: PedidoDeEdicao = {}
  if (form.nome.trim() !== atual.base) pedido.nome = form.nome
  if (form.mae !== (atual.mae || '')) pedido.mae = form.mae || null
  if (!form.mae && form.kind && form.kind !== conta.kind) pedido.kind = form.kind
  // Grupo novo que não é de despesa: a marca não vai — ela sai sozinha, e a
  // prévia avisa. Mandá-la faria a regra recusar a edição inteira.
  if (com1099 && ehContaDeDespesa(kindFinal) && form.form1099 !== (conta.form_1099 || '')) {
    pedido.form1099 = form.form1099 || null
  }
  return pedido
}

/**
 * Apagar. Conta em uso (lançamento ou regra) só sai com destino: tudo vai
 * para a outra conta antes, senão o lançamento fica com um nome que o plano
 * não tem — e vira despesa no P&L. O destino é do MESMO grupo (senão o
 * relatório muda de seção sem ninguém ter pedido) e ATIVO (o Balanço só lê
 * conta ativa: ativo movido para conta inativa some dele).
 */
export function planoDaRemocao(args: {
  conta: ContaDoPlano
  plano: ContaDoPlano[]
  lancamentos: number
  regras: number
  destino?: string | null
}): { ok: true; destino: string | null; exigeMotivo: boolean } | (Recusa & { emUso?: number }) {
  const { conta, plano, lancamentos, regras } = args
  const sistema = contaDoSistema(conta.name)
  if (sistema) return recusa(`"${conta.name}" é conta do sistema: ${sistema}. Ela não sai do plano.`, 409)

  const filhas = filhasDe(conta, plano)
  if (filhas.length > 0) {
    return recusa(`"${conta.name}" tem ${filhas.length} sub-conta(s). Apague ou mova as sub-contas primeiro.`, 409)
  }

  const destino = String(args.destino ?? '').trim() || null
  if (lancamentos + regras > 0 && !destino) {
    const emUso = [
      lancamentos ? `${lancamentos} lançamento(s)` : '',
      regras ? `${regras} regra(s)` : '',
    ].filter(Boolean).join(' e ')
    return { ...recusa(`"${conta.name}" está em ${emUso}. Escolha para qual conta mover antes de apagar.`, 409), emUso: lancamentos }
  }
  if (destino) {
    if (destino === conta.name) return recusa('A conta de destino é a própria conta.')
    const alvo = plano.find(c => c.name === destino)
    if (!alvo) return recusa(`Conta de destino "${destino}" não encontrada.`)
    if (alvo.kind !== conta.kind) {
      return recusa(`A conta de destino é de outro grupo (${rotulo(alvo.kind)}). Escolha uma de ${rotulo(conta.kind)}, para não distorcer os relatórios.`)
    }
    if (!alvo.active) return recusa(`A conta de destino "${destino}" está inativa. Reative-a ou escolha outra.`)
  }
  return { ok: true, destino, exigeMotivo: lancamentos > 0 }
}

/**
 * Desativar: só a conta que ninguém usa. Lançamento E regra contam — a regra
 * que aponta para uma conta inativa segue lançando nela a cada importação,
 * e a conta some do seletor de quem classifica.
 */
export function recusaDaDesativacao(conta: ContaDoPlano, lancamentos: number, regras: number): string | null {
  const sistema = contaDoSistema(conta.name)
  if (sistema) return `"${conta.name}" é conta do sistema: ${sistema}. Ela não se desativa.`
  if (lancamentos > 0) return `Esta conta está em ${lancamentos} lançamento(s). Reclassifique-os antes de desativar.`
  if (regras > 0) return `${regras} regra(s) classificam nesta conta. Troque a conta delas antes de desativar — senão a importação segue lançando aqui.`
  return null
}
