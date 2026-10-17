// lib/contrato-unico.ts — o contrato recorrente num lugar só (payment_plans)
//
// Decisão do sócio: "juntar os planos com os contratos recorrentes e
// eliminar os planos". O motor é o dos Planos (payment_plans): é nele que as
// assinaturas ATIVAS do Stripe vivem e que o webhook procura — elas continuam
// cobrando. A regra é a dos Contratos recorrentes (lib/contrato-recorrente.ts:
// itens, desconto em dólar, prazo em dias, régua ancorada no início).
//
// Duas formas de cobrar, e a forma não muda depois (decisão do sócio: mudar
// intervalo ou forma é encerrar e criar outro):
//   debito  a assinatura do Stripe debita; o webhook emite a fatura do mês e
//           dá baixa (como sempre foi nos Planos)
//   fatura  a rotina diária (/api/cron/contratos) emite a fatura do período,
//           que vence N dias depois; o cliente paga pelo portal
//
// Módulo puro, com teste (testes/contrato-unico.mts): é dinheiro e é data.

import {
  MESES_DO_INTERVALO, ehIntervalo, proximaCobranca, vencimentoDaCobranca,
  type Intervalo,
} from './contrato-recorrente.ts'

export const FORMAS_DE_COBRANCA = ['debito', 'fatura'] as const
export type FormaDeCobranca = (typeof FORMAS_DE_COBRANCA)[number]

export function ehFormaDeCobranca(v: unknown): v is FormaDeCobranca {
  return typeof v === 'string' && (FORMAS_DE_COBRANCA as readonly string[]).includes(v)
}

export const ROTULO_DA_FORMA: Record<FormaDeCobranca, string> = {
  debito: 'Débito automático (Stripe)',
  fatura: 'Fatura emitida pelo sistema',
}

const centavos = (v: unknown) => Math.round((Number(v) || 0) * 100)
const intervalo = (v: unknown): Intervalo => (ehIntervalo(v) ? v : 'monthly')

/** A véspera de uma data ISO, ao meio-dia UTC (sem escorregar no horário de verão). */
function vespera(data: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(data || '').slice(0, 10))
  if (!m) return String(data || '').slice(0, 10)
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12))
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * A primeira cobrança da régua NO DIA `desde` ou depois.
 *
 * É a data em que um contrato por fatura passa a cobrar quando é ATIVADO.
 * Não volta para trás: o contrato trazido do módulo antigo pode ter início
 * em janeiro, e cobrar janeiro a setembro de uma vez seria cobrar em dobro
 * quem a firma já vinha faturando à mão.
 */
export function cobrancaAPartirDe(dia: number, inicio: string | null | undefined, iv: unknown, desde: string): string {
  return proximaCobranca(dia, inicio || desde, intervalo(iv), vespera(desde))
}

/**
 * Depois de emitir a cobrança de `atual`, a próxima da régua — UM passo.
 *
 * Um passo e não "a próxima depois de hoje": se a rotina ficou dias sem
 * rodar, pular direto para depois de hoje deixaria os períodos do meio sem
 * fatura, calados. Um passo por rodada põe a régua em dia, um período por dia.
 */
export function cobrancaSeguinte(dia: number, inicio: string | null | undefined, iv: unknown, atual: string): string {
  return proximaCobranca(dia, inicio || atual, intervalo(iv), atual)
}

export interface LinhaDoContrato {
  service_id?: string | null
  description: string
  quantity: number | string
  unit_price: number | string
}

export interface PlanoParaEmitir {
  collection_method?: string | null
  status?: string | null
  due_day?: number | null
  start_date?: string | null
  end_date?: string | null
  billing_interval?: string | null
  next_charge_date?: string | null
  due_days?: number | null
  discount?: number | string | null
  monthly_amount?: number | string | null
}

export interface LinhaDaFatura {
  service_id: string | null
  description: string
  qty: number
  unit_price: number
  amount: number
}

export type Emissao =
  | {
      emitir: true
      competencia: string
      emissao: string
      vencimento: string
      linhas: LinhaDaFatura[]
      bruto: number
      desconto: number
      total: number
      seguinte: string
      /** A próxima cairia depois do fim: o contrato acaba nesta. */
      ultima: boolean
    }
  | { emitir: false; motivo: string; encerrar?: boolean }

function linhasDaFatura(linhas: LinhaDoContrato[]): LinhaDaFatura[] {
  return (linhas || []).map(l => {
    const qty = Number(l.quantity) || 0
    const unit = centavos(l.unit_price) / 100
    return {
      service_id: l.service_id || null,
      description: String(l.description || '').trim(),
      qty,
      unit_price: unit,
      amount: Math.round(qty * centavos(l.unit_price)) / 100,
    }
  })
}

