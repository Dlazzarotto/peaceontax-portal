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
  if (!client.email || !client.email.includes('@')) {
    return NextResponse.json({ error: 'Cliente sem e-mail válido — corrija o e-mail primeiro' }, { status: 400 })
  }

  const tempPassword = password ? String(password) : generateTempPassword()

  if (client.user_id) {
    // Já tem login: redefine a senha + flag de troca obrigatória
    const { error } = await db.auth.admin.updateUserById(client.user_id, {
      password: tempPassword,
      user_metadata: { must_change_password: true },
    })
    if (error) return NextResponse.json({ error: `Auth: ${error.message}` }, { status: 500 })
  } else {
    // SEM login ainda: cria o acesso agora, já confirmado, com a senha provisória
    const { data: created, error } = await db.auth.admin.createUser({
      email: client.email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { role: 'client', name: client.name, must_change_password: true },
    })
    if (error) {
      // E-mail já usado por outro login?
      if (/already|exists|registered/i.test(error.message)) {
        return NextResponse.json({ error: `Já existe um login com ${client.email} não vinculado a este cliente — verifique em Authentication → Users` }, { status: 409 })
      }
      return NextResponse.json({ error: `Auth: ${error.message}` }, { status: 500 })
    }
    // Vincula o login ao cliente
    await db.from('clients').update({ user_id: created.user.id }).eq('id', clientId)
  }

  await db.from('client_audit').insert({
    client_id: clientId,
    action: 'temp_password_issued',
    performed_by: auth.userId,
    details: { note: 'Senha provisória gerada — troca obrigatória no primeiro acesso' },
  }).then(() => null, () => null)

  return NextResponse.json({ ok: true, tempPassword, loginEmail: client.email })
}
