// POST /api/plaid/link-token — cria o link_token para abrir o Plaid Link
//
// Dois caminhos, uma rota:
//   . sem corpo        → o CLIENTE logado conecta o proprio banco (/portal/bank)
//   . { clientId }     → a EQUIPE conecta o banco de um cadastro, passando
//                        por canAccessClient (o mesmo funil de /api/plaid/items,
//                        que ja aceitava ?clientId=). E assim que o socio
//                        conecta a conta da PROPRIA firma em /dashboard/caixa:
//                        a firma e uma linha em `clients` e canAccessClient so
//                        libera para ele.
//
// Inclui redirect_uri (obrigatório para bancos OAuth: BofA, Chase, Wells Fargo).
import { NextRequest, NextResponse } from 'next/server'
import { getUser } from '@/lib/supabase-server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { plaidPost } from '@/lib/plaid'

export async function POST(req: NextRequest) {
  const db = serviceDb()
  const body = await req.json().catch(() => ({} as any))
  const pedidoClientId = body?.clientId ? String(body.clientId) : null

  let client: { id: string; name: string; language: string | null } | null = null
  let daEquipe = false

  if (pedidoClientId) {
    const auth = await getAuth()
    if (!auth?.isStaff || !(await canAccessClient(auth, pedidoClientId))) {
      return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
    }
    const { data } = await db.from('clients')
      .select('id, name, language').eq('id', pedidoClientId).maybeSingle()
    if (!data) return NextResponse.json({ error: 'Cadastro não encontrado' }, { status: 404 })
    client = data as any
    daEquipe = true
  } else {
    const user = await getUser()
    if (!user) return NextResponse.json({ error: 'Login necessário' }, { status: 401 })
    const { data: clientRows } = await db.from('clients')
      .select('id, name, language').eq('user_id', user.id).limit(2)
    if (!clientRows || clientRows.length === 0) {
      return NextResponse.json({ error: 'Seu login ainda não está vinculado a um cadastro — fale com nossa equipe.' }, { status: 404 })
    }
    if (clientRows.length > 1) {
      return NextResponse.json({ error: 'Seu login está vinculado a mais de um cadastro — fale com nossa equipe.' }, { status: 409 })
    }
    client = clientRows[0] as any
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://peaceontax-portal.vercel.app').replace(/\/$/, '')
  // Cada tela volta para si mesma depois do OAuth do banco.
  const redirect = daEquipe ? `${appUrl}/dashboard/caixa` : `${appUrl}/portal/bank`

  const pedido = (language: string, comRedirect: boolean) => ({
    user: { client_user_id: client!.id },
    client_name: 'Peace on Tax',
    products: ['transactions'],
    country_codes: ['US'],
    language,
    // OAuth: precisa estar em Allowed redirect URIs no painel do Plaid
    ...(comRedirect ? { redirect_uri: redirect } : {}),
    transactions: { days_requested: 730 },   // 24 meses de histórico (padrão seria só 90 dias)
  })

  // O idioma é conforto, não requisito: se o Plaid recusar (idioma que ele não
  // atende, ou que não vale para os EUA, ou customização do painel configurada
  // só em inglês), a tela abre em inglês em vez de o cliente ficar sem conectar
  // o banco. Era o que acontecia com quem não tem o cadastro em inglês.
  const idioma = idiomaDoPlaid(client.language)
  try {
    const data = await plaidPost('/link/token/create', pedido(idioma, true))
    return NextResponse.json({ linkToken: data.link_token })
  } catch (e) {
    console.error('link-token:', idioma, redirect, e)

    // A URL de retorno precisa estar cadastrada no painel do Plaid. A do
    // portal está desde sempre; a do caixa da firma é nova, e o Plaid recusa
    // o token INTEIRO por causa dela. Sem esta saída, o sócio veria "erro" e
    // não teria como conectar banco nenhum. Abre sem redirect (banco de
    // senha funciona; banco OAuth vai pedir o cadastro da URL) e DIZ isso.
    if (/redirect/i.test((e as Error).message || '')) {
      try {
        const data = await plaidPost('/link/token/create', pedido(idioma, false))
        return NextResponse.json({
          linkToken: data.link_token,
          aviso: `O Plaid não aceitou a URL de retorno ${redirect}. Bancos que abrem ` +
                 'a própria página (BofA, Chase, Wells Fargo) só conectam depois que ' +
                 'essa URL for cadastrada em Allowed redirect URIs no painel do Plaid.',
        })
      } catch (e3) {
        console.error('link-token (sem redirect):', e3)
      }
    }

    if (idioma === 'en') {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 })
    }
    try {
      const data = await plaidPost('/link/token/create', pedido('en', true))
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
