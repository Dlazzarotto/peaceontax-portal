import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'

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
    const body = await req.json()
    const { clientName, clientEmail, clientType, language, assignee, customNote, channels, createdBy } = body
    if (!clientEmail) return NextResponse.json({ error: 'Email is required' }, { status: 400 })

    const db = supabaseAdmin()
    const { data: invite, error } = await db.from('client_invitations').insert({
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

export async function GET() {
  const db = supabaseAdmin()
  const { data } = await db.from('client_invitations').select('*').order('created_at', { ascending: false })
  return NextResponse.json({ invitations: data || [] })
}
