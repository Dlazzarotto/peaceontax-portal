// POST /api/portal/plan-checkout — o CLIENTE cadastra o débito automático de um plano
//   Body: { planId }
//
// Parcelamento com entrada → paga a entrada e salva o método (cartão ou ACH)
// Parcelamento sem entrada / mensalidade → cadastra conta bancária ou cartão,
//   com mandato ACH, sem cobrar nada agora (a mensalidade começa no dia acordado)
//
// Só o dono do cadastro, e só plano que a equipe já liberou (awaiting_*).
// Rascunho não aparece para o cliente. A sessão é criada na hora (o link
// do Stripe expira em 24h), pela mesma lib que a equipe usa.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { criarSessaoDoPlano, stripeClient, contratoPendenteDoPlano } from '@/lib/plan-checkout'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
  if (auth.isStaff) return NextResponse.json({ error: 'Rota do cliente' }, { status: 403 })
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: 'Cadastro online indisponível no momento.' }, { status: 503 })

  const { planId } = await req.json().catch(() => ({}))
  if (!planId) return NextResponse.json({ error: 'planId obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: c } = await db.from('clients').select('id').eq('user_id', auth.userId).maybeSingle()
  if (!c) return NextResponse.json({ error: 'Cadastro não encontrado' }, { status: 404 })

  const { data: plan } = await db.from('payment_plans')
    .select('*, clients(name, email, language)')
    .eq('id', planId).eq('client_id', c.id).maybeSingle()
  if (!plan) return NextResponse.json({ error: 'Plano não encontrado' }, { status: 404 })
  if (!['awaiting_entry', 'awaiting_setup'].includes(plan.status)) {
    return NextResponse.json({ error: 'Este plano não está aguardando cadastro.' }, { status: 409 })
  }
  // Primeiro a assinatura (autorização do débito), depois a conta
  if (await contratoPendenteDoPlano(db, plan.id)) {
    return NextResponse.json({ error: 'Assine o contrato antes de cadastrar o débito automático.' }, { status: 409 })
  }

  try {
    const { url } = await criarSessaoDoPlano(db, stripeClient(), plan, { origem: 'cliente', performedBy: auth.userId })
    return NextResponse.json({ ok: true, url })
  } catch (e) {
    console.error('portal plan-checkout:', e)
    return NextResponse.json({ error: 'Não foi possível abrir o cadastro. Tente de novo ou fale conosco: (833) 732-2327.' }, { status: 502 })
  }
}
