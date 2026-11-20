// lib/conciliacao-bancaria.ts — a conta da conciliação bancária, num lugar só.
//
// A tela e a rota calculavam a diferença cada uma do seu jeito. A tela somava
// a lista que tinha carregado. A rota pedia ao banco os marcados PELOS IDS, numa
// URL só — e com um ano de conta corrente de empresa (965 lançamentos, cada id
// com 36 caracteres) o pedido passava do tamanho que o Supabase aceita, a
// consulta falhava, o erro era ignorado e a soma virava ZERO. A tela mostrava
// "diferença ✓ 0.00" e a rota recusava "Ainda há diferença de $3635.15" — que
// era só saldo inicial menos saldo final.
//
// Agora as duas chamam `apurarConciliacao`, e a rota lê os elegíveis pelo
// FILTRO (conta, data, situação), paginado, sem lista de ids na URL. Marcado
// que não está entre os elegíveis (apagado, devolvido à fila, já numa
// conciliação fechada) não é somado em silêncio nem ignorado: vem em
// `naoElegiveis`, e a rota recusa dizendo para carregar de novo.
//
// Tudo em CENTAVOS: são centenas de valores somados, e `fecha` compara com
// zero exato, não com uma tolerância em dólar.

export interface LancamentoDaConciliacao { id: string; amount: number | string | null }

export interface ApuracaoDaConciliacao {
  /** Soma das entradas marcadas (positiva), em dólar. */
  entradas: number
  /** Soma das saídas marcadas (negativa), em dólar. */
  saidas: number
  qtdEntradas: number
  qtdSaidas: number
  /** entradas + saídas: o que os marcados movem no saldo. */
  total: number
  /** saldo inicial + total. */
  saldoCalculado: number
  /** saldo inicial + total − saldo final. Zero fecha. */
  diferenca: number
  fecha: boolean
  /** Ids marcados que não estão entre os elegíveis. */
  naoElegiveis: string[]
}

const centavos = (v: unknown): number => {
  const n = Math.round(Number(v) * 100)
  return Number.isFinite(n) ? n : 0
}
const dolares = (c: number) => c / 100

export function apurarConciliacao(p: {
  saldoInicial: unknown
  saldoFinal: unknown
  elegiveis: LancamentoDaConciliacao[]
  marcados: Iterable<string>
}): ApuracaoDaConciliacao {
  const porId = new Map<string, LancamentoDaConciliacao>()
  for (const t of p.elegiveis || []) porId.set(String(t.id), t)

  let entradas = 0, saidas = 0, qtdEntradas = 0, qtdSaidas = 0
  const vistos = new Set<string>()
  const naoElegiveis: string[] = []
  for (const bruto of Array.from(p.marcados || [])) {
    const id = String(bruto)
    if (vistos.has(id)) continue          // o mesmo id duas vezes conta uma
    vistos.add(id)
    const t = porId.get(id)
    if (!t) { naoElegiveis.push(id); continue }
    const c = centavos(t.amount)
    if (c > 0) { entradas += c; qtdEntradas++ }
    else if (c < 0) { saidas += c; qtdSaidas++ }
  }

  const total = entradas + saidas
  const saldoCalculado = centavos(p.saldoInicial) + total
  const diferenca = saldoCalculado - centavos(p.saldoFinal)
  return {
    entradas: dolares(entradas), saidas: dolares(saidas), qtdEntradas, qtdSaidas,
    total: dolares(total), saldoCalculado: dolares(saldoCalculado),
    diferenca: dolares(diferenca), fecha: diferenca === 0,
    naoElegiveis,
  }
}

/**
 * Lotes para gravar a marca nos lançamentos. O `update ... in (ids)` vai na
 * URL; 100 ids de 36 caracteres dão ~3,8 KB, longe do limite do gateway — o
 * lote de 500 da primeira versão passava de 18 KB.
 */
export const LOTE_DA_MARCACAO = 100

export function emLotes<T>(itens: T[], tamanho = LOTE_DA_MARCACAO): T[][] {
  const lotes: T[][] = []
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho))
  return lotes
}

