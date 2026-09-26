// /api/caixa/firma — o caixa da PROPRIA Peace on Tax
//
// GET  → o cadastro da firma (ou null), as conexoes de banco e o tamanho do
//        livro. Diz tambem se a migracao `sql/caixa-da-firma-v1.sql` ainda
//        nao rodou, em vez de devolver "nao ha caixa" e deixar o socio
//        criando um cadastro que nao vai gravar.
// POST → cria (ou corrige) o cadastro da firma.
//
// SO O SOCIO, nos dois verbos. Nao e escopo por tipo: o caixa da firma tem
// folha de pagamento, honorario de socio e o resultado do ano. Gerente tem
// `verEmpresas` por nivel — se a porta fosse essa, o livro da firma abriria
// para ele. Ver lib/caixa-firma.ts e lib/api-auth.ts (canAccessClient).

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { camposDaFirma, criticarFirma, MARCA_DA_FIRMA, esquecerFirma } from '@/lib/caixa-firma'

const SO_O_SOCIO = 'O caixa da firma é do sócio. Fale com ele.'
const FALTA_MIGRACAO =
  'O banco ainda não tem a coluna do caixa da firma. Rode a migração ' +
  'sql/caixa-da-firma-v1.sql (Actions → Migrações do banco) e abra esta tela de novo.'

/** Erro do PostgREST de coluna que nao existe — a migracao ainda nao rodou. */
function ehColunaAusente(e: any): boolean {
  return e?.code === '42703' || /column .*is_firm.* does not exist/i.test(String(e?.message || ''))
}

async function socio() {
  const auth = await getAuth()
  if (!auth?.isStaff) return null
  return (await getStaffLevel(auth.userId)) === 'owner' ? auth : null
}

export async function GET() {
  const auth = await socio()
  if (!auth) return NextResponse.json({ error: SO_O_SOCIO }, { status: 403 })

  const db = serviceDb()
  // Consulta DIRETA, sem o atalho tolerante de `idDaFirma`: aqui o erro
  // interessa. Quem precisa do caixa precisa saber por que ele nao aparece.
  const { data, error } = await db.from('clients')
    .select('id, name, business_name, ein, email, phone, address_line1, city, state, zip')
    .eq('is_firm', true).limit(1)
  if (error) {
    if (ehColunaAusente(error)) {
      return NextResponse.json({ firma: null, migracaoPendente: true, aviso: FALTA_MIGRACAO })
    }
    return NextResponse.json({ error: `Nao foi possivel ler o caixa: ${error.message}` }, { status: 500 })
  }

  const firma = data?.[0] || null
  if (!firma) return NextResponse.json({ firma: null, conexoes: [], livro: null })

  const [conexoes, lancamentos] = await Promise.all([
    db.from('plaid_items')
      .select('id, institution_name, status, last_synced_at, created_at')
      .eq('client_id', firma.id).neq('status', 'disconnected'),
    db.from('bank_transactions').select('status').eq('client_id', firma.id).limit(20000),
  ])
  // Cada consulta responde pelo proprio erro: numero que falha e zero na tela,
  // e zero na tela e uma AFIRMACAO ("o banco nao trouxe nada").
  if (conexoes.error)   return NextResponse.json({ error: `Conexões: ${conexoes.error.message}` }, { status: 500 })
  if (lancamentos.error) return NextResponse.json({ error: `Lançamentos: ${lancamentos.error.message}` }, { status: 500 })

  const linhas = lancamentos.data || []
  return NextResponse.json({
    firma,
    conexoes: conexoes.data || [],
    livro: {
      total:      linhas.filter((t: any) => t.status !== 'excluded').length,
      pendentes:  linhas.filter((t: any) => t.status === 'pending').length,
      aguardando: linhas.filter((t: any) => t.status === 'auto').length,
    },
  })
}

export async function POST(req: NextRequest) {
  const auth = await socio()
  if (!auth) return NextResponse.json({ error: SO_O_SOCIO }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  // O corpo NUNCA vai inteiro para o banco. Aqui isso e mais grave que no
  // cadastro comum: `is_firm` vindo de fora marcaria um CLIENTE como firma —
  // e o cliente marcado sumiria de todas as listas.
  const campos = camposDaFirma(body)
  const critica = criticarFirma(campos)
  if (critica) return NextResponse.json({ error: critica }, { status: 400 })

  const db = serviceDb()
  const { data: existentes, error: errBusca } = await db.from('clients')
    .select('id').eq('is_firm', true).limit(1)
  if (errBusca) {
    if (ehColunaAusente(errBusca)) {
      return NextResponse.json({ error: FALTA_MIGRACAO, migracaoPendente: true }, { status: 409 })
    }
    return NextResponse.json({ error: errBusca.message }, { status: 500 })
  }

  const jaExiste = existentes?.[0]?.id || null
  const { data, error } = jaExiste
    ? await db.from('clients').update(campos).eq('id', jaExiste).select('id').single()
    : await db.from('clients').insert({ ...campos, ...MARCA_DA_FIRMA }).select('id').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  esquecerFirma()

  // Trilha: quem criou o livro da firma e quando.
  const { error: errTrilha } = await db.from('client_audit').insert({
    client_id: data.id,
    action: jaExiste ? 'firm_book_updated' : 'firm_book_created',
    performed_by: auth.userId,
    details: { campos: Object.keys(campos) },
  })
  if (errTrilha) console.error('caixa/firma: trilha nao gravou —', errTrilha.message)

  return NextResponse.json({ ok: true, clientId: data.id, criado: !jaExiste })
}
