// POST /api/clients/access — reenviar acesso ao portal (cliente perdeu o e-mail antigo)
// Body: { clientId, newEmail?, reason, managerPin? }
// - Atualiza o e-mail de login no Auth (se newEmail informado e usuário existir)
// - Envia link de recuperação de senha ao e-mail (novo ou atual)
// - Envia AVISO ao e-mail antigo (proteção anti-fraude)
// - Motivo SEMPRE obrigatório. Junior: PIN de manager.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel, validateManagerPin } from '@/lib/staff-perms'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://peaceontax-portal.vercel.app'
const FROM    = process.env.RESEND_FROM_EMAIL || 'noreply@peaceontax.com'

async function sendEmail(to: string, subject: string, html: string) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({ from: `Peace on Tax <${FROM}>`, to, subject, html }),
  })
  if (!r.ok) console.error('Resend error:', await r.text())
  return r.ok
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito à equipe' }, { status: 403 })

  const { clientId, newEmail, reason, managerPin } = await req.json()
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  if (!reason?.trim()) return NextResponse.json({ error: 'Motivo é obrigatório para reenvio de acesso' }, { status: 400 })
  if (newEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail)) {
    return NextResponse.json({ error: 'Novo e-mail inválido' }, { status: 400 })
  }

  const level = await getStaffLevel(auth.userId)
  let approvedBy: string | null = null
  if (level === 'junior') {
    approvedBy = await validateManagerPin(managerPin ?? '')
    if (!approvedBy) return NextResponse.json({ error: 'PIN de manager inválido' }, { status: 403 })
  }

  const db = serviceDb()
  const { data: client } = await db.from('clients').select('*').eq('id', clientId).single()
  if (!client) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })

  const oldEmail = client.email
  const targetEmail = (newEmail || client.email || '').toLowerCase().trim()
  if (!targetEmail) return NextResponse.json({ error: 'Cliente sem e-mail cadastrado' }, { status: 400 })

  // 1. Atualiza o e-mail de LOGIN se o cliente já tem conta e o e-mail mudou
  let loginUpdated = false
  if (client.user_id && newEmail && newEmail !== oldEmail) {
    const { error: authErr } = await db.auth.admin.updateUserById(client.user_id, {
      email: targetEmail,
      email_confirm: true,
    })
    if (authErr) return NextResponse.json({ error: `Erro ao atualizar login: ${authErr.message}` }, { status: 500 })
    loginUpdated = true
  }

  // 2. Atualiza o e-mail de contato na tabela clients
  if (newEmail && newEmail !== oldEmail) {
    await db.from('clients').update({ email: targetEmail, updated_at: new Date().toISOString() }).eq('id', clientId)
  }

  // 3. Gera link de acesso
  let accessLink = `${APP_URL}/login`
  if (client.user_id) {
    const { data: linkData } = await db.auth.admin.generateLink({
      type: 'recovery',
      email: targetEmail,
      options: { redirectTo: `${APP_URL}/reset-password` },
    })
    if (linkData?.properties?.action_link) accessLink = linkData.properties.action_link
  }

  // 4. Envia o link ao e-mail (novo ou atual)
  await sendEmail(
    targetEmail,
    'Seu acesso ao portal Peace on Tax',
    `<div style="font-family:sans-serif;max-width:520px">
      <h2 style="color:#2D3278">Peace on Tax Corp</h2>
      <p>Olá, ${client.name}!</p>
      <p>Aqui está o link para ${loginUpdated ? 'acessar sua conta com o novo e-mail' : 'recuperar seu acesso ao portal'}:</p>
      <p><a href="${accessLink}" style="background:#2D3278;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Acessar o Portal</a></p>
      <p style="color:#6a7a9a;font-size:13px">Se você não solicitou este acesso, ignore este e-mail ou ligue (833) 732-2327.</p>
      <p style="color:#6a7a9a;font-size:12px">Peace on Tax Corp · 75 Pleasant St Suite 119, Malden, MA 02148</p>
    </div>`
  )

  // 5. AVISO ANTI-FRAUDE ao e-mail antigo (se mudou)
  if (loginUpdated && oldEmail && oldEmail !== targetEmail) {
    await sendEmail(
      oldEmail,
      'Alteração de e-mail na sua conta Peace on Tax',
      `<div style="font-family:sans-serif;max-width:520px">
        <h2 style="color:#2D3278">Peace on Tax Corp</h2>
        <p>O e-mail de acesso da sua conta foi alterado para <strong>${targetEmail}</strong> a seu pedido.</p>
        <p style="color:#b02020;font-weight:bold">Se você NÃO solicitou essa alteração, ligue imediatamente: (833) 732-2327.</p>
        <p style="color:#6a7a9a;font-size:12px">Peace on Tax Corp · 75 Pleasant St Suite 119, Malden, MA 02148</p>
      </div>`
    )
  }

  // 6. Auditoria
  await db.from('client_audit').insert({
    client_id: clientId,
    action: 'invite_resent',
    reason,
    performed_by: auth.userId,
    approved_by: approvedBy,
    previous_state: { email: oldEmail },
    new_state: { email: targetEmail, login_updated: loginUpdated },
  })

  return NextResponse.json({ ok: true, sentTo: targetEmail, loginUpdated })
}
