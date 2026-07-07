// POST /api/portal/quote
// - PF: cotação automática pelos documentos classificados
// - Business: SEM cotação automática. Com { manualBlank: true } cria rascunho vazio p/ equipe montar.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { type ClientDocProfile } from '@/lib/pricing'
import { calculateQuoteFromDb } from '@/lib/pricing-db'
import { auditQuote } from '@/lib/staff-perms'

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuth()
    if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

    const { clientId, fiscalYear, manualBlank } = await req.json()
    if (!clientId || !fiscalYear) {
      return NextResponse.json({ error: 'clientId e fiscalYear obrigatórios' }, { status: 400 })
    }
    if (!(await canAccessClient(auth, clientId))) {
      return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
    }

    const db = serviceDb()
    const { data: client } = await db
      .from('clients')
      .select('filing_status, type')
      .eq('id', clientId)
      .single()

    const isBusiness = client?.type === 'business'

    // ---- Rascunho manual (business ou qualquer caso especial) — só equipe ----
    if (manualBlank) {
      if (!auth.isStaff) return NextResponse.json({ error: 'Somente equipe' }, { status: 403 })

      const { data: existing } = await db.from('quotes').select('id')
        .eq('client_id', clientId).eq('fiscal_year', fiscalYear)
        .in('status', ['draft','sent']).maybeSingle()
      if (existing) {
        return NextResponse.json({ quoteId: existing.id, quote: { items: [], total: 0, needsManualReview: false }, existing: true })
      }

      const blankItems = [{ label: isBusiness ? 'Serviços contábeis — descrever' : 'Serviço — descrever', amount: 0 }]
      const { data: saved, error } = await db.from('quotes').insert({
        client_id: clientId, fiscal_year: fiscalYear,
        items: blankItems, total: 0, status: 'draft', created_by: auth.userId,
      }).select('id').single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })

      await auditQuote({ quoteId: saved.id, action: 'created', performedBy: auth.userId, newState: { items: blankItems, total: 0 } })
      return NextResponse.json({ quoteId: saved.id, quote: { items: blankItems, total: 0, needsManualReview: false } })
    }

    // ---- Business NÃO tem cotação automática ----
    if (isBusiness) {
      return NextResponse.json({
        quote: {
          items: [], total: 0, needsManualReview: true,
          reviewReason: 'Cliente business — a cotação deve ser montada manualmente pela equipe (use "Criar rascunho manual").',
        },
      })
    }

    // ---- PF: cotação automática pelos documentos ----
    const { data: docs } = await db
      .from('documents')
      .select('doc_type, category, file_name')
      .eq('client_id', clientId)
      .eq('tax_year', fiscalYear)

    const allDocs = docs || []
    const resolveType = (doc: any): string => {
      if (doc.doc_type) return doc.doc_type
      const cat = (doc.category || '').toLowerCase()
      if (cat.includes('w-2') || cat.includes('w2')) return 'w2'
      if (cat.includes('1099')) return '1099'
      if (cat.includes('1098')) return '1098'
      return 'other'
    }
    const types = allDocs.map(resolveType)
    const count = (t: string) => types.filter(x => x === t).length

    const lc = (s?: string) => (s || '').toLowerCase()
    const profile: ClientDocProfile = {
      filingStatus: client?.filing_status === 'Married Filing Jointly' ? 'married' : 'single',
      w2Count:        count('w2'),
      dependents:     0,
      scheduleCCount: count('1099'),
      has1098:        types.includes('1098') || allDocs.some(d => lc(d.category).includes('mortgage')),
      scheduleECount: allDocs.filter(d => lc(d.category).includes('rental')).length,
      extraStateCount: 0,
      hasScheduleB:   allDocs.some(d => lc(d.file_name).includes('1099-int') || lc(d.file_name).includes('1099-div')),
      has1099B:       allDocs.some(d => lc(d.file_name).includes('1099-b') || lc(d.category).includes('brokerage')),
      has1095A:       allDocs.some(d => lc(d.file_name).includes('1095')),
      hasLLC:         false,
      hasCryptoNoReport: false,
    }

    const result = await calculateQuoteFromDb(profile)

    let savedQuoteId: string | null = null
    if (!result.needsManualReview && auth.isStaff) {
      const { data: existing } = await db.from('quotes').select('id')
        .eq('client_id', clientId).eq('fiscal_year', fiscalYear).eq('status', 'draft').maybeSingle()

      if (!existing) {
        const { data: saved } = await db.from('quotes').insert({
          client_id: clientId, fiscal_year: fiscalYear,
          items: result.items, total: result.total, status: 'draft', created_by: auth.userId,
        }).select('id').single()
        savedQuoteId = saved?.id ?? null
        if (savedQuoteId) {
          await auditQuote({ quoteId: savedQuoteId, action: 'created', performedBy: auth.userId, newState: { items: result.items, total: result.total } })
        }
      } else {
        await db.from('quotes').update({ items: result.items, total: result.total, updated_at: new Date().toISOString() }).eq('id', existing.id)
        savedQuoteId = existing.id
      }
    }

    return NextResponse.json({ quote: result, quoteId: savedQuoteId, profile })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
