import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'
import { randomBytes } from 'crypto'

const PORTAL_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://peaceontax-portal.vercel.app'
const FIRM_NAME  = 'Peace on Tax'

function buildInviteEmail(name: string, email: string, setupUrl: string, role: string) {
  const roleLabels: Record<string,string> = { firm:'Owner', admin:'Admin', manager:'Manager', staff:'Staff' }
  const roleLabel = roleLabels[role] || 'Staff'
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f0f4fa;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4fa;padding:40px 20px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
  <tr><td style="background:linear-gradient(135deg,#2D3278,#1a1f5e);border-radius:16px 16px 0 0;padding:28px;text-align:center;">
    <div style="font-size:28px;margin-bottom:8px;">📒</div>
    <h1 style="color:#fff;font-size:20px;margin:0;font-family:Georgia,serif;">${FIRM_NAME}</h1>
    <p style="color:rgba(255,255,255,0.5);font-size:12px;margin:4px 0 0;">Team Portal Access</p>
  </td></tr>
  <tr><td style="background:#fff;padding:32px 36px;">
    <h2 style="color:#2D3278;font-size:20px;margin:0 0 12px;font-family:Georgia,serif;">Welcome to the team, ${name}!</h2>
    <p style="color:#3a4a5a;font-size:15px;line-height:1.7;margin:0 0 16px;">
      You have been added to the <strong>${FIRM_NAME}</strong> portal as <strong>${roleLabel}</strong>.
    </p>
    <p style="color:#3a4a5a;font-size:14px;line-height:1.6;margin:0 0 24px;">
      Click the button below to create your password and access the portal. This link expires in <strong>7 days</strong>.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${setupUrl}" style="background:linear-gradient(135deg,#2D3278,#1a1f5e);color:#fff;padding:14px 36px;border-radius:12px;text-decoration:none;font-size:15px;font-weight:700;display:inline-block;">Create My Password →</a>
    </div>
    <div style="background:#f8faff;border-radius:10px;padding:14px 16px;font-size:13px;color:#6a7a9a;">
      <strong style="color:#0f2340;">Your login email:</strong> ${email}
    </div>
  </td></tr>
  <tr><td style="background:#f0f4fa;border-radius:0 0 16px 16px;padding:16px;text-align:center;">
    <p style="color:#9aaab0;font-size:11px;margin:0;">🔒 Secure & encrypted · ${FIRM_NAME} · Massachusetts</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`
}

export async function GET() {
  try {
    const db = supabaseAdmin()
    const { data: { users }, error } = await db.auth.admin.listUsers()
    if (error) throw error
    const firmUsers = users
      .filter(u => ['firm', 'staff', 'admin', 'manager'].includes(u.user_metadata?.role))
      .map(u => ({
        id:           u.id,
        email:        u.email,
        name:         u.user_metadata?.full_name || u.email?.split('@')[0] || '—',
        role:         u.user_metadata?.role || 'staff',
        title:        u.user_metadata?.title || '',
        phone:        u.user_metadata?.phone || '',
        active:       !u.banned_until,
        created_at:   u.created_at,
        last_sign_in: u.last_sign_in_at,
      }))
    return NextResponse.json({ users: firmUsers })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { email, name, role, title, phone } = await req.json()
    if (!email || !name) return NextResponse.json({ error: 'Email and name are required' }, { status: 400 })

    const db    = supabaseAdmin()
    const token = randomBytes(32).toString('hex')
    const setupUrl = `${PORTAL_URL}/staff-setup/${token}`

    // Save invitation to staff_invitations table
    const { error: invErr } = await db.from('staff_invitations').insert({
      email, name, role: role||'staff', title: title||'', phone: phone||'',
      token,
      status:     'pending',
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    })
    if (invErr) throw invErr

    // Send invite email
    const resendKey = process.env.RESEND_API_KEY
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@peaceontax.com'
    let emailSent   = false

    if (resendKey) {
      try {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from:     `${FIRM_NAME} <${fromEmail}>`,
            to:       [email],
            subject:  `You have been invited to ${FIRM_NAME} Portal`,
            html:     buildInviteEmail(name, email, setupUrl, role||'staff'),
            reply_to: 'info@peaceontax.com',
          }),
        })
        if (emailRes.ok) emailSent = true
        else { const d = await emailRes.json(); console.error('Resend:', d) }
      } catch (e) { console.error('Email failed:', e) }
    }

    return NextResponse.json({ success: true, setupUrl, emailSent })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
