// /api/clients/[id] — ficha do cliente
//
// GET    → ficha + documentos + mensagens (equipe, ou o próprio cliente)
// PATCH  → edita a ficha (só equipe)
// DELETE → inativa o cadastro (só equipe); nunca apaga
//
// CORREÇÃO DE SEGURANÇA: a rota NÃO CONFERIA QUEM CHAMAVA e usava a service
// role key. Qualquer pessoa logada — inclusive um cliente — lia, editava e
// inativava a ficha de QUALQUER cliente da carteira. O PATCH ainda mandava
// `{...body}` direto para o update: dava para gravar `user_id` e apontar a
// ficha de um cliente para o login de outro.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { camposDoCliente } from '@/lib/novo-cliente'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const auth = await getAuth()
  if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
  if (!(await canAccessClient(auth, params.id)))
    return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  try {
    const db = serviceDb()
    const [{ data: client }, { data: docs }, { data: msgs }] = await Promise.all([
      db.from('clients').select('*').eq('id', params.id).single(),
      db.from('documents').select('*').eq('client_id', params.id).order('created_at', { ascending: false }),
      db.from('messages').select('*').eq('client_id', params.id).order('created_at', { ascending: false }).limit(20),
    ])
    return NextResponse.json({ client, documents: docs || [], messages: msgs || [] })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  try {
    // Só os campos da ficha. O corpo nunca vai inteiro para o update —
    // user_id é identidade, não dado de formulário.
    const campos = camposDoCliente(await req.json())
    if (!Object.keys(campos).length)
      return NextResponse.json({ error: 'Nada para alterar.' }, { status: 400 })

    const { data, error } = await serviceDb().from('clients')
      .update({ ...campos, updated_at: new Date().toISOString() })
      .eq('id', params.id).select().single()
    if (error) throw error
    return NextResponse.json({ client: data })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  try {
    await serviceDb().from('clients')
      .update({ active: false, updated_at: new Date().toISOString() }).eq('id', params.id)
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
