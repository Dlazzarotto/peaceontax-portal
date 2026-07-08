// POST /api/bookkeeping/categorize — categoriza as transações pendentes de um cliente
// Body: { clientId, year? }
// 1º regras (do cliente + globais, por prioridade) → 2º IA em lote → ≥95% vira 'auto',
// abaixo disso fica 'pending' com sugestão + confiança para a equipe revisar.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

export const maxDuration = 120

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

  const { clientId, year } = await req.json()
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const CATEGORIES = await loadCategories(db)

  // Pendentes sem categoria confirmada
  let q = db.from('bank_transactions')
    .select('id, description, amount')
    .eq('client_id', clientId)
    .eq('status', 'pending')
    .limit(400)
  if (year) q = q.eq('fiscal_year', year)
  const { data: txs } = await q
  if (!txs || txs.length === 0) return NextResponse.json({ ok: true, ruled: 0, ai: 0, review: 0, message: 'Nada pendente' })

  // Regras: do cliente + globais, por prioridade
  const { data: rules } = await db.from('bookkeeping_rules')
    .select('pattern, category, priority, client_id, direction, match_type, amount_op, amount_value, payee')
    .or(`client_id.eq.${clientId},client_id.is.null`)
    .order('priority', { ascending: true })

  const ruleMatches = (r: any, desc: string, amount: number): boolean => {
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
  const unresolved: typeof txs = []

  for (const tx of txs) {
    const desc = tx.description.toLowerCase()
    const rule = (rules || []).find(r => ruleMatches(r, desc, Number(tx.amount)))
    if (rule) {
      const upd: Record<string, unknown> = {
        category: rule.category, category_confidence: 100,
        categorized_by: 'rule', status: 'auto',
        updated_at: new Date().toISOString(),
      }
      if (rule.payee) upd.payee = rule.payee
      await db.from('bank_transactions').update(upd).eq('id', tx.id)
      ruled++
    } else {
      unresolved.push(tx)
    }
  }

  // IA em lote no que sobrou
  let aiAuto = 0, review = 0
  if (unresolved.length > 0) {
    const txList = unresolved.map(t => JSON.stringify({ id: t.id, description: t.description, amount: t.amount })).join('\n')

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

    if (response.ok) {
      const data = await response.json()
      const text = (data.content?.find((b: any) => b.type === 'text')?.text || '')
        .replace(/```json|```/g, '').trim()
      let results: { id: string; category: string; confidence: number }[] = []
      try { results = JSON.parse(text) } catch { results = [] }

      for (const r of results) {
        if (!r.id || !CATEGORIES.includes(r.category)) continue
        const conf = Math.max(0, Math.min(100, Number(r.confidence) || 0))
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
      review = unresolved.length
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

  return NextResponse.json({ ok: true, ruled, ai: aiAuto, review, payeesFilled })
}
