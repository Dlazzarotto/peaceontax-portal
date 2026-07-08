// POST /api/clients/temp-password { clientId }
// Gera senha provisória para o cliente (SÓ manager/owner).
// Marca must_change_password — o portal força a troca no primeiro acesso.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'

function generateTempPassword(): string {
  // Legível para ditar por telefone: Palavra + 4 dígitos + símbolo
  const words = ['Tax','Peace','Boston','Malden','Maple','River','Summit','Harbor']
  const w = words[Math.floor(Math.random() * words.length)]
  const n = Math.floor(1000 + Math.random() * 9000)
  return `${w}${n}!`
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return NextResponse.json({ error: 'Somente manager/owner geram senha provisória' }, { status: 403 })
  }

  const { clientId, password } = await req.json()
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  if (password !== undefined) {
    const p = String(password)
    if (p.length < 8) return NextResponse.json({ error: 'Senha provisória: mínimo 8 caracteres' }, { status: 400 })
    if (p.length > 72) return NextResponse.json({ error: 'Senha muito longa' }, { status: 400 })
  }
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const { data: client } = await db.from('clients')
    .select('id, name, email, user_id').eq('id', clientId).single()
  if (!client) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })
  if (!client.user_id) {
    return NextResponse.json({ error: 'Cliente ainda não criou o acesso — use "Reenviar acesso" para o convite inicial' }, { status: 409 })
  }

  const tempPassword = password ? String(password) : generateTempPassword()

  // Service role: define a senha + flag de troca obrigatória
  const { error } = await db.auth.admin.updateUserById(client.user_id, {
    password: tempPassword,
    user_metadata: { must_change_password: true },
  })
  if (error) return NextResponse.json({ error: `Auth: ${error.message}` }, { status: 500 })

  await db.from('client_audit').insert({
    client_id: clientId,
    action: 'temp_password_issued',
    performed_by: auth.userId,
    details: { note: 'Senha provisória gerada — troca obrigatória no primeiro acesso' },
  }).then(() => null, () => null)

  return NextResponse.json({ ok: true, tempPassword, loginEmail: client.email })
}
