// POST /api/account/pin
// Body: { currentPassword, newPin }
// Owner/manager define o PRÓPRIO PIN de aprovação. Exige senha atual.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel, hashPin } from '@/lib/staff-perms'

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito à equipe' }, { status: 403 })

  const level = await getStaffLevel(auth.userId)
  if (level === 'junior') {
    return NextResponse.json({ error: 'Somente owner/manager possuem PIN de aprovação' }, { status: 403 })
  }

  const { currentPassword, newPin } = await req.json()
  if (!currentPassword || !newPin) {
    return NextResponse.json({ error: 'Senha atual e novo PIN obrigatórios' }, { status: 400 })
  }
  if (!/^\d{4,8}$/.test(newPin)) {
    return NextResponse.json({ error: 'PIN deve ter 4 a 8 dígitos numéricos' }, { status: 400 })
  }

  const db = serviceDb()
  const { data: userData } = await db.auth.admin.getUserById(auth.userId)
  if (!userData?.user?.email) {
    return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 })
  }

  // Verifica senha atual
  const verifier = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
  const { error: signInErr } = await verifier.auth.signInWithPassword({
    email: userData.user.email,
    password: currentPassword,
  })
  if (signInErr) {
    return NextResponse.json({ error: 'Senha atual incorreta' }, { status: 403 })
  }

  const { error } = await db
    .from('staff_roles')
    .upsert({
      user_id: auth.userId,
      level,
      approval_pin_hash: hashPin(newPin),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
