// lib/plans.ts — cálculos de parcelamento e planos mensais
export type Frequency = 'weekly' | 'biweekly' | 'monthly'
export const FREQ_LABEL: Record<Frequency, string> = {
  weekly: 'Semanal', biweekly: 'Quinzenal', monthly: 'Mensal',
}
export const FREQ_STRIPE: Record<Frequency, { interval: 'week'|'month'; interval_count: number }> = {
  weekly:   { interval: 'week',  interval_count: 1 },
  biweekly: { interval: 'week',  interval_count: 2 },
  monthly:  { interval: 'month', interval_count: 1 },
}
/** Arredonda para 2 casas evitando dízimas */
export const round2 = (n: number) => Math.round(n * 100) / 100
/** Calcula entrada e parcela a partir do total, % e quantidade */
export function calcInstallmentPlan(total: number, entryPct: number, installments: number) {
  const entry = round2(total * (entryPct / 100))
  const remaining = round2(total - entry)
  const perInstallment = round2(remaining / installments)
  // Ajuste de centavos: última parcela absorve a diferença (informativo)
  const totalParcelas = round2(perInstallment * installments)
  const centDiff = round2(remaining - totalParcelas)
  return { entry, remaining, perInstallment, centDiff }
}
/** Primeira cobrança de parcela: data da entrada + 1 intervalo */
export function firstInstallmentDate(entryPaidAt: Date, freq: Frequency): Date {
  const d = new Date(entryPaidAt)
  if (freq === 'weekly')   d.setDate(d.getDate() + 7)
  if (freq === 'biweekly') d.setDate(d.getDate() + 14)
  if (freq === 'monthly')  d.setMonth(d.getMonth() + 1)
  return d
}

/** Faixa aceita para o dia de cobrança. 29–31 não existem em todo mês:
 *  ver DIA_MAXIMO_SEGURO abaixo e a nota na tela de criação do plano. */
export const DIA_MINIMO = 1
export const DIA_MAXIMO = 31
/** Acima de 28 o dia não existe em fevereiro e o ciclo do Stripe fica preso
 *  no dia reduzido. A tela deve limitar a escolha a 1–28. */
export const DIA_MAXIMO_SEGURO = 28

/** Normaliza o dia vindo do banco: inteiro dentro da faixa, 5 como padrão histórico. */
export function normalizarDiaCobranca(dia: unknown): number {
  const n = Math.trunc(Number(dia))
  if (!Number.isFinite(n) || n < DIA_MINIMO || n > DIA_MAXIMO) return 5
  return n
}

/**
 * Próxima ocorrência do dia de cobrança acordado, no calendário ET.
 * - Se hoje já é o dia (ou passou), vai para o mês seguinte.
 * - Mês curto: usa o último dia disponível (31 em fevereiro vira 28/29).
 * Meio-dia UTC = manhã ET, seguro contra horário de verão.
 */
export function nextBillingDayET(dia: unknown, from = new Date()): Date {
  const alvo = normalizarDiaCobranca(dia)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(from)
  const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value)
  let year = get('year'), month = get('month'), day = get('day')
  if (day >= alvo) { month += 1; if (month > 12) { month = 1; year += 1 } }
  // Dia 0 do mês seguinte = último dia do mês corrente
  const ultimoDia = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return new Date(Date.UTC(year, month - 1, Math.min(alvo, ultimoDia), 12, 0, 0))
}

/** @deprecated Use nextBillingDayET(plan.due_day). Mantido para não quebrar chamadas antigas. */
export function nextDay5ET(from = new Date()): Date {
  return nextBillingDayET(5, from)
}

export function fmtDateBR(d: Date | string): string {
  return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/New_York' })
}
