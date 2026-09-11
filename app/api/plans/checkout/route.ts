// POST /api/plans/checkout — gera o link de pagamento do plano
// Body: { planId }
// A sessão é montada em lib/plan-checkout.ts (mesma regra do portal e do
// parcelamento de fatura): entrada, cadastro sem cobrança ou assinatura
// ancorada no dia acordado.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { criarSessaoDoPlano, stripeClient } from '@/lib/plan-checkout'

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://peaceontax-portal.vercel.app'

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return NextResponse.json({ error: 'Somente manager/owner' }, { status: 403 })
  }

  const { planId } = await req.json()
  if (!planId) return NextResponse.json({ error: 'planId obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: plan } = await db
    .from('payment_plans')
    .select('*, clients(name, email, language)')
    .eq('id', planId)
    .single()

  if (!plan) return NextResponse.json({ error: 'Plano não encontrado' }, { status: 404 })
  if (!['draft','awaiting_entry','awaiting_setup'].includes(plan.status)) {
    return NextResponse.json({ error: `Plano em status '${plan.status}' não gera novo link` }, { status: 409 })
  }

  try {
    const { url, sessionId } = await criarSessaoDoPlano(db, stripeClient(), plan, {
      origem: 'equipe', performedBy: auth.userId, baseUrl: BASE_URL,
    })
    return NextResponse.json({ url, sessionId })
  } catch (e) {
    console.error('Plan checkout error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
