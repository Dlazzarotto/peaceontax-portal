import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

export async function POST(req: NextRequest) {
  try {
    const { pdfBase64, bank, month, year } = await req.json()
    if (!pdfBase64 || !bank) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: `Extract ALL transactions from this ${bank} bank statement for ${month} ${year}. Return ONLY a valid JSON array:\n[{"date":"MM/DD/YYYY","payee":"name","memo":"desc","debit":"0.00","deposit":"0.00"}]` }
        ]
      }]
    })
    const text = response.content.filter(b => b.type==='text').map(b => (b as any).text).join('')
    const transactions = JSON.parse(text.replace(/```json|```/g, '').trim())
    return NextResponse.json({ transactions, summary: { total: transactions.length } })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
