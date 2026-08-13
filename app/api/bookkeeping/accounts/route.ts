// PATCH /api/bookkeeping/accounts
//
// Altera uma conta bancária do cliente (nome, tipo) ou move os lançamentos
// dela para outra conta.
//
// Exige, cumulativamente:
//   1. usuário da equipe com nível owner ou manager (staff_roles)
//   2. senha do próprio usuário, conferida no servidor
//   3. motivo com pelo menos 5 caracteres
// Tudo fica registrado em bank_account_audit.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const TIPOS = ['checking', 'savings', 'credit_card']

export async function PATCH(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  // 1. Nível de permissão
  const nivel = await getStaffLevel(auth.userId)
  if (nivel !== 'owner' && nivel !== 'manager') {
    return NextResponse.json({
      error: 'Somente sócio ou gerente pode alterar contas bancárias. Peça a alteração a um deles.',
    }, { status: 403 })
  }

  const b = await req.json()
  const { accountId, name, type, moveToAccountId, password, reason } = b

  if (!accountId) return NextResponse.json({ error: 'accountId obrigatório' }, { status: 400 })
  if (!String(reason || '').trim() || String(reason).trim().length < 5) {
    return NextResponse.json({ error: 'Informe o motivo da alteração (mínimo 5 caracteres).' }, { status: 400 })
  }
  if (!password) return NextResponse.json({ error: 'Confirme com a sua senha.' }, { status: 400 })

  const db = serviceDb()

  // 2. Senha conferida no servidor (não só no navegador)
  const { data: userInfo } = await db.auth.admin.getUserById(auth.userId)
  const email = userInfo?.user?.email
  if (!email) return NextResponse.json({ error: 'Não foi possível identificar seu login.' }, { status: 400 })

  const sbAuth = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
  const { error: senhaErr } = await sbAuth.auth.signInWithPassword({ email, password })
  if (senhaErr) return NextResponse.json({ error: 'Senha incorreta.' }, { status: 401 })

  // 3. A conta existe e é de um cliente que você acessa
  const { data: conta } = await db.from('bank_accounts')
    .select('id, client_id, name, type, account_hint').eq('id', accountId).single()
  if (!conta) return NextResponse.json({ error: 'Conta não encontrada' }, { status: 404 })
  if (!(await canAccessClient(auth, conta.client_id))) {
    return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })
  }

  const antes = { name: conta.name, type: conta.type }
  const registrar = async (acao: string, novo: unknown, extra?: unknown) => {
    await db.from('bank_account_audit').insert({
      account_id: conta.id,
      client_id: conta.client_id,
      action: acao,
      performed_by: auth.userId,
      staff_level: nivel,
      reason: String(reason).trim(),
      previous_state: antes,
      new_state: novo,
      details: extra ?? null,
    }).then(() => null, () => null)
  }

  // ── Mover lançamentos para outra conta ──
  if (moveToAccountId) {
    if (moveToAccountId === accountId) {
      return NextResponse.json({ error: 'A conta de destino é a mesma de origem.' }, { status: 400 })
    }
    const { data: destino } = await db.from('bank_accounts')
      .select('id, client_id, name').eq('id', moveToAccountId).single()
    if (!destino) return NextResponse.json({ error: 'Conta de destino não encontrada' }, { status: 404 })
    if (destino.client_id !== conta.client_id) {
      return NextResponse.json({ error: 'As duas contas precisam ser do mesmo cliente.' }, { status: 400 })
    }

    const { count } = await db.from('bank_transactions')
      .select('id', { count: 'exact', head: true }).eq('account_id', accountId)

    const { error: movErr } = await db.from('bank_transactions')
      .update({ account_id: moveToAccountId, updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
    if (movErr) return NextResponse.json({ error: movErr.message }, { status: 500 })

    await registrar('transactions_moved',
      { moved_to: destino.name },
      { account_id_destino: moveToAccountId, lancamentos: count ?? 0 })

    return NextResponse.json({
      ok: true, movidos: count ?? 0, destino: destino.name,
      message: `${count ?? 0} lançamento(s) movidos para "${destino.name}".`,
    })
  }

  // ── Alterar nome/tipo ──
  const upd: Record<string, unknown> = {}
  if (name !== undefined) {
    const n = String(name).trim()
    if (n.length < 3) return NextResponse.json({ error: 'Nome da conta muito curto.' }, { status: 400 })
    upd.name = n
    upd.account_hint = n          // o apelido acompanha: é onde ficam os 4 dígitos
  }
  if (type !== undefined) {
    if (!TIPOS.includes(type)) return NextResponse.json({ error: 'Tipo inválido.' }, { status: 400 })
    upd.type = type
  }
  if (Object.keys(upd).length === 0) {
    return NextResponse.json({ error: 'Nada para alterar.' }, { status: 400 })
  }

  const { data: nova, error } = await db.from('bank_accounts')
    .update(upd).eq('id', accountId)
    .select('id, name, type').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await registrar('account_edited', { name: nova.name, type: nova.type })

  return NextResponse.json({
    ok: true, account: nova,
    message: `Conta atualizada para "${nova.name}".`,
  })
}
