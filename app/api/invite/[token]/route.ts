import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'

export async function GET(_: NextRequest, { params }: { params: { token: string } }) {
  const db = supabaseAdmin()
  const { data, error } = await db.from('client_invitations').select('*').eq('token', params.token).single()
  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (new Date(data.expires_at) < new Date()) return NextResponse.json({ error: 'Expired' }, { status: 410 })
  if (data.status === 'sent') await db.from('client_invitations').update({ status: 'opened', opened_at: new Date().toISOString() }).eq('id', data.id)
  return NextResponse.json({ token: data.token, clientName: data.client_name, clientEmail: data.client_email, clientType: data.client_type, language: data.language, assignee: data.assignee })
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const { password } = await req.json()
  const db = supabaseAdmin()
  const { data: invite } = await db.from('client_invitations').select('*').eq('token', params.token).single()
  if (!invite) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (invite.status === 'registered') return NextResponse.json({ error: 'Already registered' }, { status: 409 })
  const { data: auth, error: authErr } = await db.auth.admin.createUser({
    email: invite.client_email, password, email_confirm: true,
    user_metadata: { role: 'client', full_name: invite.client_name, client_type: invite.client_type, language: invite.language },
  })
  if (authErr) return NextResponse.json({ error: authErr.message }, { status: 400 })
  await db.from('clients').insert({ user_id: auth.user.id, name: invite.client_name, email: invite.client_email, type: invite.client_type, language: invite.language, assignee: invite.assignee, stage: 'Onboarding' })
  await db.from('client_invitations').update({ status: 'registered', registered_at: new Date().toISOString() }).eq('id', invite.id)
  return NextResponse.json({ success: true })
}
