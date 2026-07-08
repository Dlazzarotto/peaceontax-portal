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
- "Transfer": movements between own accounts, Zelle to self
- Restaurants/food during business = "Meals". Supermarkets are usually "Personal" unless clearly supplies
- Liquor stores, entertainment = "Personal" unless the business is hospitality
- confidence: 0-100, your certainty. Be conservative: ambiguous merchant = lower confidence

Respond ONLY with a JSON array, no markdown:
[{"id":"...","category":"...","confidence":95}]

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
    .select('pattern, category, priority, client_id')
    .or(`client_id.eq.${clientId},client_id.is.null`)
    .order('priority', { ascending: true })

  let ruled = 0
  const unresolved: typeof txs = []

  for (const tx of txs) {
    const desc = tx.description.toLowerCase()
    const rule = (rules || []).find(r => desc.includes(r.pattern.toLowerCase()))
    if (rule) {
      await db.from('bank_transactions').update({
        category: rule.category, category_confidence: 100,
        categorized_by: 'rule', status: 'auto',
        updated_at: new Date().toISOString(),
      }).eq('id', tx.id)
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
        await db.from('bank_transactions').update({
          category: r.category, category_confidence: conf,
          categorized_by: 'ai',
          status: isAuto ? 'auto' : 'pending',   // <95%: sugestão fica, status segue pendente
          updated_at: new Date().toISOString(),
        }).eq('id', r.id).eq('client_id', clientId)
        if (isAuto) aiAuto++; else review++
      }
    } else {
      review = unresolved.length
    }
  }

  return NextResponse.json({ ok: true, ruled, ai: aiAuto, review })
}
