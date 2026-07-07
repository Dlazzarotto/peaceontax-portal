// GET  /api/quotes/perms — retorna o nível do staff logado (para o front adaptar a UI)
// POST /api/quotes/perms — owner define nível/PIN de um membro da equipe
//   Body: { targetUserId, level: 'owner'|'manager'|'junior', pin?: '4-8 dígitos' }

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel, hashPin } from '@/lib/staff-perms'

export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  return NextResponse.json({ level })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const myLevel = await getStaffLevel(auth.userId)
  if (myLevel !== 'owner') {
    return NextResponse.json({ error: 'Somente o owner define níveis e PINs' }, { status: 403 })
  }

  const { targetUserId, level, pin } = await req.json()
  if (!targetUserId || !['owner','manager','junior'].includes(level)) {
    return NextResponse.json({ error: 'targetUserId e level válido obrigatórios' }, { status: 400 })
  }
  if (pin && !/^\d{4,8}$/.test(pin)) {
    return NextResponse.json({ error: 'PIN deve ter 4 a 8 dígitos' }, { status: 400 })
  }

  const payload: Record<string, unknown> = {
    user_id: targetUserId,
    level,
    updated_at: new Date().toISOString(),
  }
  if (pin) payload.approval_pin_hash = hashPin(pin)
  // Junior não tem PIN de aprovação
  if (level === 'junior') payload.approval_pin_hash = null

  const { error } = await serviceDb()
    .from('staff_roles')
    .upsert(payload, { onConflict: 'user_id' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
