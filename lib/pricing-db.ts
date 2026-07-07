// lib/pricing-db.ts — Cotação automática lendo valores do catálogo (pricing_items)
// Substitui os valores fixos: reajuste de preço agora é feito na tela, sem deploy.

import { serviceDb } from '@/lib/api-auth'
import type { QuoteResult, ClientDocProfile, PricingItem } from '@/lib/pricing'

type Rates = Record<string, { label: string; amount: number; active: boolean }>

export async function loadRates(): Promise<Rates> {
  const { data } = await serviceDb()
    .from('pricing_items')
    .select('code, label, amount, active')
  const rates: Rates = {}
  for (const r of data || []) rates[r.code] = { label: r.label, amount: Number(r.amount), active: r.active }
  return rates
}

export async function calculateQuoteFromDb(p: ClientDocProfile): Promise<QuoteResult> {
  if (p.hasLLC) return {
    items: [], total: 0, needsManualReview: true,
    reviewReason: 'LLC com Schedule C — requer avaliação profissional antes da cotação.',
  }
  if (p.hasCryptoNoReport) return {
    items: [], total: 0, needsManualReview: true,
    reviewReason: 'Crypto sem relatório da exchange — requer avaliação profissional.',
  }

  const r = await loadRates()
  const get = (code: string) => r[code]?.active ? r[code] : null

  const items: PricingItem[] = []
  const isMarried = p.filingStatus === 'married'
  const base = get(isMarried ? 'base_married' : 'base_single')
  if (!base) return { items: [], total: 0, needsManualReview: true, reviewReason: 'Item base inativo no catálogo — verifique a Tabela de Preços.' }

  items.push({ label: base.label, amount: base.amount, qty: 1 })

  const includedW2s = isMarried ? 4 : 2
  const push = (code: string, qty = 1) => {
    const item = get(code)
    if (item && qty > 0) items.push({ label: item.label, amount: item.amount, qty })
  }

  push('extra_w2', Math.max(0, p.w2Count - includedW2s))
  push('dependent', p.dependents)
  push('schedule_c', p.scheduleCCount)
  if (p.has1098) push('mortgage_1098')
  push('schedule_e', p.scheduleECount)
  push('extra_state', p.extraStateCount)
  if (p.hasScheduleB) push('schedule_b')
  if (p.has1099B) push('brokerage_1099b')
  if (p.has1095A) push('health_1095a')

  const total = items.reduce((s, i) => s + i.amount * (i.qty || 1), 0)
  return { items, total, needsManualReview: false }
}
