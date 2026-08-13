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
  const { data: rulesRaw } = await rq.order('priority', { ascending: true })
  // Regra do próprio cliente vence a regra geral quando ambas casam
  const rules = (rulesRaw || []).slice().sort((a: any, b: any) =>
    (Number(a.priority) - Number(b.priority)) ||
    ((a.client_id ? 0 : 1) - (b.client_id ? 0 : 1)))
  if (!rules || rules.length === 0) return 0

  // Casamento por PALAVRA INTEIRA (não por pedaço).
  // "mobil" não pode casar dentro de "Mobilizat", nem "bk" dentro de "BKOFAMERICA".
  const escapar = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const casaTexto = (desc: string, v: string, tipo: string): boolean => {
    if (!v) return false
    return tipo === 'starts_with'
      ? new RegExp('^' + escapar(v) + '([^a-z0-9]|$)', 'i').test(desc)
      : new RegExp('(^|[^a-z0-9])' + escapar(v) + '([^a-z0-9]|$)', 'i').test(desc)
  }

  const matches = (r: any, desc: string, amount: number, accountId: string | null): boolean => {
    if (r.account_id && r.account_id !== accountId) return false   // regra restrita a uma conta
    if (r.direction === 'in' && amount <= 0) return false
    if (r.direction === 'out' && amount >= 0) return false
    if (r.pattern) {
      const variants = String(r.pattern).toLowerCase().split('|').map((v: string) => v.trim()).filter(Boolean)
      const hit = variants.some((v: string) => casaTexto(desc, v, r.match_type))
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
      .select('id, description, amount, account_id, tx_date, transfer_match_id')
      .eq('client_id', clientId)
      .in('status', ['pending', 'auto'])
      .order('id', { ascending: true })
      .range(inicio, inicio + PAGINA - 1)
    if (!pagina || pagina.length === 0) break
    txs.push(...pagina)
    if (pagina.length < PAGINA) break
  }

  // ── Transferências entre contas do próprio cliente ──
  // O extrato costuma dizer a conta na descrição:
  // "Online Banking transfer from CHK 7495" → a outra ponta é a conta ...7495.
  const { data: contasCli } = await db.from('bank_accounts')
    .select('id, name, type, account_hint').eq('client_id', clientId)
  const tipoConta = new Map((contasCli || []).map((a: any) => [a.id, String(a.type || '').toLowerCase()]))

  // 4 dígitos só quando precedidos por indicação de conta — nunca de
  // números de confirmação (ex.: XXXXX32635 não vira conta).
  // O extrato sempre diz "to" ou "from". O que decide se é transferência de
  // verdade é a CONTA citada bater com uma conta do próprio cliente — o sinal
  // do valor é apenas um alerta de incoerência, não um veto.
  const sentidoTransferencia = (desc: string): 'to' | 'from' | 'card' | null => {
    const m = /(^|[^a-z])(transfer|xfer|wire)[^a-z0-9]{0,4}(to|from)([^a-z]|$)/i.exec(desc)
    if (m) return m[3].toLowerCase() as 'to' | 'from'
    if (/(^|[^a-z])(autopay|card payment)([^a-z]|$)|payment to[^.]{0,25}card/i.test(desc)) return 'card'
    return null
  }

  const quatroDigitos = (texto: string): string[] => {
    const achados: string[] = []
    const re = /(?:chk|sav|checking|savings|acct|account|card|ending(?:\s+in)?|[x*•]{2,}|\.{3})\s*#?\s*(\d{4})(?!\d)/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(texto)) !== null) achados.push(m[1])
    return achados
  }

  const finalDaConta = new Map<string, string>()
  for (const a of (contasCli || []) as any[]) {
    const digs = String(`${a.name || ''} ${a.account_hint || ''}`).match(/(\d{4})(?!\d)/g)
    if (digs && digs.length) finalDaConta.set(a.id, digs[digs.length - 1])
  }

  const dias = (a: string, b: string) =>
    Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000)

  const porValor = new Map<string, any[]>()
  for (const t of txs) {
    const k = Math.abs(Number(t.amount)).toFixed(2)
    if (!porValor.has(k)) porValor.set(k, [])
    porValor.get(k)!.push(t)
  }

  const contasDeFora = new Set<string>()
  const jaTransferencia = new Set<string>()
  let transferidas = 0

  // Se existe regra para a descrição (ex.: "Peace on Tax"), ela manda —
  // transferência não sobrepõe fornecedor identificado.
  const temRegra = new Set<string>()
  for (const t of txs) {
    const d = String(t.description).toLowerCase()
    if (rules.find((r: any) => matches(r, d, Number(t.amount), t.account_id || null))) temRegra.add(t.id)
  }

  for (const t of txs) {
    if (jaTransferencia.has(t.id) || t.transfer_match_id || temRegra.has(t.id)) continue
    if (!sentidoTransferencia(String(t.description))) continue
    const tokens = quatroDigitos(String(t.description))
    if (tokens.length === 0) continue
    const alvos = (contasCli || []).filter((a: any) =>
      a.id !== t.account_id && finalDaConta.get(a.id) && tokens.includes(finalDaConta.get(a.id)!))
    if (alvos.length === 0) {
      // Cita uma conta que NÃO é deste cliente: dinheiro de fora, não é
      // movimentação interna. Fica para decisão manual (pode ser receita).
      for (const d of tokens) contasDeFora.add(d)
      continue
    }
    if (alvos.length !== 1) continue
    const conta: any = alvos[0]

    const ehCartao = /credit|card|cart/.test(
      (tipoConta.get(t.account_id) || '') + ' ' + (tipoConta.get(conta.id) || ''))
    const base = {
      category: ehCartao ? 'Credit Card Payment' : 'Transfer',
      category_confidence: 100, categorized_by: 'rule',
      status: 'auto', updated_at: new Date().toISOString(),
    }

    const espelho = (porValor.get(Math.abs(Number(t.amount)).toFixed(2)) || []).find((o: any) =>
      o.id !== t.id && !jaTransferencia.has(o.id) && !o.transfer_match_id &&
      o.account_id === conta.id &&
      Math.abs(Number(o.amount) + Number(t.amount)) < 0.005 &&
      dias(o.tx_date, t.tx_date) <= 7)

    const { error: e1 } = await db.from('bank_transactions').update({
      ...base,
      counterparty_account_id: conta.id,
      ...(espelho ? { transfer_match_id: espelho.id } : {}),
    }).eq('id', t.id)
    if (e1) continue
    jaTransferencia.add(t.id); transferidas++

    if (espelho) {
      await db.from('bank_transactions').update({
        ...base, transfer_match_id: t.id, counterparty_account_id: t.account_id,
      }).eq('id', espelho.id)
      jaTransferencia.add(espelho.id); transferidas++
    }
  }


  // ── Pagamento DENTRO do cartão de crédito ──
  // Na fatura, o pagamento recebido ("PAYMENT - THANK YOU") é quitação de
  // dívida, nunca receita. A despesa real são as COMPRAS do cartão.
  const ehPagamentoNoCartao = (desc: string, amount: number, contaId: string | null): boolean => {
    if (amount <= 0) return false
    if (!/credit|card|cart/.test(String(tipoConta.get(contaId || '') || ''))) return false
    return /(^|[^a-z])(payment|pmt|autopay|crcardpmt)([^a-z]|$)|thank you/i.test(desc)
  }

  for (const t of txs) {
    if (jaTransferencia.has(t.id) || t.transfer_match_id) continue
    if (!ehPagamentoNoCartao(String(t.description), Number(t.amount), t.account_id)) continue

    // Procura a saída correspondente na conta corrente (mesma quantia, até 7 dias)
    const espelhoCC = (porValor.get(Math.abs(Number(t.amount)).toFixed(2)) || []).find((o: any) =>
      o.id !== t.id && !jaTransferencia.has(o.id) && !o.transfer_match_id &&
      o.account_id && o.account_id !== t.account_id &&
      Math.abs(Number(o.amount) + Number(t.amount)) < 0.005 &&
      dias(o.tx_date, t.tx_date) <= 7)

    const base = {
      category: 'Credit Card Payment', category_confidence: 100,
      categorized_by: 'rule', status: 'auto', updated_at: new Date().toISOString(),
    }
    const { error: ec } = await db.from('bank_transactions').update({
      ...base,
      ...(espelhoCC ? { transfer_match_id: espelhoCC.id, counterparty_account_id: espelhoCC.account_id } : {}),
    }).eq('id', t.id)
    if (ec) continue
    jaTransferencia.add(t.id); transferidas++

    if (espelhoCC) {
      await db.from('bank_transactions').update({
        ...base, transfer_match_id: t.id, counterparty_account_id: t.account_id,
      }).eq('id', espelhoCC.id)
      jaTransferencia.add(espelhoCC.id); transferidas++
    }
  }

  // Agrupa por categoria+payee e grava em lote (evita 1 UPDATE por lançamento)
  const lotes = new Map<string, { category: string; payee: string | null; ids: string[] }>()
  for (const tx of txs) {
    if (jaTransferencia.has(tx.id)) continue   // já resolvida como transferência
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
  return applied + transferidas
}
