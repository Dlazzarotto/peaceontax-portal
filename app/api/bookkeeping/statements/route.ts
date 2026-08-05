// GET /api/bookkeeping/statements?clientId=...
//
// Lista os extratos bancários (PDF) do cliente para a aba Bookkeeping:
// documentos usados como verificação e, quando necessário, importação.
//
// Lê direto da tabela `documents` — sem depender do endpoint geral do cliente,
// que pode paginar ou filtrar por outros critérios.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const { data, error } = await serviceDb()
    .from('documents')
    .select('id, file_name, category, tax_year, storage_path, created_at')
    .eq('client_id', clientId)
    // aceita "Bank Statements", "bank_statement", "Extratos", "Statements"...
    .or('category.ilike.%bank%,category.ilike.%extrat%,category.ilike.%statement%')
    .not('storage_path', 'is', null)
    .order('tax_year', { ascending: false })
    .order('file_name', { ascending: true })
    .limit(500)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ statements: data || [] })
}
