// POST /api/plaid/link-token — cria o link_token para o CLIENTE logado abrir o Plaid Link
// Inclui redirect_uri (obrigatório para bancos OAuth: BofA, Chase, Wells Fargo).
import { NextResponse } from 'next/server'
import { getUser } from '@/lib/supabase-server'
import { serviceDb } from '@/lib/api-auth'
import { plaidPost } from '@/lib/plaid'

export async function POST() {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Login necessário' }, { status: 401 })

  const db = serviceDb()
  const { data: client } = await db.from('clients')
    .select('id, name, language').eq('user_id', user.id).single()
  if (!client) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://peaceontax-portal.vercel.app').replace(/\/$/, '')

  try {
    const data = await plaidPost('/link/token/create', {
      user: { client_user_id: client.id },
      client_name: 'Peace on Tax',
      products: ['transactions'],
      country_codes: ['US'],
      language: client.language === 'pt' ? 'pt' : client.language === 'es' ? 'es' : 'en',
      redirect_uri: `${appUrl}/portal/bank`,   // OAuth: precisa estar em Allowed redirect URIs no Plaid
      transactions: { days_requested: 730 },   // 24 meses de histórico (padrão seria só 90 dias)
    })
    return NextResponse.json({ linkToken: data.link_token })
  } catch (e) {
    console.error('link-token:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
