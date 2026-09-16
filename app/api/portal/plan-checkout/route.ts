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
import { nomeDaForma } from '@/lib/stripe-formas'

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
    const { url, recusadas } = await criarSessaoDoPlano(db, stripeClient(), plan, { origem: 'cliente', performedBy: auth.userId })
    // A conta do Stripe recusou alguma forma: o cliente segue com o que sobrou,
    // mas a equipe precisa saber — senão ninguém descobre que o ACH caiu.
    if (recusadas.length) await alertarFormas(db, plan, recusadas)
    return NextResponse.json({ ok: true, url })
  } catch (e) {
    // O motivo real não pode morrer no log: sem ele a equipe só ouve do
    // cliente que "não deu", e foi assim que um parcelamento ficou parado.
    console.error('portal plan-checkout:', plan.id, e)
    await alertarFalha(db, plan, e)
    return NextResponse.json({
      error: 'Não foi possível abrir o cadastro do débito automático. Já avisamos nossa equipe — se preferir, fale conosco: (833) 732-2327.',
    }, { status: 502 })
  }
}

/** Alerta a equipe quando a conta do Stripe recusou uma forma de pagamento. */
async function alertarFormas(db: any, plan: any, recusadas: string[]) {
  await db.from('plan_alerts').insert({
    plan_id: plan.id, client_id: plan.client_id, type: 'stripe_forma_inativa',
    message: `⚠️ ${plan.clients?.name || 'Cliente'} abriu o cadastro do débito e a conta do Stripe recusou ${recusadas.map(nomeDaForma).join(' e ')}`
      + ' — não está ativado em Settings → Payment methods. O link foi criado sem essa forma.',
  }).then(() => null, () => null)
}

/** Alerta a equipe quando a sessão nem chegou a nascer: o cliente ficou sem saída. */
async function alertarFalha(db: any, plan: any, e: any) {
  const motivo = String(e?.raw?.message || e?.message || e).slice(0, 400)
  await db.from('plan_alerts').insert({
    plan_id: plan.id, client_id: plan.client_id, type: 'checkout_falhou',
    message: `🛑 ${plan.clients?.name || 'O cliente'} tentou cadastrar o débito automático e o Stripe recusou a sessão: ${motivo}`
      + ' — ele NÃO conseguiu pagar nem autorizar as parcelas. Resolver e avisar o cliente.',
  }).then(() => null, () => null)
  await db.from('plan_audit').insert({
    plan_id: plan.id, action: 'checkout_failed', performed_by: null,
    snapshot: { motivo, origem: 'cliente' },
  }).then(() => null, () => null)
}
