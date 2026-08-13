// lib/apply-rules.ts — aplica as regras de categorização de um cliente
// às transações pending + auto (registro aprovado nunca é tocado).
// Usada automaticamente após sync do Plaid e importação de PDF,
// e pelo botão "Aplicar regras".

export async function applyRulesToClient(db: any, clientId: string): Promise<number> {
  // Non-profit: cada entidade tem projetos/fundos próprios — regras globais
  // do sistema NÃO se aplicam. Só valem as regras do próprio cliente.
  const { data: cli } = await db.from('clients')
    .select('business_kind').eq('id', clientId).maybeSingle()
  const soDoCliente = cli?.business_kind === 'nonprofit'

  let rq = db.from('bookkeeping_rules')
    .select('pattern, category, priority, client_id, direction, match_type, amount_op, amount_value, payee, account_id')
  rq = soDoCliente
    ? rq.eq('client_id', clientId)
    : rq.or(`client_id.eq.${clientId},client_id.is.null`)
  const { data: rules } = await rq.order('priority', { ascending: true })
  if (!rules || rules.length === 0) return 0

  const matches = (r: any, desc: string, amount: number, accountId: string | null): boolean => {
    if (r.account_id && r.account_id !== accountId) return false   // regra restrita a uma conta
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

  // Lê tudo em páginas (sem teto fixo) e em ordem estável
  const PAGINA = 1000
  const txs: any[] = []
  for (let inicio = 0; ; inicio += PAGINA) {
    const { data: pagina } = await db.from('bank_transactions')
      .select('id, description, amount, account_id')
      .eq('client_id', clientId)
      .in('status', ['pending', 'auto'])
      .order('id', { ascending: true })
      .range(inicio, inicio + PAGINA - 1)
    if (!pagina || pagina.length === 0) break
    txs.push(...pagina)
    if (pagina.length < PAGINA) break
  }

  // Agrupa por categoria+payee e grava em lote (evita 1 UPDATE por lançamento)
  const lotes = new Map<string, { category: string; payee: string | null; ids: string[] }>()
  for (const tx of txs) {
    const desc = String(tx.description).toLowerCase()
    const rule = rules.find((r: any) => matches(r, desc, Number(tx.amount), tx.account_id || null))
    if (!rule) continue
    const chave = `${rule.category}||${rule.payee || ''}`
    const grupo = lotes.get(chave) || { category: rule.category as string, payee: (rule.payee || null) as string | null, ids: [] as string[] }
    grupo.ids.push(tx.id)
    lotes.set(chave, grupo)
  }

  let applied = 0
  for (const grupo of Array.from(lotes.values())) {
    const upd: Record<string, unknown> = {
      category: grupo.category, category_confidence: 100,
      categorized_by: 'rule', status: 'auto',
      updated_at: new Date().toISOString(),
    }
    if (grupo.payee) upd.payee = grupo.payee
    for (let i = 0; i < grupo.ids.length; i += 400) {
      const fatia = grupo.ids.slice(i, i + 400)
      const { error } = await db.from('bank_transactions').update(upd).in('id', fatia)
      if (!error) applied += fatia.length
    }
  }
  return applied
}
