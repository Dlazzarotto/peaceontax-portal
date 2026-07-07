// lib/plans.ts — cálculos de parcelamento e bookkeeping mensal

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

/** Próximo dia 5 (ET) a partir de agora — para o bookkeeping mensal */
export function nextDay5ET(from = new Date()): Date {
  // Trabalha no calendário ET
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(from)
  const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value)
  let year = get('year'), month = get('month'), day = get('day')

  if (day >= 5) { month += 1; if (month > 12) { month = 1; year += 1 } }
  // Meio-dia UTC do dia 5 = manhã ET, seguro contra DST
  return new Date(Date.UTC(year, month - 1, 5, 12, 0, 0))
}

export function fmtDateBR(d: Date | string): string {
  return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/New_York' })
}
