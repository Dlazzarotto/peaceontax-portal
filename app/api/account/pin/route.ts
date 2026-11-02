// /api/account/pin — o PRÓPRIO PIN de aprovação (Minha Conta)
//
//  GET  → { nivel, temPin }  o nível de quem está logado e se já tem PIN
//  POST { currentPassword, newPin } → owner/manager define o próprio PIN.
//                                      Exige a senha atual.
//
// O PIN mora na linha da pessoa em team_members (sql/equipe-unica-v1.sql),
// junto do nível. Zerar o PIN de outra pessoa é do sócio, em Equipe.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel, hashPin } from '@/lib/staff-perms'
import { membroDoLogin, AVISO_MIGRACAO } from '@/lib/equipe-servidor'

export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito à equipe' }, { status: 403 })
  const nivel = await getStaffLevel(auth.userId)
  const { membro, erro } = await membroDoLogin(auth.userId)
  return NextResponse.json({ nivel, temPin: !!membro?.approval_pin_hash, aviso: erro })
}

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

  const { membro, erro } = await membroDoLogin(auth.userId, db)
  if (erro) return NextResponse.json({ error: erro }, { status: erro === AVISO_MIGRACAO ? 409 : 500 })
  // Não cria a linha aqui: ela carrega o NÍVEL, e quem dá nível é o sócio.
  if (!membro) {
    return NextResponse.json({
      error: 'Seu cadastro na equipe não foi encontrado — peça ao sócio para acertar em Equipe.',
    }, { status: 409 })
  }

  const { error } = await db.from('team_members')
    .update({ approval_pin_hash: hashPin(newPin), updated_at: new Date().toISOString() })
    .eq('id', membro.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
