// POST /api/portal/contract-sign — o CLIENTE abre a assinatura do contrato no portal
//   Body: { id }  (signature_requests.id)
//
// Só o dono do cadastro. Devolve a URL da tela do DocuSign, que vale poucos
// minutos: é gerada na hora do clique. Ao terminar, o DocuSign devolve o
// cliente para /api/portal/contract-return, que confere a assinatura pela
// API e o leva ao cadastro do débito automático.
//
// Contrato do fluxo ANTIGO (enviado por e-mail do DocuSign, sem assinante
// embutido) também assina aqui: a rota promove o destinatário a embutido na
// hora. Antes ela recusava, e o cliente ficava sem botão — com a fatura
// parcelada travada, porque o débito só libera depois da assinatura.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { createRecipientView, getRecipients, tornarAssinanteEmbutido } from '@/lib/docusign'
import { APP_URL } from '@/lib/avisos'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
  if (auth.isStaff) return NextResponse.json({ error: 'Rota do cliente' }, { status: 403 })

  const { id } = await req.json().catch(() => ({}))
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: c } = await db.from('clients').select('id, name, email').eq('user_id', auth.userId).maybeSingle()
  if (!c) return NextResponse.json({ error: 'Cadastro não encontrado' }, { status: 404 })

  const { data: sr } = await db.from('signature_requests')
    .select('id, envelope_id, status, kind, plan_id, signers')
    .eq('id', id).eq('client_id', c.id).eq('kind', 'contract').maybeSingle()
  if (!sr) return NextResponse.json({ error: 'Contrato não encontrado' }, { status: 404 })
  if (!['sent', 'delivered'].includes(sr.status)) return NextResponse.json({ error: 'Este contrato não está aguardando assinatura.' }, { status: 409 })
  try {
    // Já assinou (voltou sem passar pelo retorno)? Então vai direto ao cadastro do débito.
    const recips = await getRecipients(sr.envelope_id)
    const eu = recips.find(r => r.clientUserId === c.id) || recips.find(r => r.email === String(c.email || '').toLowerCase())
    if (eu?.status === 'completed') {
      return NextResponse.json({ ok: true, url: `${APP_URL}/api/portal/contract-return?id=${sr.id}` })
    }
    if (!eu) {
      return NextResponse.json({
        error: 'Não encontramos você entre os signatários deste contrato. Fale conosco: (833) 732-2327.',
      }, { status: 409 })
    }

    // Fluxo antigo: o destinatário não tem clientUserId, então não há tela
    // embutida para abrir. Promove agora — o link do e-mail dele deixa de
    // valer, e é por isso que só acontece quando ELE pede.
    if (!eu.clientUserId) {
      await tornarAssinanteEmbutido(sr.envelope_id, {
        recipientId: eu.recipientId, email: eu.email, name: eu.name, clientUserId: c.id,
      })
      const assinantes = Array.isArray(sr.signers) ? [...sr.signers] : []
      if (assinantes[0]) assinantes[0] = { ...assinantes[0], embedded: true, promovido_em: new Date().toISOString() }
      await db.from('signature_requests').update({ signers: assinantes }).eq('id', sr.id)
      await db.from('plan_audit').insert({
        plan_id: sr.plan_id, action: 'contract_signer_embedded', performed_by: auth.userId,
        snapshot: { envelope: sr.envelope_id, recipientId: eu.recipientId, motivo: 'assinatura pelo portal' },
      }).then(() => null, () => null)
    }

    // E-mail e nome têm de ser os do DESTINATÁRIO do envelope, não os do
    // cadastro: se o cliente trocou de e-mail depois do envio, o DocuSign
    // recusa a view por não reconhecer quem está pedindo.
    const url = await createRecipientView(sr.envelope_id, {
      email: eu.email || c.email, name: eu.name || c.name, clientUserId: c.id,
      returnUrl: `${APP_URL.replace(/\/$/, '')}/api/portal/contract-return?id=${sr.id}`,
    })
    return NextResponse.json({ ok: true, url })
  } catch (e) {
    console.error('portal contract-sign:', e)
    return NextResponse.json({ error: 'Não foi possível abrir o contrato. Tente de novo ou fale conosco: (833) 732-2327.' }, { status: 502 })
  }
}
