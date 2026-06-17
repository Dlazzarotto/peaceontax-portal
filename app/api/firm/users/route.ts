import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'

// GET — list all firm users
export async function GET() {
  try {
    const db = supabaseAdmin()
    const { data: { users }, error } = await db.auth.admin.listUsers()
    if (error) throw error

    // Filter only firm users (role = firm or staff)
    const firmUsers = users
      .filter(u => ['firm', 'staff', 'admin', 'manager'].includes(u.user_metadata?.role))
      .map(u => ({
        id:         u.id,
        email:      u.email,
        name:       u.user_metadata?.full_name || u.email?.split('@')[0] || '—',
        role:       u.user_metadata?.role || 'staff',
        title:      u.user_metadata?.title || '',
        phone:      u.user_metadata?.phone || '',
        active:     !u.banned_until,
        created_at: u.created_at,
        last_sign_in: u.last_sign_in_at,
      }))

    return NextResponse.json({ users: firmUsers })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// POST — create new firm user
export async function POST(req: NextRequest) {
  try {
    const { email, password, name, role, title, phone } = await req.json()
    if (!email || !password || !name) {
      return NextResponse.json({ error: 'Email, password and name are required' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const { data: auth, error: authErr } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        role:      role || 'staff',
        full_name: name,
        title:     title || '',
        phone:     phone || '',
      },
    })

    if (authErr) throw authErr
    return NextResponse.json({ user: auth.user })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
