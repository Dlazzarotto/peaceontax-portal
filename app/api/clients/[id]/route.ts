// Ficha do cliente
//
//   GET    /api/clients/:id   ficha + documentos + mensagens — equipe, ou o próprio cliente
//   PATCH  /api/clients/:id   edita a ficha — só equipe, e só os campos da lista abaixo
//   DELETE /api/clients/:id   inativa (não apaga) — só equipe
//
// Trocar `type` (pessoa física × empresa) muda as categorias do bookkeeping,
// os orçamentos e os formulários de assinatura do cliente. Por isso é o único
// campo que exige motivo e fica gravado em `client_audit`.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

// Lista fechada: nada fora daqui entra no update. Ficam de fora, de propósito,
// `id`, `user_id` (dono do acesso ao portal), `balance` e `created_at`.
const EDITAVEIS = [
  'name', 'email', 'phone', 'type', 'language', 'assignee', 'stage', 'active',
  'ein', 'entity_type', 'business_name', 'business_type', 'business_kind', 'industry',
  'ssn_last4', 'filing_status', 'address_line1', 'address_line2', 'city', 'state', 'zip',
  'notes', 'sms_phone',
] as const

const TIPOS = ['individual', 'business']

// O que impede a troca de tipo. São as tabelas cujo conteúdo foi criado
// segundo o tipo do cliente — lançamento classificado, documento arquivado,
// pasta vinda do template, regra de classificação, orçamento e assinatura.
const HISTORICO: { tabela: string; rotulo: string }[] = [
  { tabela: 'bank_transactions',  rotulo: 'lançamentos' },
  { tabela: 'bookkeeping_rules',  rotulo: 'regras' },
  { tabela: 'documents',          rotulo: 'documentos' },
  { tabela: 'client_folders',     rotulo: 'pastas' },
  { tabela: 'invoices',           rotulo: 'faturas' },
  { tabela: 'quotes',             rotulo: 'orçamentos' },
  { tabela: 'signature_requests', rotulo: 'assinaturas' },
]

async function contarHistorico(db: ReturnType<typeof serviceDb>, clientId: string) {
  const contas = await Promise.all(HISTORICO.map(async ({ tabela, rotulo }) => {
    const { count } = await db.from(tabela).select('id', { count: 'exact', head: true }).eq('client_id', clientId)
    return [rotulo, count || 0] as const
  }))
  const porTabela = Object.fromEntries(contas.filter(([, n]) => n > 0))
  return { total: contas.reduce((s, [, n]) => s + n, 0), porTabela }
}

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await getAuth()
    if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
    if (!(await canAccessClient(auth, params.id)))
      return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })

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
  try {
    const auth = await getAuth()
    if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
    if (!auth.isStaff) return NextResponse.json({ error: 'Só a equipe edita a ficha' }, { status: 403 })

    const body = await req.json()
    const motivo = typeof body.motivo === 'string' ? body.motivo.trim() : ''

    const patch: Record<string, any> = {}
    for (const campo of EDITAVEIS) {
      if (Object.prototype.hasOwnProperty.call(body, campo)) patch[campo] = body[campo]
    }
    if (Object.keys(patch).length === 0)
      return NextResponse.json({ error: 'Nada para alterar' }, { status: 400 })

    if (typeof patch.name === 'string') patch.name = patch.name.trim()
    if (typeof patch.email === 'string') patch.email = patch.email.trim().toLowerCase()

    const db = serviceDb()
    const { data: antes } = await db.from('clients').select('*').eq('id', params.id).maybeSingle()
    if (!antes) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })

    const trocaTipo = patch.type !== undefined && patch.type !== antes.type
    if (patch.type !== undefined && !TIPOS.includes(patch.type))
      return NextResponse.json({ error: 'Tipo inválido' }, { status: 400 })
    if (trocaTipo && motivo.length < 3)
      return NextResponse.json({ error: 'Trocar pessoa física × empresa exige motivo' }, { status: 400 })

    // Trocar o tipo com trabalho já feito corrompe o que já existe: as
    // categorias de lançamento e de documento são outras, as pastas vieram do
    // template do tipo antigo e o formulário de assinatura muda (8879 de
    // empresa × de pessoa física). Aqui a troca é recusada, não "avisada" --
    // o caminho certo é abrir o cadastro do outro tipo e migrar com critério.
    if (trocaTipo) {
      const historico = await contarHistorico(db, params.id)
      if (historico.total > 0) {
        return NextResponse.json({
          error: 'Este cliente já tem trabalho lançado — trocar o tipo quebraria as categorias, as pastas e os formulários já existentes.',
          historico,
        }, { status: 409 })
      }
    }

    const { data, error } = await db
      .from('clients')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', params.id)
      .select()
      .single()
    if (error) throw error

    if (trocaTipo) {
      await db.from('client_audit').insert({
        client_id:      params.id,
        action:         'tipo_alterado',
        reason:         motivo,
        performed_by:   auth.userId,
        previous_state: { type: antes.type },
        new_state:      { type: data.type },
      })
    }

    return NextResponse.json({ client: data })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await getAuth()
    if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
    if (!auth.isStaff) return NextResponse.json({ error: 'Só a equipe inativa cliente' }, { status: 403 })

    const db = serviceDb()
    await db.from('clients').update({ active: false, updated_at: new Date().toISOString() }).eq('id', params.id)
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