/**
 * A rotina diária emite a fatura deste contrato hoje? E qual?
 *
 * A competência é a do PERÍODO (o mês da data da régua), não a do dia em que
 * a rotina rodou: atrasada, ela emite o período certo. O par (plano,
 * competência) é único no banco — rodar duas vezes não emite duas.
 *
 * Valor gravado que não bate com as linhas NÃO emite: a fatura sairia com um
 * número diferente do contrato, e "salvar o contrato" acerta (o banco
 * recalcula). É melhor parar e dizer do que cobrar um valor que ninguém viu.
 */
export function decidirEmissao(plano: PlanoParaEmitir, linhas: LinhaDoContrato[], hoje: string): Emissao {
  if (plano.collection_method !== 'fatura') return { emitir: false, motivo: 'no débito, quem cobra é o Stripe' }
  if (plano.status !== 'active') return { emitir: false, motivo: 'o contrato não está ativo' }
  const data = String(plano.next_charge_date || '').slice(0, 10)
  const temData = /^\d{4}-\d{2}-\d{2}$/.test(data)
  const fim = plano.end_date ? String(plano.end_date).slice(0, 10) : null
  // Período que venceu ANTES do fim ainda se cobra (a rotina pode ter ficado
  // parada). Fora isso, o contrato que chegou ao fim se encerra NO DIA DO
  // FIM — esperar a próxima cobrança o deixaria "ativo" semanas depois de
  // acabar, à vista na tela como se ainda valesse.
  const devido = temData && data <= hoje && (!fim || data < fim)
  if (!devido) {
    if (fim && fim <= hoje) return { emitir: false, motivo: 'o contrato terminou', encerrar: true }
    if (!temData) return { emitir: false, motivo: 'o contrato ativo está sem a data da próxima cobrança' }
    return { emitir: false, motivo: 'ainda não é o dia' }
  }

  const lf = linhasDaFatura(linhas).filter(l => l.description && l.qty > 0)
  if (!lf.length) return { emitir: false, motivo: 'o contrato está sem linhas' }
  const brutoC = lf.reduce((s, l) => s + Math.round(l.amount * 100), 0)
  const descontoC = Math.max(0, centavos(plano.discount))
  const totalC = brutoC - descontoC
  if (totalC <= 0) return { emitir: false, motivo: 'o contrato ficaria em zero' }
  if (totalC !== centavos(plano.monthly_amount)) {
    return { emitir: false, motivo: `o valor gravado (${(centavos(plano.monthly_amount) / 100).toFixed(2)}) não bate com as linhas (${(totalC / 100).toFixed(2)}) — salve o contrato para acertar` }
  }

  const dia = Number(plano.due_day) || 1
  const seguinte = cobrancaSeguinte(dia, plano.start_date, plano.billing_interval, data)
  return {
    emitir: true,
    competencia: `${data.slice(0, 7)}-01`,
    emissao: hoje,
    vencimento: vencimentoDaCobranca(hoje, plano.due_days),
    linhas: lf,
    bruto: brutoC / 100,
    desconto: descontoC / 100,
    total: totalC / 100,
    seguinte,
    ultima: !!fim && seguinte >= fim,
  }
}

/**
 * A fatura da mensalidade do DÉBITO com os itens do contrato — só quando a
 * conta das linhas bate, ao centavo, com o que o Stripe cobrou. Não bateu
 * (mudança no meio do ciclo, ajuste feito no Stripe), vale o que foi
 * cobrado, numa linha só: a fatura nunca diz um valor que não foi o debitado.
 */
export function linhasDaMensalidade(
  linhas: LinhaDoContrato[], desconto: unknown, cobrado: number,
): { linhas: LinhaDaFatura[]; bruto: number; desconto: number } | null {
  const lf = linhasDaFatura(linhas).filter(l => l.description && l.qty > 0)
  if (!lf.length) return null
  const brutoC = lf.reduce((s, l) => s + Math.round(l.amount * 100), 0)
  const descontoC = Math.max(0, centavos(desconto))
  if (brutoC - descontoC !== centavos(cobrado)) return null
  return { linhas: lf, bruto: brutoC / 100, desconto: descontoC / 100 }
}

