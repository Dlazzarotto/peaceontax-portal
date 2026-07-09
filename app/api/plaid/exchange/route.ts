// POST /api/plaid/exchange { publicToken, institutionName } — troca e salva a conexão
import { NextRequest, NextResponse } from 'next/server'
import { getUser } from '@/lib/supabase-server'
import { serviceDb } from '@/lib/api-auth'
import { plaidPost } from '@/lib/plaid'
import { syncPlaidItem } from '@/lib/plaid-sync'

export async function POST(req: NextRequest) {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Login necessário' }, { status: 401 })

  const { publicToken, institutionName } = await req.json()
  if (!publicToken) return NextResponse.json({ error: 'publicToken obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: client } = await db.from('clients')
    .select('id').eq('user_id', user.id).single()
  if (!client) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })

  try {
    const ex = await plaidPost('/item/public_token/exchange', { public_token: publicToken })

    // Upsert por item_id: reconectar o mesmo banco atualiza em vez de quebrar
    const { data: item, error } = await db.from('plaid_items').upsert({
      client_id: client.id,
      item_id: ex.item_id,
      access_token: ex.access_token,
      institution_name: institutionName ? String(institutionName).slice(0, 120) : null,
      status: 'active',
    }, { onConflict: 'item_id' }).select('id').single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Trilha de auditoria (compliance)
    await db.from('client_audit').insert({
      client_id: client.id, action: 'plaid_connected',
      performed_by: user.id,
      details: { institution: institutionName || 'unknown' },
    }).then(() => null, () => null)

    // Primeira sincronização (histórico inicial)
    const result = await syncPlaidItem(db, item!.id).catch(e => ({ error: (e as Error).message }))

    return NextResponse.json({ ok: true, sync: result })
  } catch (e) {
    console.error('exchange:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
