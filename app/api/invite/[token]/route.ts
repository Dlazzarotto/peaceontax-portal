import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'

export async function GET(_: NextRequest, { params }: { params: { token: string } }) {
  try {
    const db = supabaseAdmin()
    const { data: invite, error } = await db.from('client_invitations').select('*').eq('token', params.token).single()
    if (error || !invite) return NextResponse.json({ error: 'Invitation not found' }, { status: 404 })
    if (new Date(invite.expires_at) < new Date()) {
      await db.from('client_invitations').update({ status: 'expired' }).eq('id', invite.id)
      return NextResponse.json({ error: 'This invitation has expired. Please contact your accountant.' }, { status: 410 })
    }
    if (invite.status === 'sent') {
      await db.from('client_invitations').update({ status: 'opened', opened_at: new Date().toISOString() }).eq('id', invite.id)
    }
    return NextResponse.json({ token: invite.token, clientEmail: invite.client_email, expiresAt: invite.expires_at, status: invite.status })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  try {
    const body = await req.json()
    const { password, name, phone, type, address, city, state, zip, businessName, ein, entityType, industry, filingStatus } = body
    const db = supabaseAdmin()
    const { data: invite } = await db.from('client_invitations').select('*').eq('token', params.token).single()
    if (!invite) return NextResponse.json({ error: 'Invitation not found' }, { status: 404 })
    if (invite.status === 'registered') return NextResponse.json({ error: 'This invitation has already been used. Please log in at the portal instead.' }, { status: 409 })
    if (new Date(invite.expires_at) < new Date()) return NextResponse.json({ error: 'Invitation expired' }, { status: 410 })

    const { data: auth, error: authErr } = await db.auth.admin.createUser({
      email: invite.client_email, password, email_confirm: true,
      user_metadata: { role: 'client', full_name: name, client_type: type || 'individual' },
    })
    if (authErr) {
      if (authErr.message.includes('already been registered')) {
        return NextResponse.json({ error: 'An account with this email already exists. Please log in at the portal.' }, { status: 409 })
      }
      throw authErr
    }

    await db.from('clients').insert({
      user_id: auth.user.id, name: name || invite.client_email, email: invite.client_email,
      phone: phone || null, type: type || 'individual', language: invite.language || 'en',
      assignee: invite.assignee || null, stage: 'Gathering Docs',
      address_line1: address || null, city: city || null, state: state || 'MA', zip: zip || null,
      business_name: businessName || null, ein: ein || null, business_type: entityType || null,
      industry: industry || null, filing_status: filingStatus || null, active: true,
    })

    await db.from('client_invitations').update({ status: 'registered', registered_at: new Date().toISOString(), client_name: name }).eq('id', invite.id)

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
