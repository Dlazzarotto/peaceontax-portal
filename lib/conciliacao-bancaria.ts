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
