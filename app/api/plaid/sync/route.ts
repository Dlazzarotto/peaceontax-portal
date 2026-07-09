// POST /api/plaid/sync { clientId } — sincroniza TODAS as conexões do cliente (equipe)
import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { syncPlaidItem } from '@/lib/plaid-sync'

export const maxDuration = 120

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const { clientId } = await req.json()
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const { data: items } = await db.from('plaid_items')
    .select('id, institution_name').eq('client_id', clientId).eq('status', 'active')
  if (!items || items.length === 0) {
    return NextResponse.json({ error: 'Cliente sem bancos conectados via Plaid' }, { status: 404 })
  }

  let totalAdded = 0
  const results: string[] = []
  for (const item of items) {
    try {
      const r = await syncPlaidItem(db, item.id)
      totalAdded += r.added
      results.push(`${item.institution_name || 'Banco'}: +${r.added}`)
    } catch (e) {
      await db.from('plaid_items').update({ status: 'error' }).eq('id', item.id)
      results.push(`${item.institution_name || 'Banco'}: erro (${(e as Error).message})`)
    }
  }

  return NextResponse.json({ ok: true, added: totalAdded, details: results })
}
