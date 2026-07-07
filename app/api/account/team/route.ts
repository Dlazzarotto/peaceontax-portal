// GET  /api/account/team — lista equipe com níveis (owner e manager veem)
// POST /api/account/team — owner altera nível de um membro ou reseta PIN
//   Body: { targetUserId, level?: 'owner'|'manager'|'junior', resetPin?: boolean }

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'

export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const myLevel = await getStaffLevel(auth.userId)
  if (myLevel === 'junior') {
    return NextResponse.json({ error: 'Sem permissão' }, { status: 403 })
  }

  const db = serviceDb()

  // Todos os usuários com role firm no Auth
  const { data: usersData } = await db.auth.admin.listUsers({ perPage: 100 })
  const firmUsers = (usersData?.users || []).filter(
    (u: any) => u.user_metadata?.role === 'firm'
  )

  const { data: roles } = await db.from('staff_roles').select('user_id, level, approval_pin_hash')

  const team = firmUsers.map((u: any) => {
    const role = roles?.find(r => r.user_id === u.id)
    return {
      userId: u.id,
      email: u.email,
      name: u.user_metadata?.full_name || u.email?.split('@')[0],
      level: role?.level || 'junior',
      hasPin: !!role?.approval_pin_hash,
      lastSignIn: u.last_sign_in_at,
    }
  })

  return NextResponse.json({ team, myLevel })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const myLevel = await getStaffLevel(auth.userId)
  if (myLevel !== 'owner') {
    return NextResponse.json({ error: 'Somente o owner gerencia a equipe' }, { status: 403 })
  }

  const { targetUserId, level, resetPin } = await req.json()
  if (!targetUserId) return NextResponse.json({ error: 'targetUserId obrigatório' }, { status: 400 })

  // Owner não pode rebaixar a si mesmo (evita ficar sem owner)
  if (targetUserId === auth.userId && level && level !== 'owner') {
    return NextResponse.json({ error: 'Você não pode rebaixar seu próprio nível de owner' }, { status: 400 })
  }

  const db = serviceDb()
  const payload: Record<string, unknown> = {
    user_id: targetUserId,
    updated_at: new Date().toISOString(),
  }
  if (level && ['owner','manager','junior'].includes(level)) {
    payload.level = level
    if (level === 'junior') payload.approval_pin_hash = null
  }
  if (resetPin) payload.approval_pin_hash = null

  const { error } = await db
    .from('staff_roles')
    .upsert(payload, { onConflict: 'user_id' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
