import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'

const PORTAL_URL  = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.peaceontax.com'
const FIRM_NAME   = 'Peace on Tax'
const FIRM_PHONE  = '(617) 555-0100'
const EXPIRY_DAYS = 7

function buildEmailHTML(vars: {
  clientName: string, clientType: string, assignee: string,
  inviteUrl: string, customNote?: string, language: string
}) {
  const { clientName, clientType, assignee, inviteUrl, customNote, language } = vars

  const copy: Record<string, any> = {
    en: { greeting: `Hello, ${clientName}!`, intro: `${assignee} from ${FIRM_NAME} has set up your secure client portal.`, cta: 'Access My Portal', expiry: `This link expires in ${EXPIRY_DAYS} days.` },
    pt: { greeting: `Olá, ${clientName}!`, intro: `${assignee} de ${FIRM_NAME} configurou seu portal seguro de cliente.`, cta: 'Acessar Meu Portal', expiry: `Este link expira em ${EXPIRY_DAYS} dias.` },
    es: { greeting: `¡Hola, ${clientName}!`, intro: `${assignee} de ${FIRM_NAME} ha configurado su portal seguro.`, cta: 'Acceder a Mi Portal', expiry: `Este enlace expira en ${EXPIRY_DAYS} días.` },
    zh: { greeting: `您好，${clientName}！`, intro: `${FIRM_NAME}的${assignee}已为您设置了安全客户门户。`, cta: '访问我的门户', expiry: `此链接将在${EXPIRY_DAYS}天后过期。` },
  }
  const t = copy[language] || copy.en
  const typeLabel = clientType === 'business' ? 'Business Client' : 'Individual Client'

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f0f4fa;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4fa;padding:40px 20px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
  <tr><td style="background:linear-gradient(135deg,#2D3278,#1a1f5e);border-radius:16px 16px 0 0;padding:28px;text-align:center;">
    <div style="font-size:28px;margin-bottom:8px;">📒</div>
    <h1 style="color:#fff;font-size:20px;margin:0;font-family:Georgia,serif;">${FIRM_NAME}</h1>
    <p style="color:rgba(255,255,255,0.5);font-size:12px;margin:4px 0 0;">portal.peaceontax.com</p>
  </td></tr>
  <tr><td style="background:#fff;padding:32px 36px;">
    <span style="background:#e8f0ff;color:#1a3560;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;">${typeLabel}</span>
    <h2 style="color:#2D3278;font-size:22px;margin:14px 0 8px;font-family:Georgia,serif;">${t.greeting}</h2>
    <p style="color:#3a4a5a;font-size:15px;line-height:1.7;margin:0 0 20px;">${t.intro}</p>
    ${customNote ? `<div style="background:#fff8e8;border-left:4px solid #F47B20;padding:12px 16px;border-radius:0 8px 8px 0;font-size:14px;color:#5a4a1a;font-style:italic;margin-bottom:20px;">"${customNote}"</div>` : ''}
    <div style="text-align:center;margin:24px 0;">
      <a href="${inviteUrl}" style="background:linear-gradient(135deg,#2D3278,#1a1f5e);color:#fff;padding:14px 36px;border-radius:12px;text-decoration:none;font-size:15px;font-weight:700;display:inline-block;">${t.cta} →</a>
    </div>
    <p style="color:#9aaab0;font-size:12px;text-align:center;">${t.expiry}</p>
  </td></tr>
  <tr><td style="background:#f0f4fa;border-radius:0 0 16px 16px;padding:16px;text-align:center;">
    <p style="color:#9aaab0;font-size:11px;margin:0;">🔒 Secure & encrypted · ${FIRM_NAME} · Massachusetts</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { clientName, clientEmail, clientPhone, clientType, language, assignee, customNote, channels, createdBy } = body

    if (!clientName || !clientEmail || !clientType || !channels?.length) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const db = supabaseAdmin()

    // 1. Save invitation to database
    const { data: invite, error } = await db.from('client_invitations').insert({
      client_name:  clientName,
      client_email: clientEmail,
      client_phone: clientPhone || null,
      client_type:  clientType,
      language:     language || 'en',
      assignee:     assignee || '',
      message_note: customNote || null,
      sent_via:     channels,
      status:       'pending',
      created_by:   createdBy || 'Staff',
      expires_at:   new Date(Date.now() + EXPIRY_DAYS * 86400000).toISOString(),
    }).select().single()

    if (error) throw error

    const inviteUrl = `${PORTAL_URL}/invite/${invite.token}`
    const results: Record<string, any> = {}

    // 2. Send email via Resend
    if (channels.includes('email') && clientEmail) {
      const resendKey = process.env.RESEND_API_KEY
      if (!resendKey) {
        results.email = { success: false, error: 'RESEND_API_KEY not configured' }
      } else {
        try {
          const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'
          const subjectMap: Record<string, string> = {
            en: `Your ${FIRM_NAME} Client Portal is Ready`,
            pt: `Seu Portal do Cliente ${FIRM_NAME} está Pronto`,
            es: `Su Portal de Cliente ${FIRM_NAME} está Listo`,
            zh: `您的${FIRM_NAME}客户门户已就绪`,
          }

          const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${resendKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from:     `${FIRM_NAME} <${fromEmail}>`,
              to:       [clientEmail],
              subject:  subjectMap[language || 'en'] || subjectMap.en,
              html:     buildEmailHTML({ clientName, clientType, assignee: assignee || 'Your accountant', inviteUrl, customNote, language: language || 'en' }),
              reply_to: 'info@peaceontax.com',
            }),
          })

          const emailData = await emailRes.json()
          if (!emailRes.ok) throw new Error(emailData.message || JSON.stringify(emailData))

          results.email = { success: true, id: emailData.id }
        } catch (err: any) {
          results.email = { success: false, error: err.message }
        }
      }
    }

    // 3. Mark as sent
    const anySent = Object.values(results).some((r: any) => r.success)
    await db.from('client_invitations')
      .update({ status: anySent ? 'sent' : 'pending', sent_at: new Date().toISOString() })
      .eq('id', invite.id)

    return NextResponse.json({
      success: true,
      inviteUrl,
      token: invite.token,
      results,
      emailSent: results.email?.success || false,
    })

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function GET() {
  const db = supabaseAdmin()
  const { data } = await db.from('client_invitations').select('*').order('created_at', { ascending: false })
  return NextResponse.json({ invitations: data || [] })
}
