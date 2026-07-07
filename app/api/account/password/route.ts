// POST /api/account/password
// Body: { currentPassword, newPassword }
// Verifica a senha atual re-autenticando antes de trocar.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth, serviceDb } from '@/lib/api-auth'

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  const { currentPassword, newPassword } = await req.json()
  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: 'Senha atual e nova senha obrigatórias' }, { status: 400 })
  }
  if (newPassword.length < 8) {
    return NextResponse.json({ error: 'Nova senha deve ter no mínimo 8 caracteres' }, { status: 400 })
  }

  const db = serviceDb()

  // Busca o e-mail do usuário logado
  const { data: userData, error: userErr } = await db.auth.admin.getUserById(auth.userId)
  if (userErr || !userData?.user?.email) {
    return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 })
  }

  // Verifica a senha atual tentando autenticar
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

  // Troca a senha via admin
  const { error: updateErr } = await db.auth.admin.updateUserById(auth.userId, {
    password: newPassword,
  })
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
