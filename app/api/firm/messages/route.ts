// /api/firm/messages — a equipe responde o cliente
//
// CORREÇÃO DE SEGURANÇA: sem conferência de quem chamava. Qualquer pessoa
// logada — inclusive um cliente — gravava mensagem com sender 'firm' na
// conversa de qualquer cliente. Escrever em nome da firma é da firma.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  try {
    const { clientId, text } = await req.json()
    if (!clientId || !text?.trim())
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })

    const { data, error } = await serviceDb().from('messages')
      .insert({ client_id: clientId, sender: 'firm', text: text.trim() })
      .select().single()
    if (error) throw error
    return NextResponse.json({ message: data })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
