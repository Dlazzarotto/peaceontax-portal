// GET /api/bookkeeping/payee-category?clientId=...&payee=...
//
// Devolve a conta (categoria) usada da última vez para esse payee NESTE cliente,
// olhando TODO o histórico — qualquer ano, qualquer banco — e, se não houver
// histórico, a regra que aponta para esse payee.
//
// Usada quando o usuário escolhe um payee na tabela: a conta vem junto.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  const payee = (sp.get('payee') || '').trim()
  if (!clientId || !payee) return NextResponse.json({ error: 'clientId e payee obrigatórios' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const key = payee.toLowerCase()

  // 1) Histórico do cliente — o lançamento mais recente com esse payee já categorizado
  const { data: hist } = await db
    .from('bank_transactions')
    .select('category, payee, tx_date, fiscal_year')
    .eq('client_id', clientId)
    .ilike('payee', payee)              // case-insensitive
    .not('category', 'is', null)
    .neq('status', 'excluded')
    .order('tx_date', { ascending: false })
    .limit(25)

  const hit = (hist || []).find(
    (t: any) => String(t.payee || '').trim().toLowerCase() === key && t.category
  )
  if (hit) {
    return NextResponse.json({
      ok: true, category: hit.category, source: 'historico',
      lastDate: hit.tx_date, year: hit.fiscal_year,
    })
  }

  // 2) Sem histórico: a regra que aponta para esse payee
  const { data: rules } = await db
    .from('bookkeeping_rules')
    .select('payee, category, client_id')
    .or(`client_id.eq.${clientId},client_id.is.null`)
    .limit(3000)

  const rule = (rules || []).find(
    (r: any) => String(r.payee || '').trim().toLowerCase() === key && r.category
  )
  if (rule) return NextResponse.json({ ok: true, category: rule.category, source: 'regra' })

  return NextResponse.json({ ok: true, category: null })
}
