import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'

const PORTAL_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.peaceontax.com'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { clientName, clientEmail, clientPhone, clientType, language, assignee, customNote, channels, createdBy } = body
    if (!clientName || !clientEmail || !clientType || !channels?.length) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    const db = supabaseAdmin()
    const { data: invite, error } = await db.from('client_invitations').insert({
      client_name: clientName, client_email: clientEmail, client_phone: clientPhone || null,
      client_type: clientType, language, assignee, message_note: customNote || null,
      sent_via: channels, status: 'pending', created_by: createdBy,
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    }).select().single()
    if (error) throw error
    const inviteUrl = `${PORTAL_URL}/invite/${invite.token}`
    await db.from('client_invitations').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', invite.id)
    return NextResponse.json({ success: true, inviteUrl, token: invite.token })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function GET() {
  const db = supabaseAdmin()
  const { data } = await db.from('client_invitations').select('*').order('created_at', { ascending: false })
  return NextResponse.json({ invitations: data || [] })
}
