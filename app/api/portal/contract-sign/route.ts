// POST /api/portal/contract-sign — o CLIENTE abre a assinatura do contrato no portal
//   Body: { id }  (signature_requests.id)
//
// Só o dono do cadastro, só contrato enviado para assinatura no portal
// (assinante embutido). Devolve a URL da tela do DocuSign, que vale poucos
// minutos: é gerada na hora do clique. Ao terminar, o DocuSign devolve o
// cliente para /api/portal/contract-return, que confere a assinatura pela
// API e o leva ao cadastro do débito automático.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { createRecipientView, getRecipients } from '@/lib/docusign'
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
  const embedded = Array.isArray(sr.signers) && sr.signers[0]?.embedded
  if (!embedded) {
    return NextResponse.json({ error: 'Este contrato foi enviado por e-mail do DocuSign: assine pelo link recebido.' }, { status: 409 })
  }

  try {
    // Já assinou (voltou sem passar pelo retorno)? Então vai direto ao cadastro do débito.
    const recips = await getRecipients(sr.envelope_id)
    const eu = recips.find(r => r.clientUserId === c.id) || recips.find(r => r.email === String(c.email || '').toLowerCase())
    if (eu?.status === 'completed') {
      return NextResponse.json({ ok: true, url: `${APP_URL}/api/portal/contract-return?id=${sr.id}` })
    }
    const url = await createRecipientView(sr.envelope_id, {
      email: c.email, name: c.name, clientUserId: c.id,
      returnUrl: `${APP_URL.replace(/\/$/, '')}/api/portal/contract-return?id=${sr.id}`,
    })
    return NextResponse.json({ ok: true, url })
  } catch (e) {
    console.error('portal contract-sign:', e)
    return NextResponse.json({ error: 'Não foi possível abrir o contrato. Tente de novo ou fale conosco: (833) 732-2327.' }, { status: 502 })
  }
}
