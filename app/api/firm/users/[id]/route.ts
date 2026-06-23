import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { name, role, title, phone, password, reactivate } = await req.json()
    const db = supabaseAdmin()

    const updates: any = {}

    // Reactivate — remove ban
    if (reactivate) {
      updates.ban_duration = 'none'
    } else {
      updates.user_metadata = { role, full_name: name, title: title||'', phone: phone||'' }
      if (password && password.length >= 8) updates.password = password
    }

    const { data, error } = await db.auth.admin.updateUserById(params.id, updates)
    if (error) throw error
    return NextResponse.json({ user: data.user })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const db = supabaseAdmin()
    const { error } = await db.auth.admin.updateUserById(params.id, { ban_duration: '87600h' })
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
