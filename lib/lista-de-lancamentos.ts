// lib/lista-de-lancamentos.ts — a lista do Banking/Registro e os números em volta dela.
//
// "O Plaid não traz as transações anteriores a 20/05/2025" era a TELA
// escondendo. A rota pedia `.limit(8000)` e o PostgREST devolve no máximo MIL
// linhas, sem avisar. Da lista cortada a tela tirava tudo o que mostrava: as
// abas (Reconhecidas · Não reconhecidas · Excluídas · Registro), o quadro
// "Transações" (travado em 1000), os cartões das contas, os ANOS do seletor e
// quais extratos já foram importados. Com ~1,8 transação por dia, a milésima
// mais recente cai em 20/05/2025 — reproduzido com 24 meses de Plaid. E o ano
// anterior nem aparecia no seletor, porque os anos vinham da própria lista
// cortada: o que passava do corte ficava inalcançável pela tela.
//
// Agora: a lista é POR ABA (o grupo de status dela), com teto declarado; os
// números (abas, resumo, cartões) são contados sobre TUDO, numa leitura leve e
// paginada no servidor; os anos vêm do banco; e passar do teto vira AVISO,
// nunca silêncio. Quem trabalha a fila aprova o que está na tela e o que sai
// da aba abre espaço para as seguintes.
//
// Módulo puro: a rota e a tela chamam as mesmas funções.

export type Grupo = 'recognized' | 'unrecognized' | 'register' | 'excluded'

/** Os status de cada aba. A tela filtrava assim no navegador; agora o servidor filtra igual. */
export const STATUS_DO_GRUPO: Record<Grupo, readonly string[]> = {
  recognized: ['auto'],
  unrecognized: ['pending'],
  register: ['approved', 'reviewed'],
  excluded: ['excluded'],
}

export const GRUPOS = Object.keys(STATUS_DO_GRUPO) as Grupo[]

export const ehGrupo = (v: unknown): v is Grupo => typeof v === 'string' && (GRUPOS as string[]).includes(v)

export function grupoDoStatus(status: unknown): Grupo | null {
  for (const g of GRUPOS) if (STATUS_DO_GRUPO[g].includes(String(status))) return g
  return null
}

/**
 * Teto da lista de UMA aba. É a página do PostgREST (que corta em mil de
 * qualquer jeito) e é também o que a tabela aguenta desenhar: cada linha leva
 * os seletores de conta, e mil linhas já são ~1,5 s de desenho. Passar dele
 * não esconde nada: a resposta diz quantas há e a tela avisa.
 */
export const LIMITE_DA_LISTA = 1000

export interface LinhaLeve {
  account_id: string | null
  status: string | null
  amount: number | string | null
  tx_date: string | null
  balance: number | string | null
}

export interface CartaoDaConta {
  total: number
  forReview: number
  inRegister: number
  lastBalance: number | null
  lastDate: string | null
}

export interface ResumoDosLancamentos {
  contagens: Record<Grupo, number> & { total: number }
  summary: { total: number; pending: number; credits: number; debits: number }
  cartoes: Record<string, CartaoDaConta>
}

const centavos = (v: unknown): number => {
  const n = Math.round(Number(v) * 100)
  return Number.isFinite(n) ? n : 0
}

export const cartaoVazio = (): CartaoDaConta => ({ total: 0, forReview: 0, inRegister: 0, lastBalance: null, lastDate: null })

/**
 * Os números da tela, contados sobre TODAS as linhas do filtro de ano — nunca
 * sobre a lista que a tela recebeu. `conta` (a escolhida nos cartões) vale
 * para as abas e o resumo; os cartões mostram todas as contas, como antes.
 * Mesma semântica de antes, só que completa: o resumo inclui todos os status,
 * e o saldo do cartão é o da linha mais recente que traz saldo.
 */
export function resumirLancamentos(linhas: LinhaLeve[] | null | undefined, conta: string | null): ResumoDosLancamentos {
  const contagens = { recognized: 0, unrecognized: 0, register: 0, excluded: 0, total: 0 }
  let pending = 0, credits = 0, debits = 0
  const cartoes: Record<string, CartaoDaConta> = {}
  for (const t of linhas || []) {
    const acc = t.account_id ? String(t.account_id) : null
    const g = grupoDoStatus(t.status)
    if (acc) {
      const c = (cartoes[acc] ||= cartaoVazio())
      c.total++
      if (g === 'recognized' || g === 'unrecognized') c.forReview++
      if (g === 'register') c.inRegister++
      const data = t.tx_date ? String(t.tx_date).slice(0, 10) : null
      if (t.balance != null && t.balance !== '' && data && (!c.lastDate || data > c.lastDate)) {
        c.lastDate = data
        c.lastBalance = Number(t.balance)
      }
    }
    if (conta && acc !== conta) continue
    contagens.total++
    if (g) contagens[g]++
    if (t.status === 'pending') pending++
    const v = centavos(t.amount)
    if (v > 0) credits += v
    else if (v < 0) debits += v
  }
  return { contagens, summary: { total: contagens.total, pending, credits: credits / 100, debits: debits / 100 }, cartoes }
}

/**
 * Os anos do seletor, do mais recente ao mais antigo que EXISTE no banco.
 * Vinham da lista cortada: o ano que ficava todo depois do corte não aparecia
 * para ser escolhido.
 */
export function anosEntre(min: unknown, max: unknown): number[] {
  const a = parseInt(String(min ?? ''), 10), b = parseInt(String(max ?? ''), 10)
  if (!Number.isFinite(b)) return Number.isFinite(a) ? [a] : []
  if (!Number.isFinite(a) || a > b || b - a > 60) return [b]
  return Array.from({ length: b - a + 1 }, (_, i) => b - i)
}

const fmtData = (iso: string) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-')
  return y && m && d ? `${m}/${d}/${y}` : String(iso)
}

/**
 * O aviso quando a aba tem mais do que a lista traz; null quando cabe. Diz
 * quantas há, de quando é a mais antiga na tela e como chegar às anteriores.
 */
export function avisoDaLista(p: { mostrando: number; total: number; maisAntiga: string | null; anoEscolhido: boolean }): string | null {
  if (!(p.total > p.mostrando)) return null
  const n = (x: number) => x.toLocaleString('pt-BR')
  return `Mostrando as ${n(p.mostrando)} mais recentes de ${n(p.total)} nesta aba`
    + (p.maisAntiga ? ` — de ${fmtData(p.maisAntiga)} em diante` : '')
    + '. Para chegar às anteriores, '
    + (p.anoEscolhido ? 'escolha uma conta nos cartões acima' : 'escolha o ano no seletor ou uma conta nos cartões acima')
    + ' — ou trabalhe as da tela: o que sai desta aba abre espaço para as seguintes.'
}
