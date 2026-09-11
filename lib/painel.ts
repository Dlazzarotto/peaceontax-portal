// lib/painel.ts — contas do painel da equipe (/dashboard).
//
// Só agregação pura, sem banco e sem React: dá para testar de fora e é onde
// mora a DEFINIÇÃO de cada número que aparece na tela. Aging e receita
// recorrente não se repetem aqui — vêm de lib/relatorios-financeiro.
//
// Datas são sempre a data civil de Nova York em 'YYYY-MM-DD' (string), para
// não escorregar de dia por causa de fuso.

import { round2 } from '@/lib/plans'

export type Pagamento = { amount: number | string; received_at: string }
export type ClienteRef = { type?: string | null; stage?: string | null; created_at?: string | null }

const dia = (v: unknown) => String(v ?? '').slice(0, 10)
const p2 = (n: number) => String(n).padStart(2, '0')

/** Data civil de Nova York, em YYYY-MM-DD. */
export function hojeET(agora: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(agora)
}

/**
 * Instante UTC da meia-noite de Nova York num dia civil, em ISO.
 * O deslocamento muda com o horário de verão (-04:00 no verão, -05:00 no
 * inverno); fixar um deles jogaria a agenda uma hora para o lado meio ano
 * inteiro. Aqui o próprio calendário de Nova York confirma qual serve.
 */
export function inicioDoDiaET(data: string): string {
  const a = +data.slice(0, 4), m = +data.slice(5, 7), d = +data.slice(8, 10)
  const hora = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false, hourCycle: 'h23',
  })
  for (const off of [4, 5]) {
    const t = new Date(Date.UTC(a, m - 1, d, off))
    if (hora.format(t) === '00') return t.toISOString()
  }
  return new Date(Date.UTC(a, m - 1, d, 5)).toISOString()
}

/** O dia civil seguinte, em YYYY-MM-DD. */
export function amanha(data: string): string {
  const d = new Date(Date.UTC(+data.slice(0, 4), +data.slice(5, 7) - 1, +data.slice(8, 10) + 1))
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
}

/**
 * Recortes do calendário usados no painel.
 * `mesmoDiaMesAnterior` existe para a comparação ser justa: dia 9 de setembro
 * se compara com 1 a 9 de agosto, não com agosto inteiro.
 */
export function janelas(hoje: string) {
  const ano = +hoje.slice(0, 4), mes = +hoje.slice(5, 7), d = +hoje.slice(8, 10)
  const anoAnt = mes === 1 ? ano - 1 : ano
  const mesAnt = mes === 1 ? 12 : mes - 1
  const ultimoDiaAnt = new Date(Date.UTC(anoAnt, mesAnt, 0)).getUTCDate()
  const data = (a: number, m: number, dd: number) => `${a}-${p2(m)}-${p2(dd)}`
  return {
    inicioMes: data(ano, mes, 1),
    inicioMesAnterior: data(anoAnt, mesAnt, 1),
    mesmoDiaMesAnterior: data(anoAnt, mesAnt, Math.min(d, ultimoDiaAnt)),
    fimMesAnterior: data(anoAnt, mesAnt, ultimoDiaAnt),
    inicioAno: data(ano, 1, 1),
    ym: `${ano}-${p2(mes)}`,
  }
}

/** Soma dos pagamentos entre duas datas, com as duas pontas incluídas. */
export function somaPeriodo(pagamentos: Pagamento[], de: string, ate: string): number {
  return round2((pagamentos || []).reduce((s, p) => {
    const d = dia(p.received_at)
    return d >= de && d <= ate ? s + Number(p.amount || 0) : s
  }, 0))
}

/** Variação relativa; null quando não há base de comparação. */
export function variacao(atual: number, anterior: number): number | null {
  if (!anterior) return null
  return (atual - anterior) / anterior
}

/** Últimos `meses` meses terminando em `ym` (inclusive), na ordem do calendário. */
export function serieMensal(pagamentos: Pagamento[], ym: string, meses = 12) {
  const ano = +ym.slice(0, 4), mes = +ym.slice(5, 7)
  const linhas: { ym: string; total: number }[] = []
  for (let i = meses - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(ano, mes - 1 - i, 1))
    linhas.push({ ym: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}`, total: 0 })
  }
  const idx = new Map(linhas.map((l, i) => [l.ym, i]))
  for (const p of pagamentos || []) {
    const i = idx.get(dia(p.received_at).slice(0, 7))
    if (i !== undefined) linhas[i].total = round2(linhas[i].total + Number(p.amount || 0))
  }
  return linhas
}

/** Carteira: tamanho, entrada no mês e composição. */
export function resumoCarteira(clientes: ClienteRef[], hoje: string) {
  const inicioMes = janelas(hoje).inicioMes
  const lista = clientes || []
  const porEtapa: Record<string, number> = {}
  let empresas = 0, pessoas = 0, novosNoMes = 0
  for (const c of lista) {
    if (c.type === 'business') empresas++; else pessoas++
    if (dia(c.created_at) >= inicioMes) novosNoMes++
    const e = c.stage || 'Onboarding'
    porEtapa[e] = (porEtapa[e] || 0) + 1
  }
  return { ativos: lista.length, novosNoMes, empresas, pessoas, porEtapa }
}

/**
 * Fila do bookkeeping por cliente.
 * `pending` = ninguém classificou ainda. `auto` = regra ou IA já classificou e
 * está esperando aprovação. São trabalhos diferentes e por isso números
 * diferentes: somados num só, o painel não se mexia quando a equipe
 * classificava o dia inteiro (classificar mantém a linha em 'auto').
 */
export type FilaLinha = { client_id: string; sem_classificacao: number; aguardando_aprovacao: number }

export function resumoFila(linhas: FilaLinha[], nomes: Record<string, string>, ativos?: Set<string>) {
  const usar = (linhas || []).filter(l => !ativos || ativos.has(l.client_id))
  const total = usar.reduce((t, l) => ({
    semClassificacao: t.semClassificacao + Number(l.sem_classificacao || 0),
    aguardandoAprovacao: t.aguardandoAprovacao + Number(l.aguardando_aprovacao || 0),
  }), { semClassificacao: 0, aguardandoAprovacao: 0 })

  const porCliente = usar
    .map(l => ({
      clientId: l.client_id,
      nome: nomes[l.client_id] || 'Cliente',
      semClassificacao: Number(l.sem_classificacao || 0),
      aguardandoAprovacao: Number(l.aguardando_aprovacao || 0),
      fila: Number(l.sem_classificacao || 0) + Number(l.aguardando_aprovacao || 0),
    }))
    .filter(c => c.fila > 0)
    .sort((a, b) => b.fila - a.fila)

  const ignorados = (linhas || []).length - usar.length
  return { ...total, porCliente, ignorados }
}