// ── O que a rota devolve à tela ─────────────────────────────────────────────
//
// Depois do PR que passou a ler TODOS os elegíveis, a tela parou de carregar.
// Duas causas, as duas reproduzidas, e nenhuma delas dava para ver de fora:
//
// 1. `bank_reconciliations` nasceu no PAINEL do Supabase, não num `.sql`. O
//    histórico pedia colunas por nome (`completed_at`, `cleared_count`…), e a
//    versão antiga IGNORAVA o erro — se faltasse uma, o histórico vinha vazio
//    e os lançamentos apareciam do mesmo jeito. A nova passou a conferir o erro
//    (certo) ANTES de ler os lançamentos (errado): uma coluna que o painel não
//    criou derrubava a tela inteira. Agora o histórico é `select('*')`, que não
//    depende de coluna nenhuma, e `normalizarConciliacao` lê o que vier.
//
// 2. O volume. O `.limit(5000)` antigo parava em mil (o teto do PostgREST) e a
//    resposta era pequena por acidente. Lendo tudo, uma conta com anos de
//    extrato devolve megabytes — e a Vercel recusa resposta acima de 4,5 MB
//    com uma PÁGINA de erro, que a tela tentava ler como JSON. Agora: o filtro
//    "ainda não conciliado" vai na CONSULTA (antes vinha tudo e se filtrava
//    aqui), só as colunas que a tela mostra, e um teto com mensagem que diz o
//    que fazer, no lugar de uma falha que ninguém entende.

/** 'YYYY-MM-DD' do que o banco devolveu (`date` ou `timestamptz`), ou null. */
export function dataISO(v: unknown): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ''))
  return m ? m[1] : null
}

export interface ConciliacaoDaConta {
  id: string
  statement_date: string | null
  beginning_balance: number | null
  ending_balance: number | null
  cleared_count: number | null
  status: string
  completed_at: string | null
}

const numeroOuNulo = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Uma linha de `bank_reconciliations` lida com `select('*')`, no formato da
 * tela. Coluna que o banco não tem vira null — nunca derruba a leitura. A
 * data vem cortada em 'YYYY-MM-DD': se o painel criou a coluna como
 * `timestamptz`, o valor chegava '2026-10-31T00:00:00+00:00', o campo de data
 * da tela ficava em branco e a rota recusava a data.
 */
export function normalizarConciliacao(r: any): ConciliacaoDaConta {
  return {
    id: String(r?.id ?? ''),
    statement_date: dataISO(r?.statement_date),
    beginning_balance: numeroOuNulo(r?.beginning_balance),
    ending_balance: numeroOuNulo(r?.ending_balance),
    cleared_count: numeroOuNulo(r?.cleared_count),
    status: String(r?.status ?? ''),
    completed_at: r?.completed_at ? String(r.completed_at) : null,
  }
}

/**
 * Os livres e os da conciliação em andamento, numa lista só: sem repetir id e
 * na ordem da tela (data, depois id — a mesma do banco, para a lista não mudar
 * de ordem entre um carregamento e outro).
 */
export function juntarElegiveis<T extends { id: unknown; tx_date?: unknown }>(...listas: (T[] | null | undefined)[]): T[] {
  const porId = new Map<string, T>()
  for (const lista of listas) for (const t of lista || []) {
    const id = String(t.id)
    if (!porId.has(id)) porId.set(id, t)
  }
  return Array.from(porId.values()).sort((a, b) => {
    const da = String(a.tx_date ?? ''), db = String(b.tx_date ?? '')
    if (da !== db) return da < db ? -1 : 1
    const ia = String(a.id), ib = String(b.id)
    return ia < ib ? -1 : ia > ib ? 1 : 0
  })
}

/**
 * Quanto da descrição vai para a tela. Ela mostra 70 caracteres; a descrição
 * do extrato de banco chega a 300 ("ORIG CO NAME:… TRACE#:… IND ID:…") e era
 * o que mais pesava na resposta. A descrição inteira continua no Banking.
 */
export const DESCRICAO_NA_TELA = 100

/** A linha como vai para a tela: a descrição cortada, o resto como veio. */
export function linhaParaATela<T extends { description?: unknown }>(t: T): T {
  const d = t.description == null ? t.description : String(t.description)
  return typeof d === 'string' && d.length > DESCRICAO_NA_TELA ? { ...t, description: d.slice(0, DESCRICAO_NA_TELA) } : t
}

