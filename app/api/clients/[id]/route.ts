// /api/clients/[id] — ficha do cliente
//
// GET    → ficha + documentos + mensagens (equipe, ou o próprio cliente)
// PATCH  → move a ficha no FLUXO: etapa, responsável, anotação interna
// DELETE → inativa o cadastro (só equipe); nunca apaga
//
// DADO DE CLIENTE NÃO PASSA POR AQUI. Nome, e-mail, telefone, endereço e EIN
// só mudam por /api/clients/profile, que exige a autorização `editarCliente`,
// senha e motivo, e grava previous_state/new_state em client_audit. Esta rota
// aceitava os mesmos campos sem nada disso: eram duas portas para a mesma
// sala, uma com guarda e outra sem — dava para trocar o e-mail de um cliente
// (e com ele o acesso ao portal) sem deixar rastro. Agora a lista é fechada
// no fluxo, e campo de cadastro é recusado apontando o caminho certo.
//
// CORREÇÃO DE SEGURANÇA: a rota NÃO CONFERIA QUEM CHAMAVA e usava a service
// role key. Qualquer pessoa logada — inclusive um cliente — lia, editava e
// inativava a ficha de QUALQUER cliente da carteira. O PATCH ainda mandava
// `{...body}` direto para o update: dava para gravar `user_id` e apontar a
// ficha de um cliente para o login de outro.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

// O que é FLUXO: onde a ficha está no quadro e com quem. Isso é trabalho do
// dia e não muda quem o cliente é nem como a firma o alcança.
const CAMPOS_DE_FLUXO = ['stage', 'assignee', 'notes'] as const

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const auth = await getAuth()
  if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
  if (!(await canAccessClient(auth, params.id)))
    return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  try {
    const db = serviceDb()
    const [{ data: client, error: errCli }, { data: docs, error: errDocs }, { data: msgs, error: errMsgs }] = await Promise.all([
      db.from('clients').select('*').eq('id', params.id).single(),
      db.from('documents').select('*').eq('client_id', params.id).order('created_at', { ascending: false }),
      db.from('messages').select('*').eq('client_id', params.id).order('created_at', { ascending: false }).limit(20),
    ])
    // "Cliente sem documento" e "nao consegui ler os documentos" sao coisas
    // diferentes, e a ficha dizia a primeira nas duas situacoes.
    // `single()` erra quando nao acha: isso e 404, nao falha de leitura.
    if (errCli && errCli.code !== 'PGRST116') {
      return NextResponse.json({ error: `Cliente: ${errCli.message}` }, { status: 500 })
    }
    if (!client) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })
    if (errDocs) return NextResponse.json({ error: `Documentos: ${errDocs.message}` }, { status: 500 })
    if (errMsgs) return NextResponse.json({ error: `Mensagens: ${errMsgs.message}` }, { status: 500 })
    return NextResponse.json({ client, documents: docs || [], messages: msgs || [] })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  try {
    const corpo = await req.json()

    // Pedir campo de cadastro por aqui não é erro de digitação: é o caminho
    // que existia antes. Recusar em silêncio esconderia a mudança.
    const deCadastro = Object.keys(corpo || {})
      .filter(k => !(CAMPOS_DE_FLUXO as readonly string[]).includes(k))
    if (deCadastro.length) {
      return NextResponse.json({
        error: `Dado de cadastro (${deCadastro.join(', ')}) muda na ficha do cliente, ` +
               `com senha e motivo. Esta tela altera apenas etapa, responsável e anotação.`,
      }, { status: 400 })
    }

    const campos: Record<string, unknown> = {}
    for (const k of CAMPOS_DE_FLUXO) {
      if (corpo?.[k] === undefined) continue
      const t = String(corpo[k]).trim()
      campos[k] = t === '' ? null : t
    }
    if (!Object.keys(campos).length)
      return NextResponse.json({ error: 'Nada para alterar.' }, { status: 400 })

    const db = serviceDb()
    const { data: antes } = await db.from('clients')
      .select('stage, assignee, notes').eq('id', params.id).maybeSingle()

    const { data, error } = await db.from('clients')
      .update({ ...campos, updated_at: new Date().toISOString() })
      .eq('id', params.id).select().single()
    if (error) throw error

    // Mover a ficha é trabalho do dia e não pede motivo — mas fica registrado
    // quem moveu e de onde para onde.
    await db.from('client_audit').insert({
      client_id: params.id, action: 'fluxo', performed_by: auth.userId,
      previous_state: antes ?? null, new_state: campos,
    }).then(() => null, () => null)

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
