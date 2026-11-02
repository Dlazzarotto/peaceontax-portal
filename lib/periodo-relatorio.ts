// lib/periodo-relatorio.ts — o período de um relatório, num lugar só.
//
// Todo relatório (P&L, Balanço, fornecedores, 1099 e os seis do Financeiro)
// passa a escolher o período do mesmo jeito: um atalho — este mês, mês
// passado, último trimestre, este ano, ano passado — ou duas datas livres.
// A conta de cada atalho mora aqui, pura, e é testada: trimestre e virada de
// ano são o tipo de data que se erra lendo.
//
// `hoje` vem de fora, em 'YYYY-MM-DD', e é o dia do ESCRITÓRIO
// (`dataDaFirma`), não o do navegador nem o do servidor: o atalho "este mês"
// do Financeiro usava `new Date().toISOString()`, que é UTC — às 21h do dia
// 31 em Malden já oferecia o mês seguinte.
//
// Os relatórios contábeis aceitam também `year[&month]`, como antes; a
// conversão para datas é daqui (`periodoDosParametros`, e
// `dataDeCorteDosParametros` para o Balanço, que é "em tal data"), para a
// rota ter UM caminho de filtro e não dois.

export type PresetId = 'este_mes' | 'mes_passado' | 'ultimo_trimestre' | 'este_ano' | 'ano_passado'

export const PRESETS: { id: PresetId; rotulo: string }[] = [
  { id: 'este_mes',         rotulo: 'Este mês' },
  { id: 'mes_passado',      rotulo: 'Mês passado' },
  { id: 'ultimo_trimestre', rotulo: 'Último trimestre' },
  { id: 'este_ano',         rotulo: 'Este ano' },
  { id: 'ano_passado',      rotulo: 'Ano passado' },
]

/** Datas inclusivas, 'YYYY-MM-DD'. */
export interface Periodo { de: string; ate: string }

const p2 = (n: number) => String(n).padStart(2, '0')
const data = (a: number, m: number, d: number) => `${a}-${p2(m)}-${p2(d)}`
/** Último dia do mês `m` (1–12) do ano `a`. Dia 0 do mês seguinte, em UTC. */
export const ultimoDiaDoMes = (a: number, m: number) => new Date(Date.UTC(a, m, 0)).getUTCDate()

const DATA = /^\d{4}-\d{2}-\d{2}$/

/** 'YYYY-MM-DD' que existe de verdade (30 de fevereiro não). */
export function dataValida(d: unknown): d is string {
  if (typeof d !== 'string' || !DATA.test(d)) return false
  const a = +d.slice(0, 4), m = +d.slice(5, 7), dia = +d.slice(8, 10)
  return m >= 1 && m <= 12 && dia >= 1 && dia <= ultimoDiaDoMes(a, m)
}

/** As duas datas existem e `de` não vem depois de `ate`. */
export function periodoValido(de: unknown, ate: unknown): boolean {
  return dataValida(de) && dataValida(ate) && de <= ate
}

export const anoDe = (d: string) => +d.slice(0, 4)

export function periodoDeAno(ano: number): Periodo {
  return { de: data(ano, 1, 1), ate: data(ano, 12, 31) }
}

export function periodoDoMes(ano: number, mes: number): Periodo {
  return { de: data(ano, mes, 1), ate: data(ano, mes, ultimoDiaDoMes(ano, mes)) }
}

/** Primeiro mês do trimestre `q` (1–4). */
const mesDoTrimestre = (q: number) => (q - 1) * 3 + 1

/**
 * O período de cada atalho, a partir de `hoje` (dia do escritório).
 * "Último trimestre" é o último trimestre COMPLETO — em janeiro, fevereiro ou
 * março é o quarto do ano anterior.
 */
