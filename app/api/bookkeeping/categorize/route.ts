// POST /api/bookkeeping/categorize — categoriza as transações pendentes de um cliente
// Body: { clientId, year? }
// 1º regras (do cliente + globais, por prioridade) → 2º IA em lote → ≥95% vira 'auto',
// abaixo disso fica 'pending' com sugestão + confiança para a equipe revisar.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

export const maxDuration = 300  // Vercel Pro: até 300s — lotes grandes na sugestão da IA

async function loadCategories(db: any): Promise<string[]> {
  const { data } = await db.from('bookkeeping_categories').select('name').eq('active', true)
  return (data || []).map((c: any) => c.name)
}

const AI_PROMPT = (txList: string, cats: string[]) => `You are a bookkeeping categorization engine for a US accounting firm (cash-basis, small business).

Categorize each bank transaction into EXACTLY ONE of these categories:
${cats.join(', ')}

Guidelines:
- Positive amounts are deposits/credits; negative are payments/debits
- "Income": customer payments, sales deposits. "Owner Contribution": owner putting personal money in
- "Owner Draw": ATM withdrawals, transfers to owner. "Personal": clearly personal spending (groceries for home, personal shopping) in a business account
- "Transfer": movements between the client's own accounts, Zelle to self — transfers are NEITHER income NOR expense
- Payments FROM checking TO a credit card ("payment to chase card", "crcardpmt", "online payment thank you") = "Credit Card Payment" (liability payment, NOT an expense — the expenses live on the credit card statement itself)
- On CREDIT CARD statements: purchases are the actual expenses (categorize normally); payments received on the card = "Credit Card Payment"
- Restaurants/food during business = "Meals". Supermarkets are usually "Personal" unless clearly supplies
- Liquor stores, entertainment = "Personal" unless the business is hospitality
- confidence: 0-100, your certainty. Be conservative: ambiguous merchant = lower confidence

Also extract the PAYEE (vendor/person paid or payer) from each description:
- Normalize the name: "CHECKCARD 0929 AT&T*BILL PAYMENT 800-331-0500 TX" → "AT&T"
- "Zelle Transfer Conf# abc; Paulo Bruestle" → "Paulo Bruestle"
- "STAR MARKET 35 09/29 #000130919 PURCHASE" → "Star Market"
- Checks without payee info → null. ATM/generic deposits → null

Respond ONLY with a JSON array, no markdown:
[{"id":"...","category":"...","confidence":95,"payee":"AT&T"}]

Transactions:
${txList}`

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const { clientId, year, mode } = await req.json()
  const useAI = mode === 'ai'   // padrão: SÓ regras — nada é pré-definido sem regra
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const CATEGORIES = await loadCategories(db)

  // Pendentes + reconhecidas (regras têm prioridade e também reprocessam as 'auto';
  // aprovadas/registro nunca são tocadas)
  // Lê TODAS as transações em páginas, em ordem estável.
  // (Antes havia um teto de 800 sem ordenação: em clientes com mais que isso,
  //  parte dos lançamentos nunca era avaliada — mesmo vendor pegava uns e outros não.)
  const PAGINA = 1000
  const txs: any[] = []
  for (let inicio = 0; ; inicio += PAGINA) {
    let q = db.from('bank_transactions')
      .select('id, description, amount, status, account_id, tx_date, transfer_match_id')
      .eq('client_id', clientId)
      .in('status', ['pending', 'auto'])
      .order('id', { ascending: true })
      .range(inicio, inicio + PAGINA - 1)
    if (year) q = q.eq('fiscal_year', year)
    const { data: pagina, error: pErr } = await q
    if (pErr) return NextResponse.json({ error: `Falha ao ler transações: ${pErr.message}` }, { status: 500 })
    if (!pagina || pagina.length === 0) break
    txs.push(...pagina)
    if (pagina.length < PAGINA) break
  }
  if (txs.length === 0) return NextResponse.json({ ok: true, ruled: 0, ai: 0, review: 0, message: 'Nada pendente' })

  // Regras por prioridade. Em non-profit, SÓ as do próprio cliente:
  // cada entidade tem fundos/projetos únicos, regra global não se aplica.
  const { data: cli } = await db.from('clients')
    .select('business_kind').eq('id', clientId).maybeSingle()
  const soDoCliente = cli?.business_kind === 'nonprofit'

  let rq = db.from('bookkeeping_rules')
    .select('pattern, category, priority, client_id, direction, match_type, amount_op, amount_value, payee, account_id')
  rq = soDoCliente
    ? rq.eq('client_id', clientId)
    : rq.or(`client_id.eq.${clientId},client_id.is.null`)
  const { data: rules } = await rq.order('priority', { ascending: true })

  const ruleMatches = (r: any, desc: string, amount: number, accountId: string | null): boolean => {
    // Conta (fundo): regra restrita a uma conta só vale naquela conta
    if (r.account_id && r.account_id !== accountId) return false
    // Direção
    if (r.direction === 'in' && amount <= 0) return false
    if (r.direction === 'out' && amount >= 0) return false
    // Descrição — múltiplas variações separadas por | (OR)
    if (r.pattern) {
      const variants = r.pattern.toLowerCase().split('|').map((v: string) => v.trim()).filter(Boolean)
      const hit = variants.some((v: string) => r.match_type === 'starts_with' ? desc.startsWith(v) : desc.includes(v))
      if (!hit) return false
    }
    // Valor (comparação pelo valor absoluto)
    if (r.amount_op) {
      const abs = Math.abs(amount), v = Number(r.amount_value)
      if (r.amount_op === 'gt' && !(abs > v)) return false
      if (r.amount_op === 'lt' && !(abs < v)) return false
      if (r.amount_op === 'eq' && Math.abs(abs - v) > 0.005) return false
    }
    return true
  }

  let ruled = 0
  const unresolved: any[] = []
  const erros: string[] = []

  // Agrupa por (categoria + payee) e grava em lote — antes era um UPDATE por
  // lançamento, o que estourava o tempo em clientes com muitos movimentos.
  const lotes = new Map<string, { category: string; payee: string | null; ids: string[] }>()

  for (const tx of txs) {
    const desc = String(tx.description).toLowerCase()
    const rule = (rules || []).find((r: any) => ruleMatches(r, desc, Number(tx.amount), tx.account_id || null))
    if (!rule) { unresolved.push(tx); continue }
    const chave = `${rule.category}||${rule.payee || ''}`
    const grupo = lotes.get(chave) || { category: rule.category as string, payee: (rule.payee || null) as string | null, ids: [] as string[] }
    grupo.ids.push(tx.id)
    lotes.set(chave, grupo)
  }

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
      if (error) erros.push(`${grupo.category}: ${error.message}`)
      else ruled += fatia.length
    }
  }

  // ── Transferências entre contas do próprio cliente ──
  // Espelho exato (valor oposto, contas diferentes, até 7 dias). Só vincula
  // quando há UM único candidato — e entra como 'auto', aguardando aprovação.
  let transfers = 0
  const { data: contasCli } = await db.from('bank_accounts')
    .select('id, name, type').eq('client_id', clientId)
  const tipoConta = new Map((contasCli || []).map((a: any) => [a.id, String(a.type || '').toLowerCase()]))

  const dias = (a: string, b: string) =>
    Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000)

  const porValor = new Map<string, any[]>()
  for (const t of txs) {
    const k = Math.abs(Number(t.amount)).toFixed(2)
    if (!porValor.has(k)) porValor.set(k, [])
    porValor.get(k)!.push(t)
  }

  const usados = new Set<string>()
  const naoCasadas: any[] = []

  for (const t of unresolved) {
    if (usados.has(t.id) || t.transfer_match_id) { naoCasadas.push(t); continue }
    const k = Math.abs(Number(t.amount)).toFixed(2)
    const cands = (porValor.get(k) || []).filter((o: any) =>
      o.id !== t.id && !usados.has(o.id) && !o.transfer_match_id &&
      o.account_id && t.account_id && o.account_id !== t.account_id &&
      Math.abs(Number(o.amount) + Number(t.amount)) < 0.005 &&
      dias(o.tx_date, t.tx_date) <= 7)

    if (cands.length !== 1) { naoCasadas.push(t); continue }
    const par = cands[0]
    const ehCartao = /credit|card|cart/.test(
      (tipoConta.get(t.account_id) || '') + ' ' + (tipoConta.get(par.account_id) || ''))
    const cat = ehCartao ? 'Credit Card Payment' : 'Transfer'
    const base = {
      category: cat, category_confidence: 100, categorized_by: 'rule',
      status: 'auto', updated_at: new Date().toISOString(),
    }
    const { error: t1 } = await db.from('bank_transactions')
      .update({ ...base, transfer_match_id: par.id, counterparty_account_id: par.account_id }).eq('id', t.id)
    const { error: t2 } = await db.from('bank_transactions')
      .update({ ...base, transfer_match_id: t.id, counterparty_account_id: t.account_id }).eq('id', par.id)
    if (t1 || t2) { erros.push(`transferência: ${(t1 || t2)!.message}`); naoCasadas.push(t); continue }
    usados.add(t.id); usados.add(par.id)
    transfers += 2
  }

  // IA em lote no que sobrou
  let aiAuto = 0, review = 0
  const aiCandidates = naoCasadas.filter((t: any) => t.status === 'pending' && !usados.has(t.id))
  if (useAI && aiCandidates.length > 0) {
    const txList = aiCandidates.map(t => JSON.stringify({ id: t.id, description: t.description, amount: t.amount })).join('\n')

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        messages: [{ role: 'user', content: AI_PROMPT(txList, CATEGORIES) }],
      }),
    })

    // Regra contábil: Transfer/Credit Card Payment SÓ com a conta contraparte no sistema
    const { data: clientAccounts } = await db.from('bank_accounts')
      .select('id, type').eq('client_id', clientId).eq('active', true)
    const accountCount = (clientAccounts || []).length
    const hasCreditCard = (clientAccounts || []).some(a => a.type === 'credit_card')

    if (response.ok) {
      const data = await response.json()
      const text = (data.content?.find((b: any) => b.type === 'text')?.text || '')
        .replace(/```json|```/g, '').trim()
      let results: { id: string; category: string; confidence: number }[] = []
      try { results = JSON.parse(text) } catch { results = [] }

      for (const r of results) {
        if (!r.id || !CATEGORIES.includes(r.category)) continue
        let conf = Math.max(0, Math.min(100, Number(r.confidence) || 0))

        // Transfer exige ≥2 contas do cliente no sistema; Credit Card Payment exige um cartão cadastrado.
        // Sem a contraparte "baixada", vira revisão manual (pode ser saída real, não transferência).
        if (r.category === 'Transfer' && accountCount < 2) conf = Math.min(conf, 50)
        if (r.category === 'Credit Card Payment' && !hasCreditCard) conf = Math.min(conf, 50)

        const isAuto = conf >= 95
        const payee = typeof (r as any).payee === 'string' && (r as any).payee.trim().length >= 2
          ? (r as any).payee.trim().slice(0, 120) : null
        await db.from('bank_transactions').update({
          category: r.category, category_confidence: conf,
          categorized_by: 'ai', payee,
          status: isAuto ? 'auto' : 'pending',   // <95%: sugestão fica, status segue pendente
          updated_at: new Date().toISOString(),
        }).eq('id', r.id).eq('client_id', clientId)
        if (isAuto) aiAuto++; else review++
      }
    } else {
      review = aiCandidates.length
    }
  }

  // Backfill: payee ausente em transações já categorizadas (regras antigas não extraíam)
  let payeesFilled = 0
  const { data: noPayee } = await db.from('bank_transactions')
    .select('id, description')
    .eq('client_id', clientId)
    .is('payee', null)
    .in('status', ['auto', 'reviewed'])
    .limit(200)
  if (noPayee && noPayee.length > 0) {
    const listStr = noPayee.map(t => JSON.stringify({ id: t.id, description: t.description })).join('\n')
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 6000,
        messages: [{ role: 'user', content: `Extract the normalized PAYEE (vendor/person) from each bank transaction description. Examples: "CHECKCARD AT&T*BILL PAYMENT" → "AT&T"; "Zelle Conf#abc; Paulo Bruestle" → "Paulo Bruestle"; generic deposits/ATM → null.\nRespond ONLY a JSON array: [{"id":"...","payee":"..."}] (payee null if unknown)\n\n${listStr}` }],
      }),
    })
    if (resp.ok) {
      const d2 = await resp.json()
      const t2 = (d2.content?.find((b: any) => b.type === 'text')?.text || '').replace(/```json|```/g, '').trim()
      try {
        const arr = JSON.parse(t2)
        for (const r of arr) {
          if (r.id && typeof r.payee === 'string' && r.payee.trim().length >= 2) {
            await db.from('bank_transactions').update({ payee: r.payee.trim().slice(0, 120) })
              .eq('id', r.id).eq('client_id', clientId)
            payeesFilled++
          }
        }
      } catch {}
    }
  }

  return NextResponse.json({
    ok: true, ruled, ai: aiAuto, review, payeesFilled, transfers,
    avaliadas: txs.length,
    erros: erros.length ? erros.slice(0, 5) : undefined,
  })
}
