// Convite: cancelar
//
//   DELETE /api/invitations/:id   cancela o convite (nao apaga a linha)
//                                 so equipe; exige motivo; convite ja aceito recusa
//
// Cancelar preserva o rastro (secao 2 da especificacao): a linha fica, com
// quem cancelou, quando e por que. Nao existe apagar de verdade aqui -- o
// convite e a prova de como o cliente entrou na firma.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await getAuth()
    if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
    if (!auth.isStaff) return NextResponse.json({ error: 'Só a equipe cancela convite' }, { status: 403 })

    const motivo = (new URL(req.url).searchParams.get('motivo') || '').trim()
    if (motivo.length < 3) return NextResponse.json({ error: 'Diga o motivo do cancelamento' }, { status: 400 })

    const db = serviceDb()
    const { data: convite } = await db
      .from('client_invitations')
      .select('id, client_email, status')
      .eq('id', params.id)
      .maybeSingle()

    if (!convite) return NextResponse.json({ error: 'Convite não encontrado' }, { status: 404 })
    if (convite.status === 'registered')
      return NextResponse.json({ error: 'Convite já aceito não pode ser cancelado — o cliente já entrou por ele' }, { status: 409 })
    if (convite.status === 'cancelled')
      return NextResponse.json({ error: 'Convite já está cancelado' }, { status: 409 })

    const { error } = await db
      .from('client_invitations')
      .update({
        status:        'cancelled',
        cancelled_at:  new Date().toISOString(),
        cancelled_by:  auth.userId,
        cancel_reason: motivo,
      })
      .eq('id', params.id)
      .eq('status', convite.status)   // não atropela quem aceitou nesse meio-tempo

    if (error) throw error
    return NextResponse.json({ success: true, email: convite.client_email })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
