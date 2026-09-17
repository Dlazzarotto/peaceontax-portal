// GET  /api/clients — lista de clientes da firma (só equipe)
// POST /api/clients — cadastra cliente (só equipe)
//
// O middleware só garante que existe sessão: sem a conferência abaixo, um
// cliente logado no portal enxergava a carteira inteira da firma.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'
import { getAuth } from '@/lib/api-auth'
import { camposDoCliente, criticarCliente, deveConvidar } from '@/lib/novo-cliente'

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuth()
    if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
    const db = supabaseAdmin()
    const { searchParams } = new URL(req.url)
    const search = searchParams.get('search')
    const type   = searchParams.get('type')
    const stage  = searchParams.get('stage')

    let query = db.from('clients').select('*').eq('active', true).order('name')
    if (search) query = query.ilike('name', `%${search}%`)
    if (type)   query = query.eq('type', type)
    if (stage)  query = query.eq('stage', stage)

    const { data, error } = await query
    if (error) throw error
    return NextResponse.json({ clients: data || [] })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuth()
    if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
    const body = await req.json()
    const db = supabaseAdmin()

    // O corpo NÃO vai direto para o insert: antes ia, e qualquer campo enviado
    // entrava na tabela — inclusive user_id, que amarra o cadastro a um login.
    const campos = camposDoCliente(body)
    const critica = criticarCliente(campos)
    if (critica) return NextResponse.json({ error: critica }, { status: 400 })

    // Mesmo e-mail duas vezes é quase sempre cadastro repetido, e dois cadastros
    // com o mesmo e-mail brigam pelo portal do cliente.
    if (campos.email) {
      const { data: existe } = await db.from('clients')
        .select('id, name').eq('email', campos.email).limit(1)
      if (existe?.length) {
        return NextResponse.json({
          error: `Já existe cliente com este e-mail: ${existe[0].name}.`,
          clientId: existe[0].id,
        }, { status: 409 })
      }
    }

    const { data, error } = await db.from('clients').insert(campos).select().single()
    if (error) throw error

    // Cadastrar e convidar eram duas telas separadas, e o cliente ficava no
    // sistema sem nunca receber o login. Agora sai junto — o convite falhar
    // não desfaz o cadastro, mas a resposta diz que não foi.
    let convite: { enviado: boolean; motivo?: string } = { enviado: false }
    if (deveConvidar(body, campos)) {
      try {
        const r = await fetch(`${req.nextUrl.origin}/api/send-invite`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: req.headers.get('cookie') || '' },
          body: JSON.stringify({
            clientName: campos.name, clientEmail: campos.email,
            clientType: campos.type || 'individual', language: campos.language || 'en',
            assignee: campos.assignee || 'Peace on Tax', channels: ['email'],
          }),
        })
        const d = await r.json().catch(() => ({}))
        convite = r.ok && d?.emailSent !== false
          ? { enviado: true }
          : { enviado: false, motivo: d?.error || 'o e-mail não saiu' }
      } catch (e) {
        convite = { enviado: false, motivo: (e as Error).message }
      }
      if (!convite.enviado) console.error('convite do cliente novo:', campos.email, convite.motivo)
    }

    return NextResponse.json({ client: data, convite })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
