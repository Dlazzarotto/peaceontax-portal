// GET /api/portal/contract-return?id=… — volta do DocuSign depois da assinatura no portal
//
// O DocuSign redireciona o cliente para cá com ?event=signing_complete (ou
// cancel, decline…). O parâmetro não vale como prova: a assinatura é
// conferida pela API (getRecipients). Se o cliente assinou:
//   1. marca em plan_audit ('contract_signed_by_client') — é o que libera
//      o cadastro do débito; a firma assina depois e o envelope completa
//   2. cria a sessão do Stripe do plano e manda o cliente direto para lá
// Sem assinatura: volta para Pagamentos com o aviso de pendente.
// Só o dono do cadastro (a sessão do portal continua válida no retorno).

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getRecipients, getEnvelopeStatus } from '@/lib/docusign'
import { criarSessaoDoPlano, stripeClient } from '@/lib/plan-checkout'
import { APP_URL } from '@/lib/avisos'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const voltar = (q: string) => NextResponse.redirect(`${APP_URL.replace(/\/$/, '')}/portal/payments?${q}`, 302)

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth || auth.isStaff) return NextResponse.redirect(`${APP_URL.replace(/\/$/, '')}/login?redirectTo=/portal/payments`, 302)

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return voltar('contrato=pendente')

  const db = serviceDb()
  const { data: c } = await db.from('clients').select('id, email').eq('user_id', auth.userId).maybeSingle()
  if (!c) return voltar('contrato=pendente')

  const { data: sr } = await db.from('signature_requests')
    .select('id, envelope_id, status, plan_id').eq('id', id).eq('client_id', c.id).maybeSingle()
  if (!sr) return voltar('contrato=pendente')

  try {
    const recips = await getRecipients(sr.envelope_id)
    const eu = recips.find(r => r.clientUserId === c.id) || recips.find(r => r.email === String(c.email || '').toLowerCase())
    if (eu?.status !== 'completed') return voltar('contrato=pendente')

    // Marca a assinatura do cliente (uma vez só) e atualiza o status do envelope
    const { data: jaMarcado } = sr.plan_id
      ? await db.from('plan_audit').select('id').eq('plan_id', sr.plan_id).eq('action', 'contract_signed_by_client').limit(1).maybeSingle()
      : { data: null }
    if (sr.plan_id && !jaMarcado) {
      await db.from('plan_audit').insert({
        plan_id: sr.plan_id, action: 'contract_signed_by_client', performed_by: auth.userId,
        snapshot: { envelopeId: sr.envelope_id, signedAt: eu.signedDateTime || new Date().toISOString() },
      }).then(() => null, () => null)
    }
    const statusEnvelope = await getEnvelopeStatus(sr.envelope_id).catch(() => null)
    if (statusEnvelope && statusEnvelope !== sr.status && statusEnvelope !== 'completed') {
      // 'completed' (firma já assinou) fica para a rota da equipe, que arquiva o PDF
      await db.from('signature_requests').update({ status: statusEnvelope, updated_at: new Date().toISOString() }).eq('id', sr.id)
    }

    // Direto para o cadastro do débito automático
    if (sr.plan_id && process.env.STRIPE_SECRET_KEY) {
      const { data: plan } = await db.from('payment_plans')
        .select('*, clients(name, email, language)').eq('id', sr.plan_id).maybeSingle()
      if (plan && ['draft', 'awaiting_entry', 'awaiting_setup'].includes(plan.status)) {
        const { url } = await criarSessaoDoPlano(db, stripeClient(), plan, { origem: 'cliente', performedBy: auth.userId })
        return NextResponse.redirect(url, 302)
      }
    }
    return voltar('contrato=assinado')
  } catch (e) {
    console.error('portal contract-return:', e)
    return voltar('contrato=assinado')
  }
}
