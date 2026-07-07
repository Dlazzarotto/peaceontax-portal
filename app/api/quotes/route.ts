// GET /api/quotes?clientId=...
// Lista cotações de um cliente. Só equipe acessa.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) {
    return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
  }

  const { data, error } = await serviceDb()
    .from('quotes')
    .select('id,fiscal_year,items,total,status,paid_at,payment_queued_for,created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ quotes: data || [] })
}
