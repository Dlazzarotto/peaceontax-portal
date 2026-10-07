// /api/billing/consulta — autorização para consultar faturas além do dia
//
// GET   → a janela viva desta pessoa, se houver
// POST  { motivo, password, email? } → abre a janela (30 min)
//
// A REGRA: a lista de faturamento é do DIA e é de QUEM EMITIU. Olhar dia
// anterior ou fatura de outra pessoa é um ATO — pede senha e motivo de um
// gerente ou sócio (princípio 3). **Só o sócio tem acesso ilimitado** e não
// passa por aqui.
//
// DOIS CASOS, UMA ROTA:
//   · quem consulta JÁ É gerente ou sócio → a própria senha (`via: proprio`)
//   · é o assistente → e-mail e senha de um gerente/sócio (`via: senha`)
//
// A janela é a própria trilha (`invoice_query_audit`): quem liberou, para
// quem, por quê e até quando. Duas tabelas — uma para registrar e outra
// para valer — poderiam discordar, e discordando a pergunta "quem viu a
// carteira em setembro" deixa de ter resposta.
//
// O NÍVEL É CONFERIDO NO USO, não só aqui: `decidirConsulta` só aceita a
// janela, e a rota de faturas reconfere o nível de quem consulta. Quem foi
// rebaixado nesses 30 minutos não continua com a carteira aberta.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { MINUTOS_DA_JANELA, janelaViva } from '@/lib/escopo-faturas'

export const dynamic = 'force-dynamic'

/** A janela viva desta pessoa, se houver. Lê o ESTADO, não um contador. */
async function janelaDe(db: any, userId: string) {
  const { data, error } = await db.from('invoice_query_audit')
    .select('id, expira_em, reason, via, authorized_by, created_at')
    .eq('performed_by', userId)
    .gt('expira_em', new Date().toISOString())
    .order('expira_em', { ascending: false })
    .limit(1).maybeSingle()
  // Consulta que falha nao pode virar "sem janela": isso trancaria quem
  // acabou de ser autorizado, e a pessoa concluiria que a senha nao pegou.
  if (error && !/does not exist|not find/i.test(error.message || '')) {
    return { janela: null, erro: error.message }
  }
  return { janela: data && janelaViva(data.expira_em) ? data : null, erro: null as string | null }
}

export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const { janela, erro } = await janelaDe(serviceDb(), auth.userId)
  if (erro) return NextResponse.json({ error: `Não foi possível ler a autorização: ${erro}` }, { status: 500 })
  return NextResponse.json({ janela, minutos: MINUTOS_DA_JANELA })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const b = await req.json().catch(() => ({} as any))
  const motivo = String(b.motivo || '').trim()
  if (motivo.length < 5) {
    return NextResponse.json({
      error: 'Diga por que precisa ver além do dia de hoje (mínimo 5 caracteres). Fica na trilha.',
    }, { status: 400 })
  }
  if (!b.password) return NextResponse.json({ error: 'A senha do gerente ou sócio é obrigatória.' }, { status: 400 })

  const db = serviceDb()

  // De quem é a senha: a própria, ou a de um gerente que veio liberar.
  const { data: eu } = await db.auth.admin.getUserById(auth.userId)
  const meuEmail = eu?.user?.email || ''
  const email = String(b.email || '').trim() || meuEmail
  if (!email) return NextResponse.json({ error: 'Não foi possível identificar o login.' }, { status: 400 })

  const sbAuth = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
  const { data: sessao, error: pwErr } = await sbAuth.auth.signInWithPassword({
    email, password: String(b.password).trim(),
  })
  if (pwErr) {
    const m = pwErr.message || ''
    if (/rate|too many|429/i.test(m)) {
      return NextResponse.json({ error: 'Muitas tentativas. Aguarde 1 minuto.' }, { status: 429 })
    }
    return NextResponse.json({ error: `Senha não confere para ${email}.` }, { status: 401 })
  }

  const quemLiberou = sessao?.user?.id
  if (!quemLiberou) return NextResponse.json({ error: 'Não foi possível confirmar quem autorizou.' }, { status: 401 })

  // SENHA CERTA NÃO BASTA: o nível de quem autoriza é conferido. É a mesma
  // regra do recebimento — `podeAprovar` existe porque uma senha válida de
  // quem não pode aprovar não aprova nada.
  const nivelDeQuemLibera = await getStaffLevel(quemLiberou)
  if (nivelDeQuemLibera !== 'owner' && nivelDeQuemLibera !== 'manager') {
    return NextResponse.json({
      error: 'Essa senha é de alguém que não pode autorizar. Chame um gerente ou o sócio.',
    }, { status: 403 })
  }

  const expira = new Date(Date.now() + MINUTOS_DA_JANELA * 60_000).toISOString()
  const { error } = await db.from('invoice_query_audit').insert({
    performed_by: auth.userId,
    authorized_by: quemLiberou,
    staff_level: await getStaffLevel(auth.userId),
    via: quemLiberou === auth.userId ? 'proprio' : 'senha',
    reason: motivo,
    pedido: b.pedido ?? null,
    expira_em: expira,
  })
  if (error) {
    return NextResponse.json({
      error: `A consulta NÃO foi liberada: não deu para gravar a trilha (${error.message}). `
        + 'Se a mensagem fala de relação inexistente, falta rodar sql/consulta-de-faturas-v1.sql.',
    }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    expiraEm: expira,
    minutos: MINUTOS_DA_JANELA,
    message: `Consulta liberada por ${MINUTOS_DA_JANELA} minutos.`,
  })
}
