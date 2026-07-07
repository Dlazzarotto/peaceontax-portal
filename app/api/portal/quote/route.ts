// POST /api/portal/quote
// Gera cotação automática baseada nos documentos classificados pela IA.
// Body: { clientId, fiscalYear }
// Retorna: { quote, saved: boolean }

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { calculateQuote, type ClientDocProfile } from '@/lib/pricing'

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuth()
    if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

    const { clientId, fiscalYear } = await req.json()
    if (!clientId || !fiscalYear) {
      return NextResponse.json({ error: 'clientId e fiscalYear obrigatórios' }, { status: 400 })
    }
    if (!(await canAccessClient(auth, clientId))) {
      return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
    }

    const db = serviceDb()

    // Busca cliente para filing_status
    const { data: client } = await db
      .from('clients')
      .select('filing_status, type')
      .eq('id', clientId)
      .single()

    // Busca documentos do ano fiscal
    const { data: docs } = await db
      .from('documents')
      .select('doc_type, category, file_name')
      .eq('client_id', clientId)
      .eq('tax_year', fiscalYear)

    const allDocs = docs || []

    // Mapeamento category → doc_type para documentos sem classificação IA
    const resolveType = (doc: any): string => {
      if (doc.doc_type) return doc.doc_type
      const cat = (doc.category || '').toLowerCase()
      if (cat.includes('w-2') || cat.includes('w2'))   return 'w2'
      if (cat.includes('1099'))                         return '1099'
      if (cat.includes('1098'))                         return '1098'
      if (cat.includes('bank'))                         return 'bank_statement'
      if (cat.includes('income'))                       return 'receipt_income'
      if (cat.includes('expense'))                      return 'receipt_expense'
      return 'other'
    }

    const types = allDocs.map(resolveType)
    const count = (t: string) => types.filter(x => x === t).length

    const profile: ClientDocProfile = {
      filingStatus: (client?.filing_status === 'Married Filing Jointly' ? 'married' : 'single'),
      w2Count:        count('w2'),
      dependents:     0,   // vem do organizer (fase futura) — 0 como default
      scheduleCCount: count('1099'),
      has1098:        types.includes('1098') || allDocs.some(d => (d.category||'').toLowerCase().includes('mortgage')),
      scheduleECount: allDocs.filter(d => (d.category||'').toLowerCase().includes('rental') || (d.category||'').toLowerCase().includes('aluguel')).length,
      extraStateCount: 0,  // vem do organizer — 0 como default
      hasScheduleB:   allDocs.some(d => (d.file_name||'').toLowerCase().includes('1099-int') || (d.file_name||'').toLowerCase().includes('1099-div') || (d.category||'').toLowerCase().includes('investment')),
      has1099B:       allDocs.some(d => (d.file_name||'').toLowerCase().includes('1099-b') || (d.category||'').toLowerCase().includes('brokerage')),
      has1095A:       allDocs.some(d => (d.file_name||'').toLowerCase().includes('1095') || (d.category||'').toLowerCase().includes('health')),
      hasLLC:         (client?.type === 'business') && allDocs.some(d => (d.file_name||'').toLowerCase().includes('llc')),
      hasCryptoNoReport: false,
    }

    const result = calculateQuote(profile)

    // Salva cotação como draft (idempotente: não duplica se já existe draft)
    let savedQuoteId: string | null = null
    if (!result.needsManualReview && auth.isStaff) {
      const { data: existing } = await db
        .from('quotes')
        .select('id')
        .eq('client_id', clientId)
        .eq('fiscal_year', fiscalYear)
        .eq('status', 'draft')
        .maybeSingle()

      if (!existing) {
        const { data: saved } = await db
          .from('quotes')
          .insert({
            client_id:   clientId,
            fiscal_year: fiscalYear,
            items:       result.items,
            total:       result.total,
            status:      'draft',
            created_by:  auth.userId,
          })
          .select('id')
          .single()
        savedQuoteId = saved?.id ?? null
      } else {
        // Atualiza draft existente
        await db.from('quotes').update({ items: result.items, total: result.total, updated_at: new Date().toISOString() }).eq('id', existing.id)
        savedQuoteId = existing.id
      }
    }

    return NextResponse.json({ quote: result, quoteId: savedQuoteId, profile })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
