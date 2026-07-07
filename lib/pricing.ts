// lib/pricing.ts — Motor de precificação Peace on Tax
// Tabela aprovada por David Lazzarotto em 06/07/2026.
// Para alterar valores, edite apenas os números abaixo — a lógica permanece.

export interface PricingItem {
  label: string
  amount: number
  qty?: number
}

export interface QuoteResult {
  items: PricingItem[]
  total: number
  needsManualReview: boolean
  reviewReason?: string
}

export interface ClientDocProfile {
  filingStatus: 'single' | 'married'
  w2Count: number
  dependents: number
  scheduleCCount: number   // atividades 1099 (cada negócio = 1 Sch C)
  has1098: boolean         // mortgage / residência
  scheduleECount: number   // imóveis de aluguel
  extraStateCount: number  // estados além do 1º (incluído)
  hasScheduleB: boolean    // 1099-INT ou 1099-DIV
  has1099B: boolean        // corretora / investimentos
  has1095A: boolean        // plano de saúde marketplace (incluído)
  hasLLC: boolean          // → escalar para orçamento manual
  hasCryptoNoReport: boolean // → escalar
}

// ---- Tabela de preços ----
const PRICE = {
  baseSingle:   150,   // solteiro, até 2 W-2
  baseMarried:  200,   // casado (MFJ), até 4 W-2
  extraW2:       25,   // por W-2 adicional
  dependent:     25,   // por dependente
  scheduleC:     50,   // por Schedule C (1099)
  mortgage1098:  25,   // Form 1098
  scheduleE:     50,   // por imóvel (Schedule E)
  extraState:    25,   // por estado adicional
  scheduleB:     25,   // 1099-INT/DIV
  brokerage:     50,   // 1099-B
  health1095A:    0,   // incluído
}

export function calculateQuote(p: ClientDocProfile): QuoteResult {
  if (p.hasLLC) return {
    items: [], total: 0, needsManualReview: true,
    reviewReason: 'LLC com Schedule C — requer avaliação profissional antes da cotação.',
  }
  if (p.hasCryptoNoReport) return {
    items: [], total: 0, needsManualReview: true,
    reviewReason: 'Crypto sem relatório da exchange — requer avaliação profissional.',
  }

  const items: PricingItem[] = []
  const isMarried = p.filingStatus === 'married'
  const includedW2s = isMarried ? 4 : 2

  items.push({
    label: isMarried
      ? 'Declaração Casado (MFJ) — inclui até 4 W-2s'
      : 'Declaração Individual — inclui até 2 W-2s',
    amount: isMarried ? PRICE.baseMarried : PRICE.baseSingle,
  })

  const extraW2s = Math.max(0, p.w2Count - includedW2s)
  if (extraW2s > 0)       items.push({ label: 'W-2 adicional',               amount: extraW2s * PRICE.extraW2,   qty: extraW2s })
  if (p.dependents > 0)   items.push({ label: 'Dependente(s)',               amount: p.dependents * PRICE.dependent, qty: p.dependents })
  if (p.scheduleCCount>0) items.push({ label: 'Schedule C (atividade 1099)', amount: p.scheduleCCount * PRICE.scheduleC, qty: p.scheduleCCount })
  if (p.has1098)          items.push({ label: 'Form 1098 (mortgage)',         amount: PRICE.mortgage1098 })
  if (p.scheduleECount>0) items.push({ label: 'Schedule E (aluguel)',         amount: p.scheduleECount * PRICE.scheduleE, qty: p.scheduleECount })
  if (p.extraStateCount>0)items.push({ label: 'Declaração estadual adicional',amount: p.extraStateCount * PRICE.extraState, qty: p.extraStateCount })
  if (p.hasScheduleB)     items.push({ label: 'Schedule B (1099-INT/DIV)',    amount: PRICE.scheduleB })
  if (p.has1099B)         items.push({ label: '1099-B (corretora)',           amount: PRICE.brokerage })
  if (p.has1095A)         items.push({ label: '1095-A (marketplace) — incluído', amount: PRICE.health1095A })

  const total = items.reduce((s, i) => s + i.amount, 0)
  return { items, total, needsManualReview: false }
}

// Feriados federais dos EUA 2026
const HOLIDAYS_2026 = new Set([
  '2026-01-01','2026-01-19','2026-02-16','2026-05-25',
  '2026-06-19','2026-07-03','2026-07-04','2026-09-07',
  '2026-10-12','2026-11-11','2026-11-26','2026-12-25',
])

// Retorna a data da fila de trabalho respeitando a regra das 16h ET
export function getQueueDate(paymentUTC: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(paymentUTC)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const etHour = parseInt(get('hour'))
  const baseDate = `${get('year')}-${get('month')}-${get('day')}`

  let d = new Date(`${baseDate}T12:00:00Z`)
  if (etHour >= 16) d.setUTCDate(d.getUTCDate() + 1)

  // Pula fins de semana e feriados
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6 || HOLIDAYS_2026.has(d.toISOString().slice(0,10))) {
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return d.toISOString().slice(0, 10)
}

// Resumo textual da cotação para o chat IA
export function quoteToText(result: QuoteResult, lang = 'pt'): string {
  if (result.needsManualReview) {
    return lang === 'pt'
      ? `Este caso requer avaliação da nossa equipe. ${result.reviewReason} Entre em contato para receber um orçamento personalizado.`
      : `This case requires our team's evaluation. ${result.reviewReason} Please contact us for a personalized quote.`
  }
  const lines = result.items
    .filter(i => i.amount > 0)
    .map(i => `• ${i.label}${i.qty ? ` (×${i.qty})` : ''}: $${i.amount.toFixed(2)}`)
  return lang === 'pt'
    ? `Estimativa de honorários:\n${lines.join('\n')}\nTotal estimado: **$${result.total.toFixed(2)}**\n\n_Sujeito à confirmação da equipe após análise dos documentos._`
    : `Fee estimate:\n${lines.join('\n')}\nEstimated total: **$${result.total.toFixed(2)}**\n\n_Subject to team confirmation after document review._`
}