/**
 * A primeira cobrança do DÉBITO: a data da régua que fica a pelo menos três
 * dias de hoje.
 *
 * O Stripe recusa `trial_end` a menos de 48 horas, então a data mais próxima
 * da régua pode não servir — vai para a seguinte (o dia do mês fica). E é a
 * RÉGUA do contrato, não "o próximo dia X": num trimestral que começou em
 * janeiro, quem cadastra o débito em agosto é cobrado em outubro, junto com
 * a régua (jan · abr · jul · out), e não em setembro, que daria outra régua
 * para sempre.
 */
export function ancoraDoDebito(dia: number, inicio: string | null | undefined, iv: unknown, hoje: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(hoje || '').slice(0, 10))
  if (!m) return String(hoje || '').slice(0, 10)
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12))
  d.setUTCDate(d.getUTCDate() + 2)
  const limite = d.toISOString().slice(0, 10)
  // "Depois de hoje + 2" = no mínimo três dias: meio-dia UTC dessa data fica
  // a mais de 50 horas de qualquer instante de hoje em Nova York.
  return proximaCobranca(dia, inicio || limite, intervalo(iv), limite)
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const abrev = (m: number) => MESES[m].slice(0, 3)

/**
 * O período que a cobrança cobre, para a fatura: "outubro de 2026",
 * "out a dez de 2026", "nov/2026 a jan/2027", "out/2026 a set/2027".
 * Sem isto a fatura do trimestral dizia só o mês em que começou, e o
 * cliente lia como mensalidade.
 */
export function rotuloDoPeriodo(competencia: string, iv: unknown): string {
  const m = /^(\d{4})-(\d{2})/.exec(String(competencia || ''))
  if (!m) return String(competencia || '')
  const ano = Number(m[1]), mes = Number(m[2]) - 1
  const n = MESES_DO_INTERVALO[intervalo(iv)]
  if (n === 1) return `${MESES[mes]} de ${ano}`
  const fimT = mes + n - 1
  const anoFim = ano + Math.floor(fimT / 12), mesFim = fimT % 12
  if (anoFim === ano) return `${abrev(mes)} a ${abrev(mesFim)} de ${ano}`
  return `${abrev(mes)}/${ano} a ${abrev(mesFim)}/${anoFim}`
}

/** Receita MENSAL equivalente: num trimestral, o valor do trimestre dividido por 3. */
export function valorMensalEquivalente(valor: unknown, iv: unknown): number {
  return Math.round(centavos(valor) / MESES_DO_INTERVALO[intervalo(iv)]) / 100
}

/** O intervalo da assinatura no Stripe para o intervalo do contrato. */
export function recorrenciaDoStripe(iv: unknown): { interval: 'month' | 'year'; interval_count: number } {
  const i = intervalo(iv)
  if (i === 'annual') return { interval: 'year', interval_count: 1 }
  return { interval: 'month', interval_count: MESES_DO_INTERVALO[i] }
}

/** "/mês", "/trimestre", "/ano" — o que o valor de cada cobrança cobre. */
export function porPeriodo(iv: unknown, lang: string = 'pt'): string {
  const i = intervalo(iv)
  const en = String(lang || '').toLowerCase().startsWith('en')
  if (i === 'quarterly') return en ? '/quarter' : '/trimestre'
  if (i === 'annual') return en ? '/year' : '/ano'
  return en ? '/month' : '/mês'
}

export type DecisaoDeEdicao =
  | { ok: true; mudaStripe: boolean; refazLink: boolean }
  | { ok: false; status: 409; erro: string }

/**
 * Pode editar itens, desconto e prazo deste contrato agora? (Decisão do
 * sócio: valor, itens e desconto se editam, valendo da PRÓXIMA cobrança;
 * intervalo e forma, não — isso é encerrar e criar outro.)
 *
 *   encerrado                → não
 *   fatura                   → sim, vale da próxima emissão
 *   débito sem assinatura    → sim, e o link de cadastro antigo deixa de
 *                              valer (o cliente autorizaria o valor velho)
 *   débito com assinatura    → sim, e a assinatura do Stripe muda de preço
 *                              a partir da próxima cobrança, sem proporcional
 */
export function decidirEdicao(plano: {
  status?: string | null; collection_method?: string | null; stripe_subscription_id?: string | null
}): DecisaoDeEdicao {
  if (['cancelled', 'completed'].includes(String(plano.status))) {
    return { ok: false, status: 409, erro: 'Contrato encerrado não se edita. Crie outro.' }
  }
  if (plano.collection_method === 'fatura') return { ok: true, mudaStripe: false, refazLink: false }
  if (plano.stripe_subscription_id) return { ok: true, mudaStripe: true, refazLink: false }
  return { ok: true, mudaStripe: false, refazLink: ['awaiting_setup', 'awaiting_entry'].includes(String(plano.status)) }
}