/**
 * Teto do corpo da resposta, em bytes. A Vercel recusa acima de 4,5 MB
 * (FUNCTION_PAYLOAD_TOO_LARGE); a folga é para o que não é lançamento.
 */
export const TETO_DA_RESPOSTA = 4_000_000

/**
 * Acima disto nem se lê: seriam dezenas de idas ao banco para recusar no fim.
 * Medido na tela, em produção: 12 mil linhas aparecem em ~3 s; o teto de bytes
 * acima é quem segura de verdade (descrição comprida pesa mais).
 */
export const TETO_DE_LANCAMENTOS = 15_000

const fmtData = (iso: string) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-')
  return y && m && d ? `${m}/${d}/${y}` : String(iso)
}

/**
 * A recusa por volume diz quantos são e o que fazer. Conciliar é por EXTRATO:
 * escolher como data final a do primeiro extrato ainda não conciliado traz só
 * o que vai até ele, e cada conciliação fechada tira os seus da lista.
 */
export function mensagemDeExcesso(total: number, statementDate: string): string {
  const qtd = Number.isFinite(total) && total > 0 ? total.toLocaleString('pt-BR') : 'muitos'
  return `Esta conta tem ${qtd} lançamentos aprovados e ainda não conciliados até ${fmtData(statementDate)} — `
    + 'mais do que dá para trazer de uma vez. Concilie por partes: use como data final a do primeiro extrato '
    + 'que ainda não foi conciliado, feche essa conciliação e siga para o extrato seguinte.'
}

// ── Gravar sem as colunas que o painel não criou ───────────────────────────
//
// A tabela nasceu no painel, e o que a rota grava (`completed_at`, `difference`,
// `created_by`…) pode não estar lá. Sem isto, "Concluir" falhava por causa de
// uma coluna informativa. Só se dispensa coluna OPCIONAL: sem as essenciais a
// conciliação não existe, e aí é erro mesmo. Quem chama recebe a lista do que
// ficou de fora e AVISA (rodar sql/conciliacao-bancaria-v1.sql) — tolerar não é
// esconder.

/** Sem estes campos a conciliação não existe: faltar um é erro, não "sem a coluna". */
export const CAMPOS_ESSENCIAIS = ['client_id', 'account_id', 'statement_date', 'beginning_balance', 'ending_balance', 'status']

export async function gravarSemColunasAusentes<R>(
  campos: Record<string, unknown>,
  grava: (c: Record<string, unknown>) => PromiseLike<{ data: R | null; error: any }>,
  colunaAusente: (e: any) => string | null,
  essenciais: string[] = CAMPOS_ESSENCIAIS,
): Promise<{ data: R | null; error: any; semColuna: string[] }> {
  let atuais: Record<string, unknown> = { ...campos }
  const semColuna: string[] = []
  // Cada volta tira UMA coluna; mais voltas do que campos seria laço sem fim.
  for (let volta = 0; volta <= Object.keys(campos).length; volta++) {
    // Sobrou nada para gravar (o único campo era opcional e o banco não o
    // tem): não há escrita a fazer — gravar `{}` seria pedir erro.
    if (!Object.keys(atuais).length) return { data: null, error: null, semColuna }
    const { data, error } = await grava(atuais)
    if (!error) return { data, error: null, semColuna }
    const col = colunaAusente(error)
    if (!col || !(col in atuais) || essenciais.includes(col)) return { data: null, error, semColuna }
    semColuna.push(col)
    const resto = { ...atuais }
    delete resto[col]
    atuais = resto
  }
  return { data: null, error: { message: 'colunas demais faltando em bank_reconciliations' }, semColuna }
}

/** O aviso que acompanha a gravação feita sem alguma coluna. */
export function avisoDeColunas(semColuna: string[]): string | null {
  if (!semColuna.length) return null
  return `Gravado sem ${semColuna.join(', ')}: o banco ainda não tem ${semColuna.length > 1 ? 'essas colunas' : 'essa coluna'}. `
    + 'Rode a migração sql/conciliacao-bancaria-v1.sql.'
}
