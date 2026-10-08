import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'
import { getAuth, canAccessClient, clientesOcultos, podeVerEmpresas } from '@/lib/api-auth';

const PORTAL_URL  = process.env.NEXT_PUBLIC_APP_URL || 'https://peaceontax-portal.vercel.app'
const FIRM_NAME   = 'Peace on Tax'
const EXPIRY_DAYS = 7

function buildEmailHTML(vars: { clientEmail: string; assignee: string; inviteUrl: string; customNote?: string }) {
  const { clientEmail, assignee, inviteUrl, customNote } = vars
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f0f4fa;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4fa;padding:40px 20px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
  <tr><td style="background:linear-gradient(135deg,#2D3278,#1a1f5e);border-radius:16px 16px 0 0;padding:28px;text-align:center;">
    <div style="font-size:28px;margin-bottom:8px;">📒</div>
    <h1 style="color:#fff;font-size:20px;margin:0;font-family:Georgia,serif;">${FIRM_NAME}</h1>
    <p style="color:rgba(255,255,255,0.5);font-size:12px;margin:4px 0 0;">portal.peaceontax.com</p>
  </td></tr>
  <tr><td style="background:#fff;padding:32px 36px;">
    <h2 style="color:#2D3278;font-size:20px;margin:0 0 12px;font-family:Georgia,serif;">You have been invited!</h2>
    <p style="color:#3a4a5a;font-size:15px;line-height:1.7;margin:0 0 16px;">${assignee} from ${FIRM_NAME} has set up a secure client portal for you at <strong>${clientEmail}</strong>.</p>
    ${customNote ? `<div style="background:#fff8e8;border-left:4px solid #F47B20;padding:12px 16px;border-radius:0 8px 8px 0;font-size:14px;color:#5a4a1a;font-style:italic;margin-bottom:20px;">"${customNote}"</div>` : ''}
    <p style="color:#3a4a5a;font-size:14px;line-height:1.6;margin:0 0 20px;">Click the button below to create your account. You will choose your password and fill in your information — it only takes 2 minutes.</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${inviteUrl}" style="background:linear-gradient(135deg,#2D3278,#1a1f5e);color:#fff;padding:14px 36px;border-radius:12px;text-decoration:none;font-size:15px;font-weight:700;display:inline-block;">Create My Account →</a>
    </div>
    <p style="color:#9aaab0;font-size:12px;text-align:center;">This link expires in ${EXPIRY_DAYS} days. If you have questions, reply to this email.</p>
  </td></tr>
  <tr><td style="background:#f0f4fa;border-radius:0 0 16px 16px;padding:16px;text-align:center;">
    <p style="color:#9aaab0;font-size:11px;margin:0;">🔒 Secure & encrypted · ${FIRM_NAME} · Massachusetts</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`
}

export async function POST(req: NextRequest) {
  try {
    // Convite sai em nome da firma: só a equipe manda. O middleware garantia
    // apenas que havia sessão — um cliente logado no portal podia convidar
    // quem quisesse como se fosse a Peace on Tax.
    const auth = await getAuth()
    if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

    const body = await req.json()
    const { clientName, clientEmail, clientType, language, assignee, customNote, channels, createdBy, clientId } = body
    // Escopo por TIPO: o assistente fica em pessoa fisica. canAccessClient
    // e o funil das outras ~40 rotas -- esta ficou de fora quando o escopo
    // foi criado, e sem ele bastava passar o id de uma empresa.
    // clientId e opcional aqui (convite pode nascer sem cadastro):
    // quando vem, o escopo vale.
    if (clientId && !(await canAccessClient(auth, clientId)))
      return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })
    if (!clientEmail) return NextResponse.json({ error: 'Email is required' }, { status: 400 })

    const db = supabaseAdmin()
    const { data: invite, error } = await db.from('client_invitations').insert({
      // De quem é este convite. Sem isto, aceitar criava um cadastro NOVO em
      // vez de completar o que já existe — e quem foi importado ficava com
      // dois cadastros, um sem login e outro com, e o histórico partido.
      client_id:    clientId || null,
      client_name:  clientName || clientEmail.split('@')[0],
      client_email: clientEmail,
      client_type:  clientType || 'individual',
      language:     language || 'en',
      assignee:     assignee || 'Staff',
      message_note: customNote || null,
      sent_via:     channels || ['email'],
      status:       'pending',
      created_by:   createdBy || 'Staff',
      expires_at:   new Date(Date.now() + EXPIRY_DAYS * 86400000).toISOString(),
    }).select().single()

    if (error) throw error

    const inviteUrl = `${PORTAL_URL}/invite/${invite.token}`
    let emailSent   = false

    if (channels?.includes('email') && clientEmail) {
      const resendKey   = process.env.RESEND_API_KEY
      const fromEmail   = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'

      if (resendKey) {
        try {
          const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from:     `${FIRM_NAME} <${fromEmail}>`,
              to:       [clientEmail],
              subject:  `You have been invited to ${FIRM_NAME} Client Portal`,
              html:     buildEmailHTML({ clientEmail, assignee: assignee || 'Your accountant', inviteUrl, customNote }),
              reply_to: 'info@peaceontax.com',
            }),
          })
          const emailData = await emailRes.json()
          if (emailRes.ok) emailSent = true
          else console.error('Resend error:', emailData)
        } catch (e) {
          console.error('Email send failed:', e)
        }
      }
    }

    await db.from('client_invitations').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', invite.id)

    return NextResponse.json({ success: true, inviteUrl, token: invite.token, emailSent })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// GET → a lista de convites, para a tela /invitations. SÓ A EQUIPE.
//
// Ficou aberta enquanto o POST foi fechado: o middleware só exige login, e a
// auditoria conferia o ARQUIVO ("tem isStaff em algum lugar"), não cada
// verbo. Qualquer cliente logado no portal lia todos os convites — nome,
// e-mail e o TOKEN, que é o que cria a conta: com ele dava para registrar-se
// no lugar do convidado. Agora a auditoria confere verbo por verbo.
//
// E vale o escopo por TIPO, como em /api/clients: quem não pode abrir
// empresa não vê convite de empresa (nem o da própria firma). O convite pode
// não ter cadastro ligado (`client_id` nulo), então o tipo do próprio
// convite também conta.
export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const { ocultos, erro: errEscopo } = await clientesOcultos(auth)
  if (errEscopo) return NextResponse.json({ error: errEscopo }, { status: 500 })
  const veEmpresas = await podeVerEmpresas(auth)

  const db = supabaseAdmin()
  const { data, error } = await db.from('client_invitations').select('*').order('created_at', { ascending: false })
  // Consulta que falha não vira "nenhum convite": a tela diria que não há
  // ninguém esperando acesso.
  if (error) return NextResponse.json({ error: `Não foi possível ler os convites: ${error.message}` }, { status: 500 })

  const invitations = (data || []).filter((c: any) =>
    !(c.client_id && ocultos.has(c.client_id)) &&
    (veEmpresas || c.client_type !== 'business'))
  return NextResponse.json({ invitations })
}
