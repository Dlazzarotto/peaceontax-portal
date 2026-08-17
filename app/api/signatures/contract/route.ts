// /api/signatures/contract
//
// GET  ?planId=...&preview=1  → mostra o contrato preenchido, SEM enviar
// POST { planId, signerTitle? } → envia via DocuSign
//
// Os dois usam lib/contract-html.ts: o que você confere na prévia é
// exatamente o que o cliente recebe para assinar.
// Só manager/owner.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { sendEnvelope } from '@/lib/docusign'
import { montarContratoHtml, FIRM } from '@/lib/contract-html'

export const dynamic = 'force-dynamic'

async function carregarPlano(planId: string) {
  const db = serviceDb()
  const { data: plan } = await db
    .from('payment_plans')
    .select('*, clients(id, name, email, business_name, type, language)')
    .eq('id', planId)
    .single()
  return plan
}

// ───────────────────────── PRÉVIA ─────────────────────────
export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return new NextResponse('Acesso restrito', { status: 403 })
  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return new NextResponse('Somente gerente ou sócio visualizam contratos', { status: 403 })
  }

  const planId = req.nextUrl.searchParams.get('planId')
  if (!planId) return new NextResponse('planId obrigatório', { status: 400 })

  const plan = await carregarPlano(planId)
  if (!plan) return new NextResponse('Plano não encontrado', { status: 404 })

  const client = (plan as any).clients || {}
  const html = montarContratoHtml({
    plan,
    client,
    signerTitle: req.nextUrl.searchParams.get('title'),
    previa: true,
  })

  return new NextResponse(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

// ───────────────────────── ENVIO ─────────────────────────
export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return NextResponse.json({ error: 'Somente manager/owner enviam contratos' }, { status: 403 })
  }

  const { planId, signerTitle } = await req.json()
  if (!planId) return NextResponse.json({ error: 'planId obrigatório' }, { status: 400 })

  const db = serviceDb()
  const plan = await carregarPlano(planId)
  if (!plan) return NextResponse.json({ error: 'Plano não encontrado' }, { status: 404 })

  const client = (plan as any).clients
  if (!client?.email || !client.email.includes('@')) {
    return NextResponse.json({ error: 'Cliente sem e-mail válido — corrija no Profile antes de enviar' }, { status: 400 })
  }
  if (client.type === 'business' && !signerTitle?.trim()) {
    return NextResponse.json({ error: 'Cliente business: informe o cargo do assinante (ex.: President, Member)' }, { status: 400 })
  }

  const { data: existing } = await db.from('signature_requests')
    .select('id, status').eq('plan_id', planId)
    .in('status', ['sent', 'delivered', 'completed']).maybeSingle()
  if (existing) {
    return NextResponse.json({
      error: `Já existe contrato ${existing.status === 'completed' ? 'assinado' : 'enviado'} para este plano`,
    }, { status: 409 })
  }

  const lang = client.language === 'pt' ? 'pt' : 'en'
  const html = montarContratoHtml({ plan, client, signerTitle, previa: false })

  try {
    const { envelopeId } = await sendEnvelope({
      doc: {
        name: lang === 'pt' ? 'Contrato-Peace-on-Tax.html' : 'Agreement-Peace-on-Tax.html',
        base64: Buffer.from(html, 'utf-8').toString('base64'),
        fileExtension: 'html',
      },
      signers: [
        { name: client.name, email: client.email, title: signerTitle || undefined },
        { name: 'David Lazzarotto', email: 'david@peaceontax.com' },
      ],
      emailSubject: lang === 'pt'
        ? `Contrato de serviços — ${FIRM.name}`
        : `Service agreement — ${FIRM.name}`,
      emailBody: lang === 'pt'
        ? 'Por favor, revise e assine o contrato. Qualquer dúvida: (833) 732-2327.'
        : 'Please review and sign the agreement. Questions: (833) 732-2327.',
      anchorMode: true,
    })

    const { data: sig } = await db.from('signature_requests').insert({
      client_id: client.id, plan_id: planId, kind: 'contract',
      envelope_id: envelopeId,
      signers: [
        { name: client.name, email: client.email, title: signerTitle || null },
        { name: 'David Lazzarotto', email: 'david@peaceontax.com' },
      ],
      created_by: auth.userId,
    }).select('id').single()

    await db.from('plan_audit').insert({
      plan_id: planId, action: 'contract_sent', performed_by: auth.userId,
      snapshot: { envelopeId, signatureRequestId: sig?.id },
    })

    return NextResponse.json({ ok: true, envelopeId })
  } catch (e) {
    console.error('Contract send error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
