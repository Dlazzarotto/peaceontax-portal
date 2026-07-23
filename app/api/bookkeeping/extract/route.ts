// POST /api/bookkeeping/extract — extrai transações de um extrato bancário (PDF)
// Body: { documentId }
// Baixa o PDF do storage → Claude lê e extrai → insere em bank_transactions (com dedupe).
// Equipe apenas. Custo: ~1 chamada de IA por extrato.

import { NextRequest, NextResponse } from 'next/server'
import { applyRulesToClient } from '@/lib/apply-rules'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

export const maxDuration = 120  // extratos longos podem demorar

const EXTRACTION_PROMPT = `You are a bank statement transaction extractor for an accounting firm.

Extract EVERY transaction from this bank statement PDF. Respond with ONLY a JSON object, no markdown fences, no explanations:

{
  "account_hint": "Bank name and last 4 digits if visible (e.g. 'Bank of America ...1234')",
  "period": "statement period if visible (e.g. '2020-09-01 to 2020-09-30')",
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "transaction description exactly as shown",
      "amount": -123.45,
      "balance": 4567.89
    }
  ]
}

RULES:
- amount: NEGATIVE for debits/withdrawals/payments/fees, POSITIVE for credits/deposits
- balance: running balance after the transaction if the statement shows it, otherwise omit
- Include ALL transactions: deposits, withdrawals, checks, fees, transfers, card purchases
- Do NOT include: beginning/ending balance summary lines, subtotals, headers
- If the year is ambiguous on a date, infer from the statement period
- Dates must be YYYY-MM-DD format
- Do not skip any transaction, even small fees`

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito à equipe' }, { status: 403 })

  const { documentId } = await req.json()
  if (!documentId) return NextResponse.json({ error: 'documentId obrigatório' }, { status: 400 })

  const db = serviceDb()

  // Busca o documento
  const { data: doc } = await db
    .from('documents')
    .select('id, client_id, file_name, storage_path, file_type, tax_year')
    .eq('id', documentId)
    .single()

  if (!doc) return NextResponse.json({ error: 'Documento não encontrado' }, { status: 404 })
  if (!(await canAccessClient(auth, doc.client_id))) {
    return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
  }
  if (!doc.file_type?.includes('pdf')) {
    return NextResponse.json({ error: 'Apenas PDFs de extrato bancário' }, { status: 400 })
  }

  // Já extraído?
  const { count: existing } = await db
    .from('bank_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('statement_document_id', documentId)
  if ((existing ?? 0) > 0) {
    return NextResponse.json({ error: `Este extrato já foi processado (${existing} transações). Exclua-as antes de reprocessar.`, alreadyExtracted: true }, { status: 409 })
  }

  // Baixa o PDF do storage
  const { data: file, error: dlErr } = await db.storage
    .from('client-documents')
    .download(doc.storage_path)
  if (dlErr || !file) return NextResponse.json({ error: `Falha ao baixar o PDF: ${dlErr?.message}` }, { status: 500 })

  const pdfBase64 = Buffer.from(await file.arrayBuffer()).toString('base64')
  if (pdfBase64.length > 40_000_000) {
    return NextResponse.json({ error: 'PDF muito grande (limite ~30MB)' }, { status: 400 })
  }

  // IA extrai
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        }],
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      console.error('Anthropic error:', err)
      return NextResponse.json({ error: 'IA temporariamente indisponível' }, { status: 503 })
    }

    const data = await response.json()
    const text = (data.content?.find((b: any) => b.type === 'text')?.text || '')
      .replace(/```json|```/g, '').trim()

    let parsed: { account_hint?: string; transactions: any[] }
    try {
      parsed = JSON.parse(text)
    } catch {
      console.error('Parse fail:', text.slice(0, 500))
      return NextResponse.json({ error: 'A IA não retornou JSON válido — tente novamente' }, { status: 502 })
    }

    const txs = (parsed.transactions || []).filter(t =>
      t.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date) &&
      t.description && typeof t.amount === 'number' && Math.abs(t.amount) < 10_000_000
    )
    if (txs.length === 0) {
      return NextResponse.json({ error: 'Nenhuma transação identificada no PDF' }, { status: 422 })
    }

    // Conta bancária: upsert a partir do account_hint do extrato
    let accountId: string | null = null
    const hint = parsed.account_hint?.trim()
    if (hint) {
      const isCC = /credit|card/i.test(hint)
      const { data: acc } = await db.from('bank_accounts')
        .upsert(
          { client_id: doc.client_id, name: hint, account_hint: hint, type: isCC ? 'credit_card' : 'checking' },
          { onConflict: 'client_id,name' }
        ).select('id').single()
      accountId = acc?.id ?? null
    }

    // Insere com dedupe (upsert ignora duplicadas)
    const rows = txs.map(t => ({
      account_id: accountId,
      client_id: doc.client_id,
      source: 'pdf',
      statement_document_id: documentId,
      account_hint: parsed.account_hint || null,
      tx_date: t.date,
      description: String(t.description).slice(0, 500),
      amount: Math.round(t.amount * 100) / 100,
      balance: typeof t.balance === 'number' ? Math.round(t.balance * 100) / 100 : null,
      status: 'pending',
    }))

    const { data: inserted, error: insErr } = await db
      .from('bank_transactions')
      .upsert(rows, { onConflict: 'client_id,tx_date,description,amount', ignoreDuplicates: true })
      .select('id')

    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })

    const insertedCount = inserted?.length ?? 0
    const duplicates = rows.length - insertedCount

    // Regras aplicam AUTOMATICAMENTE às transações importadas (estilo QuickBooks)
    const ruled = insertedCount > 0 ? await applyRulesToClient(db, doc.client_id).catch(() => 0) : 0

    return NextResponse.json({
      ok: true,
      ruled,
      extracted: rows.length,
      inserted: insertedCount,
      duplicates,
      accountHint: parsed.account_hint || null,
    })
  } catch (e) {
    console.error('Extract error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
