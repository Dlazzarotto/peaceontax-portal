// lib/apply-rules.ts — aplica as regras de categorização de um cliente
// às transações pending + auto (registro aprovado nunca é tocado).
// Usada automaticamente após sync do Plaid e importação de PDF,
// e pelo botão "Aplicar regras".

export async function applyRulesToClient(db: any, clientId: string): Promise<number> {
  const { data: rules } = await db.from('bookkeeping_rules')
    .select('pattern, category, priority, client_id, direction, match_type, amount_op, amount_value, payee')
    .or(`client_id.eq.${clientId},client_id.is.null`)
    .order('priority', { ascending: true })
  if (!rules || rules.length === 0) return 0

  const matches = (r: any, desc: string, amount: number): boolean => {
    if (r.direction === 'in' && amount <= 0) return false
    if (r.direction === 'out' && amount >= 0) return false
    if (r.pattern) {
      const variants = String(r.pattern).toLowerCase().split('|').map((v: string) => v.trim()).filter(Boolean)
      const hit = variants.some((v: string) => r.match_type === 'starts_with' ? desc.startsWith(v) : desc.includes(v))
      if (!hit) return false
    }
    if (r.amount_op) {
      const abs = Math.abs(amount), v = Number(r.amount_value)
      if (r.amount_op === 'gt' && !(abs > v)) return false
      if (r.amount_op === 'lt' && !(abs < v)) return false
      if (r.amount_op === 'eq' && Math.abs(abs - v) > 0.005) return false
    }
    return true
  }

  const { data: txs } = await db.from('bank_transactions')
    .select('id, description, amount')
    .eq('client_id', clientId)
    .in('status', ['pending', 'auto'])
    .limit(5000)

  let applied = 0
  for (const tx of (txs || [])) {
    const desc = String(tx.description).toLowerCase()
    const rule = rules.find((r: any) => matches(r, desc, Number(tx.amount)))
    if (!rule) continue
    const upd: Record<string, unknown> = {
      category: rule.category, category_confidence: 100,
      categorized_by: 'rule', status: 'auto',
      updated_at: new Date().toISOString(),
    }
    if (rule.payee) upd.payee = rule.payee
    const { error } = await db.from('bank_transactions').update(upd).eq('id', tx.id)
    if (!error) applied++
  }
  return applied
}
