// /api/bookkeeping/manual-entry
//
// POST { clientId, accountId, date, description, amount, direction, category, payee?, memo? }
//   → cria um lançamento à mão no registro do cliente.
//
// É o equivalente ao "add new transaction" do register do QuickBooks:
// serve para o que existe de verdade mas não veio no extrato (cheque
// que não compensou, dinheiro em espécie, ajuste de conciliação).
//
// Entra direto como APROVADO (faz parte do livro) e fica marcado como
// origem 'manual', para você distinguir do que veio do banco.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  // Lançar à mão altera o livro: restrito a sócio e gerente
  const nivel = await getStaffLevel(auth.userId)
  if (nivel !== 'owner' && nivel !== 'manager') {
    return NextResponse.json({
      error: 'Lançamento manual é permitido a sócio ou gerente.',
    }, { status: 403 })
  }

  const b = await req.json()
  const { clientId, accountId, date, description, category, payee, memo } = b

  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
  if (!accountId) return NextResponse.json({ error: 'Escolha a conta bancária.' }, { status: 400 })
  if (!date) return NextResponse.json({ error: 'Informe a data.' }, { status: 400 })
  if (!String(description || '').trim()) return NextResponse.json({ error: 'Descreva o lançamento.' }, { status: 400 })
  if (!String(category || '').trim()) return NextResponse.json({ error: 'Escolha a conta contábil.' }, { status: 400 })

  const bruto = Math.abs(Number(b.amount) || 0)
  if (bruto <= 0) return NextResponse.json({ error: 'Informe um valor maior que zero.' }, { status: 400 })

  // Saída fica negativa; entrada positiva — mesma convenção do extrato
  const valor = b.direction === 'in'
    ? Math.round(bruto * 100) / 100
    : -Math.round(bruto * 100) / 100

  const db = serviceDb()

  // A conta é mesmo deste cliente?
  const { data: conta } = await db.from('bank_accounts')
    .select('id, name, client_id').eq('id', accountId).single()
  if (!conta || conta.client_id !== clientId) {
    return NextResponse.json({ error: 'Conta bancária inválida para este cliente.' }, { status: 400 })
  }

  // Alerta de duplicidade: mesmo dia, mesmo valor, mesma conta
  const { data: parecidas } = await db.from('bank_transactions')
    .select('id, description')
    .eq('client_id', clientId).eq('account_id', accountId)
    .eq('tx_date', date).eq('amount', valor)
    .neq('status', 'excluded').limit(3)

  const { data: nova, error } = await db.from('bank_transactions').insert({
    client_id: clientId,
    account_id: accountId,
    source: 'manual',
    tx_date: date,
    description: String(description).trim().slice(0, 500),
    amount: valor,
    category: String(category).trim(),
    category_confidence: 100,
    categorized_by: 'staff',
    payee: payee ? String(payee).trim() : null,
    memo: memo ? String(memo).trim() : null,
    status: 'approved',           // lançado à mão já faz parte do livro
    approved_at: new Date().toISOString(),
  }).select('id, tx_date, amount').single()

  if (error) {
    // memo pode não existir na tabela: repete sem ele antes de desistir
    if (/memo/i.test(error.message)) {
      const { data: n2, error: e2 } = await db.from('bank_transactions').insert({
        client_id: clientId, account_id: accountId, source: 'manual',
        tx_date: date, description: String(description).trim().slice(0, 500),
        amount: valor, category: String(category).trim(),
        category_confidence: 100, categorized_by: 'staff',
        payee: payee ? String(payee).trim() : null, status: 'approved',
      }).select('id, tx_date, amount').single()
      if (e2) return NextResponse.json({ error: e2.message }, { status: 500 })
      return NextResponse.json({
        ok: true, id: n2.id,
        aviso: (parecidas || []).length > 0
          ? `Atenção: já existe ${(parecidas || []).length} lançamento(s) do mesmo valor nesta conta e data.`
          : undefined,
        message: `Lançamento de ${valor < 0 ? '−' : ''}$${Math.abs(valor).toFixed(2)} incluído no registro.`,
      })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true, id: nova.id,
    aviso: (parecidas || []).length > 0
      ? `Atenção: já existe ${(parecidas || []).length} lançamento(s) do mesmo valor nesta conta e data — confira se não está duplicando.`
      : undefined,
    message: `Lançamento de ${valor < 0 ? '−' : ''}$${Math.abs(valor).toFixed(2)} incluído no registro de ${conta.name}.`,
  })
}
