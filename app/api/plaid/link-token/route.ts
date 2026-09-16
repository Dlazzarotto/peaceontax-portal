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
  const { data: clientRows } = await db.from('clients')
    .select('id, name, language').eq('user_id', user.id).limit(2)
  if (!clientRows || clientRows.length === 0) {
    return NextResponse.json({ error: 'Seu login ainda não está vinculado a um cadastro — fale com nossa equipe.' }, { status: 404 })
  }
  if (clientRows.length > 1) {
    return NextResponse.json({ error: 'Seu login está vinculado a mais de um cadastro — fale com nossa equipe.' }, { status: 409 })
  }
  const client = clientRows[0]

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://peaceontax-portal.vercel.app').replace(/\/$/, '')

  const pedido = (language: string) => ({
    user: { client_user_id: client.id },
    client_name: 'Peace on Tax',
    products: ['transactions'],
    country_codes: ['US'],
    language,
    redirect_uri: `${appUrl}/portal/bank`,   // OAuth: precisa estar em Allowed redirect URIs no Plaid
    transactions: { days_requested: 730 },   // 24 meses de histórico (padrão seria só 90 dias)
  })

  // O idioma é conforto, não requisito: se o Plaid recusar (idioma que ele não
  // atende, ou que não vale para os EUA, ou customização do painel configurada
  // só em inglês), a tela abre em inglês em vez de o cliente ficar sem conectar
  // o banco. Era o que acontecia com quem não tem o cadastro em inglês.
  const idioma = idiomaDoPlaid(client.language)
  try {
    const data = await plaidPost('/link/token/create', pedido(idioma))
    return NextResponse.json({ linkToken: data.link_token })
  } catch (e) {
    console.error('link-token:', idioma, e)
    if (idioma === 'en') {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 })
    }
    try {
      const data = await plaidPost('/link/token/create', pedido('en'))
      console.error('link-token: idioma', idioma, 'recusado pelo Plaid — aberto em inglês')
      return NextResponse.json({ linkToken: data.link_token, idioma: 'en' })
    } catch (e2) {
      console.error('link-token (en):', e2)
      return NextResponse.json({ error: (e2 as Error).message }, { status: 500 })
    }
  }
}

// Idiomas que o Plaid Link atende (/link/token/create → language). O que não
// está aqui abre em inglês: 'zh' é o caso dos nossos cadastros.
const PLAID_IDIOMAS = ['da', 'nl', 'en', 'et', 'fr', 'de', 'hi', 'it', 'lv', 'lt', 'no', 'pl', 'pt', 'ro', 'es', 'sv', 'vi']

function idiomaDoPlaid(lang: string | null | undefined): string {
  const l = String(lang || 'en').toLowerCase().slice(0, 2)
  return PLAID_IDIOMAS.includes(l) ? l : 'en'
}
