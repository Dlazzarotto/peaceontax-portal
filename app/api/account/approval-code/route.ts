// /api/account/approval-code — o código que libera UMA cobrança
//
// GET  → o código vivo deste gerente (se houver) + os últimos que ele usou,
//        com o que cada um autorizou
// POST → gera um código novo
//
// SÓ SÓCIO OU GERENTE. Quem gera é quem autoriza: o código sai no login da
// própria pessoa, nunca na máquina de quem está no balcão. Era isso que a
// senha do gerente digitada em máquina alheia fazia de errado.
//
// GERAR UM NOVO APAGA O ANTERIOR NÃO USADO. Sem isso, um gerente que clica
// três vezes deixa três autorizações vivas — e "um código por cobrança"
// viraria "três cobranças por tarde". Um gerente, um código vivo.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { podeAprovar } from '@/lib/recebimento-aprovacao'
import { gerarCodigo, MINUTOS_DE_VIDA } from '@/lib/codigo-autorizacao'

export const dynamic = 'force-dynamic'

async function exigeAprovador() {
  const auth = await getAuth()
  if (!auth?.isStaff) {
    return { erro: NextResponse.json({ error: 'Acesso restrito' }, { status: 403 }) }
  }
  const nivel = await getStaffLevel(auth.userId)
  if (!podeAprovar(nivel)) {
    return { erro: NextResponse.json({
      error: 'Só sócio ou gerente gera código de autorização.',
    }, { status: 403 }) }
  }
  return { auth, nivel }
}

export async function GET() {
  const g = await exigeAprovador()
  if (g.erro) return g.erro
  const db = serviceDb()

  const [{ data: vivo, error: errVivo }, { data: usados, error: errUsados }] = await Promise.all([
    db.from('approval_codes')
      .select('codigo, criado_em, expira_em')
      .eq('emitido_por', g.auth!.userId)
      .is('usado_em', null)
      .gt('expira_em', new Date().toISOString())
      .order('criado_em', { ascending: false })
      .limit(1),
    db.from('approval_codes')
      .select('codigo, usado_em, valor, forma, invoice_id, invoices(number)')
      .eq('emitido_por', g.auth!.userId)
      .not('usado_em', 'is', null)
      .order('usado_em', { ascending: false })
      .limit(10),
  ])

  // Consulta que falha não vira lista vazia: já custou tempo duas vezes.
  if (errVivo)  return NextResponse.json({ error: `Código vivo: ${errVivo.message}` }, { status: 500 })
  if (errUsados) return NextResponse.json({ error: `Histórico: ${errUsados.message}` }, { status: 500 })

  return NextResponse.json({
    nivel: g.nivel,
    vivo: vivo?.[0] || null,
    usados: (usados || []).map((u: any) => ({
      codigo: u.codigo, usado_em: u.usado_em, valor: u.valor, forma: u.forma,
      fatura: u.invoices?.number || null,
    })),
    minutos: MINUTOS_DE_VIDA,
  })
}

export async function POST(_req: NextRequest) {
  const g = await exigeAprovador()
  if (g.erro) return g.erro
  const db = serviceDb()
  const agora = new Date()

  // Um gerente, um código vivo.
  const { error: errLimpar } = await db.from('approval_codes')
    .update({ expira_em: agora.toISOString() })
    .eq('emitido_por', g.auth!.userId)
    .is('usado_em', null)
    .gt('expira_em', agora.toISOString())
  if (errLimpar) {
    return NextResponse.json({
      error: `Não foi possível encerrar o código anterior: ${errLimpar.message}`,
    }, { status: 500 })
  }

  const expira = new Date(agora.getTime() + MINUTOS_DE_VIDA * 60_000).toISOString()

  // Colisão é improvável (25^8), mas o índice único é quem garante — e
  // tentar de novo custa menos que explicar um erro de banco à equipe.
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const codigo = gerarCodigo()
    const { error } = await db.from('approval_codes').insert({
      codigo, emitido_por: g.auth!.userId, expira_em: expira,
    })
    if (!error) {
      return NextResponse.json({ ok: true, codigo, expira_em: expira, minutos: MINUTOS_DE_VIDA })
    }
    if (!/duplicate|unique/i.test(error.message)) {
      const faltaTabela = /approval_codes/.test(error.message) && /exist/i.test(error.message)
      return NextResponse.json({
        error: faltaTabela
          ? 'A tabela de códigos ainda não existe — rode sql/codigo-de-autorizacao-v1.sql.'
          : error.message,
      }, { status: 500 })
    }
  }
  return NextResponse.json({ error: 'Não foi possível gerar um código. Tente de novo.' }, { status: 500 })
}
