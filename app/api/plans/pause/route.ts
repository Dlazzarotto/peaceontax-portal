// POST /api/plans/pause — pausa ou retoma um contrato de BOOKKEEPING
// Body: { planId, action: 'pause' | 'resume', reason }
// SÓ manager/owner. SÓ kind='bookkeeping' (parcelamento não pausa — serviço já entregue).

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return NextResponse.json({ error: 'Somente manager/owner' }, { status: 403 })
  }

  const { planId, action, reason } = await req.json()
  if (!planId || !['pause','resume'].includes(action)) {
    return NextResponse.json({ error: 'planId e action (pause|resume) obrigatórios' }, { status: 400 })
  }
  if (!reason?.trim()) {
    return NextResponse.json({ error: 'Motivo é obrigatório' }, { status: 400 })
  }

  const db = serviceDb()
  const { data: plan } = await db.from('payment_plans').select('*').eq('id', planId).single()
  if (!plan) return NextResponse.json({ error: 'Plano não encontrado' }, { status: 404 })

  if (plan.kind !== 'bookkeeping') {
    return NextResponse.json({ error: 'Somente contratos de bookkeeping podem ser pausados — parcelamento é cobrado até o fim (serviço já entregue).' }, { status: 400 })
  }
  if (!plan.stripe_subscription_id) {
    return NextResponse.json({ error: 'Contrato ainda não ativado no Stripe' }, { status: 409 })
  }
  if (action === 'pause' && plan.status !== 'active' && plan.status !== 'payment_failed') {
    return NextResponse.json({ error: `Não é possível pausar em status '${plan.status}'` }, { status: 409 })
  }
  if (action === 'resume' && plan.status !== 'paused') {
    return NextResponse.json({ error: 'O contrato não está pausado' }, { status: 409 })
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-06-24.dahlia' as Stripe.LatestApiVersion,
  })

  try {
    if (action === 'pause') {
      // 'void': faturas geradas durante a pausa são anuladas — nada é cobrado
      await stripe.subscriptions.update(plan.stripe_subscription_id, {
        pause_collection: { behavior: 'void' },
      })
    } else {
      await stripe.subscriptions.update(plan.stripe_subscription_id, {
        pause_collection: null as any,
      })
    }
  } catch (e) {
    console.error('Stripe pause/resume error:', e)
    return NextResponse.json({ error: `Stripe: ${(e as Error).message}` }, { status: 500 })
  }

  await db.from('payment_plans').update({
    status: action === 'pause' ? 'paused' : 'active',
    updated_at: new Date().toISOString(),
  }).eq('id', planId)

  await db.from('plan_audit').insert({
    plan_id: planId,
    action: action === 'pause' ? 'paused' : 'resumed',
    reason, performed_by: auth.userId,
  })

  return NextResponse.json({ ok: true })
}