export function periodoDoPreset(preset: PresetId, hoje: string): Periodo {
  const a = anoDe(hoje), m = +hoje.slice(5, 7)
  switch (preset) {
    case 'este_mes':    return periodoDoMes(a, m)
    case 'mes_passado': return m === 1 ? periodoDoMes(a - 1, 12) : periodoDoMes(a, m - 1)
    case 'ultimo_trimestre': {
      const qAtual = Math.ceil(m / 3)
      const [ano, q] = qAtual === 1 ? [a - 1, 4] : [a, qAtual - 1]
      const m1 = mesDoTrimestre(q)
      return { de: data(ano, m1, 1), ate: data(ano, m1 + 2, ultimoDiaDoMes(ano, m1 + 2)) }
    }
    case 'este_ano':    return periodoDeAno(a)
    case 'ano_passado': return periodoDeAno(a - 1)
  }
}

/**
 * O período pedido na URL de um relatório. `from`/`to` valem quando os dois
 * existem e fazem sentido; senão `year[&month]`, como as rotas sempre
 * aceitaram; senão nada — e a rota recusa com 400, em vez de inventar.
 */
export function periodoDosParametros(get: (k: string) => string | null): Periodo | null {
  const de = get('from'), ate = get('to')
  if (de || ate) return periodoValido(de, ate) ? { de: de as string, ate: ate as string } : null
  const ano = parseInt(get('year') || '')
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) return null
  const mesBruto = get('month')
  if (mesBruto == null || mesBruto === '') return periodoDeAno(ano)
  const mes = parseInt(mesBruto)
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) return null
  return periodoDoMes(ano, mes)
}

/**
 * A data de corte de um relatório "em tal data" (o Balanço): `asOf` (ou `to`)
 * quando é uma data que existe; senão `year` vale 31 de dezembro daquele ano,
 * como a rota sempre entendeu; senão nada — e a rota recusa, em vez de
 * inventar uma data.
 */
export function dataDeCorteDosParametros(get: (k: string) => string | null): string | null {
  const direto = get('asOf') || get('to')
  if (direto) return dataValida(direto) ? direto : null
  const ano = parseInt(get('year') || '')
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) return null
  return data(ano, 12, 31)
}

// ── Rótulos ──────────────────────────────────────────────────────────────

const MESES_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MESES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const MES_EN_CURTO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** 'October 13, 2026' — a data por extenso dos relatórios em inglês. */
export function dataPorExtensoEN(d: string): string {
  return `${MESES_EN[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}, ${d.slice(0, 4)}`
}

/** 'MM/DD/YYYY', o padrão voltado ao cliente. */
const mmddyyyy = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`

/**
 * O nome do período, do jeito mais curto que ainda é exato:
 * ano inteiro → "2025"; mês inteiro → "October 2026"; trimestre inteiro →
 * "Q3 2026"; o resto, as duas datas.
 */
export function rotuloDoPeriodo(de: string, ate: string, idioma: 'en' | 'pt' = 'en'): string {
  const a = anoDe(de), m = +de.slice(5, 7), d = +de.slice(8, 10)
  const a2 = anoDe(ate), m2 = +ate.slice(5, 7), d2 = +ate.slice(8, 10)
  const inteiro = d === 1 && a === a2 && d2 === ultimoDiaDoMes(a2, m2)
  if (inteiro && m === 1 && m2 === 12) return String(a)
  if (inteiro && m === m2) return idioma === 'pt' ? `${cap(MESES_PT[m - 1])} de ${a}` : `${MESES_EN[m - 1]} ${a}`
  if (inteiro && (m - 1) % 3 === 0 && m2 === m + 2) {
    const q = Math.ceil(m / 3)
    return idioma === 'pt' ? `${q}º trimestre de ${a}` : `Q${q} ${a}`
  }
  if (idioma === 'pt') return `${mmddyyyy(de)} – ${mmddyyyy(ate)}`
  const curto = (x: string) => `${MES_EN_CURTO[+x.slice(5, 7) - 1]} ${+x.slice(8, 10)}`
  return a === a2 ? `${curto(de)} – ${curto(ate)}, ${a}` : `${curto(de)}, ${a} – ${curto(ate)}, ${a2}`
}
