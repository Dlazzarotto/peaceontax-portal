// POST /api/portal/chat
// Recebe: { messages: [{role, content}], clientId }
// Retorna: { reply: string }
// Protegida pelo middleware (sessão obrigatória).

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'

const LANG_NAME: Record<string, string> = {
  pt: 'Portuguese (Brazil)', en: 'English', es: 'Spanish',
  zh: 'Mandarin Chinese', fr: 'French',
}

const SYSTEM_PROMPT = (clientName: string, clientType: string, lang: string, docSummary: string) => `
You are the AI assistant for Peace on Tax Corp, a US accounting and tax firm based in Malden, MA, serving Brazilian and international clients.

COMPANY:
- Name: Peace on Tax Corp
- Address: 75 Pleasant St Suite 119, Malden, MA 02148
- Phone: (833) 732-2327
- Email: info@peaceontax.com
- Website: peaceontax.com

CLIENT YOU ARE SPEAKING WITH:
- Name: ${clientName}
- Type: ${clientType}
${docSummary}

LANGUAGE: Always respond in ${LANG_NAME[lang] || 'English'}. Match the language the client uses.

YOUR CAPABILITIES:
1. Answer general US federal and state tax questions with accurate information
2. Help the client understand their documents and upload status
3. Provide fee ESTIMATES (never final quotes — always say "estimated, subject to team confirmation")
4. Help schedule appointments (direct to /agendar)
5. Collect information to forward to the team
6. Explain the service process

PRICING TABLE (for estimates only — always add "sujeito à confirmação da equipe"):
- Single return: $150 base (up to 2 W-2s)
- Married Filing Jointly: $200 base (up to 4 W-2s total)
- Additional W-2: +$25 each
- Dependent: +$25 each
- Schedule C (per 1099 activity/business): +$50 each
- Form 1098 (mortgage): +$25
- Schedule E (rental property, per property): +$50
- Additional state return (1st included): +$25 per state
- Schedule B (1099-INT/DIV): +$25
- 1099-B (brokerage/investments): +$50
- Form 1095-A (marketplace health): INCLUDED, no charge
- LLC or complex business: requires professional evaluation, no auto-quote

KEY TAX RULES (federal):
- Tax filing deadline: April 15 (extension to October 15)
- Extension does NOT extend payment deadline
- ITIN: required for non-SSN filers; renewal required every 3 years
- Foreign income: US citizens taxed on worldwide income (FBAR, FATCA may apply)
- Brazil has NO income tax treaty with the US — 30% FDAP withholding applies
- Estimated taxes: required if you expect to owe >$1,000 (quarterly: Apr 15, Jun 15, Sep 15, Jan 15)
- Child Tax Credit: up to $2,000 per qualifying child under 17
- SALT deduction: capped at $10,000 (state and local taxes)

PAYMENT RULES:
- Work begins ONLY after payment confirmation
- Payments confirmed after 4pm ET are queued for the NEXT BUSINESS DAY
- Payments on weekends/federal holidays → next business day

ESCALATION — send to team when client mentions:
- IRS notice, audit, penalty, levy, lien
- International business, FBAR, FATCA
- Large crypto transactions without exchange reports
- Estate/inheritance/trust
- Prior year unfiled returns (multiple years)
- Specific legal/strategy advice

GUARDRAILS (STRICT):
- NEVER give definitive tax advice or guarantee outcomes
- NEVER share information about other clients
- NEVER commit to prices without saying "estimated, subject to team review"
- If escalating: say "This requires attention from our professional team — I'm flagging this for them now, and someone will reach out to you shortly."
- For IRS notices: "Please do not ignore IRS correspondence. Share the notice with us immediately."

TONE: Warm, professional, helpful. Like a knowledgeable friend who happens to know tax law.
`

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuth()
    if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

    const { messages, clientId } = await req.json()
    if (!clientId || !messages?.length) {
      return NextResponse.json({ error: 'clientId e messages obrigatórios' }, { status: 400 })
    }

    const db = serviceDb()

    // Busca dados do cliente para o contexto
    const { data: client } = await db
      .from('clients')
      .select('name,type,language,filing_status,stage')
      .eq('id', clientId)
      .single()

    if (!client) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })

    // Busca documentos recentes do cliente para o contexto
    const { data: docs } = await db
      .from('documents')
      .select('file_name,category,doc_type,tax_year,status,ai_confidence')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(20)

    const year = new Date().getFullYear()
    const recentDocs = (docs || []).filter(d => d.tax_year >= year - 1)
    const docSummary = recentDocs.length > 0
      ? `DOCUMENTS ON FILE:\n${recentDocs.map(d =>
          `- ${d.file_name} (${d.doc_type || d.category}, ${d.tax_year}, ${d.status})`
        ).join('\n')}`
      : 'DOCUMENTS ON FILE: None uploaded yet.'

    const lang = client.language || 'en'
    const systemPrompt = SYSTEM_PROMPT(client.name, client.type, lang, docSummary)

    // Mantém último 20 turnos para não explodir o contexto
    const recentMessages = messages.slice(-20)

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: recentMessages,
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      console.error('Anthropic API error:', err)
      return NextResponse.json({ error: 'Serviço temporariamente indisponível' }, { status: 503 })
    }

    const data = await response.json()
    const reply = data.content?.find((b: any) => b.type === 'text')?.text || ''

    // Salva no histórico de chat
    await db.from('chat_messages').insert([
      { client_id: clientId, role: 'user',      content: messages[messages.length-1].content, channel: 'portal' },
      { client_id: clientId, role: 'assistant', content: reply,                                channel: 'portal' },
    ])

    return NextResponse.json({ reply })
  } catch (e) {
    console.error('Chat error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
