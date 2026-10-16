// GET  /api/quotes/perms — retorna o nível do staff logado (para o front adaptar a UI)
//
// Tinha um POST em que o sócio definia o nível e o PIN de qualquer pessoa —
// um SEGUNDO caminho para o nível, sem senha, sem motivo, sem trilha e sem
// a trava de "ninguém se rebaixa" que /api/account/team tinha. Saiu com a
// unificação da equipe (lib/equipe.ts): o nível muda em Equipe, pelo sócio,
// e o PIN cada um define o próprio em Minha Conta.

import { NextResponse } from 'next/server'
import { getAuth } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'

export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  return NextResponse.json({ level })
}
