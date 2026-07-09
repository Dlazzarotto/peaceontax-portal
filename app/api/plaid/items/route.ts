// GET    /api/plaid/items            — conexões do CLIENTE logado (portal)
// GET    /api/plaid/items?clientId=  — conexões de um cliente (equipe)
// DELETE /api/plaid/items?id=        — desconecta (cliente dono ou equipe)
import { NextRequest, NextResponse } from 'next/server'
import { getUser } from '@/lib/supabase-server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { plaidPost } from '@/lib/plaid'

export async function GET(req: NextRequest) {
  const db = serviceDb()
  const staffClientId = req.nextUrl.searchParams.get('clientId')

  if (staffClientId) {
    const auth = await getAuth()
    if (!auth?.isStaff || !(await canAccessClient(auth, staffClientId))) {
      return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
    }
    const { data } = await db.from('plaid_items')
      .select('id, institution_name, status, last_synced_at, created_at')
      .eq('client_id', staffClientId).neq('status', 'disconnected')
    return NextResponse.json({ items: data || [] })
  }

  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Login necessário' }, { status: 401 })
  const { data: client } = await db.from('clients').select('id').eq('user_id', user.id).single()
  if (!client) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })

  const { data } = await db.from('plaid_items')
    .select('id, institution_name, status, last_synced_at, created_at')
    .eq('client_id', client.id).neq('status', 'disconnected')
  return NextResponse.json({ items: data || [] })
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: item } = await db.from('plaid_items').select('*').eq('id', id).single()
  if (!item) return NextResponse.json({ error: 'Conexão não encontrada' }, { status: 404 })

  // Autorização: cliente dono OU equipe com acesso
  const user = await getUser()
  let allowed = false
  if (user) {
    const { data: client } = await db.from('clients').select('id').eq('user_id', user.id).single()
    if (client?.id === item.client_id) allowed = true
  }
  if (!allowed) {
    const auth = await getAuth()
    if (auth?.isStaff && (await canAccessClient(auth, item.client_id))) allowed = true
  }
  if (!allowed) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  await plaidPost('/item/remove', { access_token: item.access_token }).catch(() => null)
  await db.from('plaid_items').update({ status: 'disconnected', access_token: 'revoked' }).eq('id', id)

  await db.from('client_audit').insert({
    client_id: item.client_id, action: 'plaid_disconnected',
    performed_by: user?.id || 'staff',
    details: { institution: item.institution_name || 'unknown' },
  }).then(() => null, () => null)

  return NextResponse.json({ ok: true })
}
