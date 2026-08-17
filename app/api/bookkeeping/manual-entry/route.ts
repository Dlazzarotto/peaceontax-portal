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
import { createClient } from '@supabase/supabase-js'
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

  // Lançamento manual entra direto no livro sem passar pelo banco:
  // exige confirmação com a senha de quem está lançando.
  if (!b.password) {
    return NextResponse.json({ error: 'Confirme com a sua senha para lançar manualmente.' }, { status: 400 })
  }
  {
    const dbAuth = serviceDb()
    const { data: quem } = await dbAuth.auth.admin.getUserById(auth.userId)
    const email = quem?.user?.email
    if (!email) return NextResponse.json({ error: 'Não foi possível identificar seu login.' }, { status: 400 })

    const sbAuth = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
    const { error: pwErr } = await sbAuth.auth.signInWithPassword({
      email, password: String(b.password).trim(),
    })
    if (pwErr) {
      const m = pwErr.message || ''
      if (/rate|too many|429/i.test(m)) {
        return NextResponse.json({ error: 'Muitas tentativas. Aguarde 1 minuto.' }, { status: 429 })
      }
      return NextResponse.json({ error: `Senha não confere para ${email}.` }, { status: 401 })
    }
  }

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

  // Grava tolerando colunas que este banco não tem (ex.: memo, approved_at).
  // Em vez de falhar, remove o campo que o banco não reconhece e tenta de novo.
  const base: Record<string, unknown> = {
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
    status: 'approved',            // lançado à mão já faz parte do livro
  }

  let nova: any = null
  let ultimoErro = ''
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const { data, error } = await db.from('bank_transactions')
      .insert(base).select('id, tx_date, amount').single()
    if (!data && error) {
      ultimoErro = error.message
      // "Could not find the 'x' column" / "column \"x\" does not exist"
      const m = error.message.match(/["']([a-z_]+)["']\s*column/i)
        || error.message.match(/column\s+["']?([a-z_]+)["']?/i)
      const coluna = m?.[1]
      if (coluna && coluna in base) { delete base[coluna]; continue }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    nova = data
    break
  }
  if (!nova) return NextResponse.json({ error: ultimoErro || 'Não foi possível gravar o lançamento.' }, { status: 500 })

  return NextResponse.json({
    ok: true, id: nova.id,
    aviso: (parecidas || []).length > 0
      ? `Atenção: já existe ${(parecidas || []).length} lançamento(s) do mesmo valor nesta conta e data — confira se não está duplicando.`
      : undefined,
    message: `Lançamento de ${valor < 0 ? '−' : ''}$${Math.abs(valor).toFixed(2)} incluído no registro de ${conta.name}.`,
  })
}
