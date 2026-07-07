// POST /api/clients/profile — equipe edita dados de contato/status do cliente
// Body: { clientId, fields: {name?, email?, phone?, language?, address_line1?, city?, state?, zip?,
//         filing_status?, business_name?, ein?, business_type?, industry?, active?}, reason?, managerPin? }
// owner/manager: direto (ativar/desativar sempre exige motivo)
// junior: PIN de manager + motivo

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel, validateManagerPin } from '@/lib/staff-perms'

const EDITABLE = new Set([
  'name','email','phone','language','address_line1','city','state','zip',
  'filing_status','business_name','ein','business_type','industry','active',
])

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito à equipe' }, { status: 403 })

  const { clientId, fields, reason, managerPin } = await req.json()
  if (!clientId || !fields || typeof fields !== 'object') {
    return NextResponse.json({ error: 'clientId e fields obrigatórios' }, { status: 400 })
  }

  // Filtra só campos permitidos
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (EDITABLE.has(k)) patch[k] = v
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nenhum campo editável informado' }, { status: 400 })
  }
  if (patch.email !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(patch.email))) {
    return NextResponse.json({ error: 'E-mail inválido' }, { status: 400 })
  }

  const level = await getStaffLevel(auth.userId)
  const isActiveChange = 'active' in patch
  let approvedBy: string | null = null

  if (level === 'junior') {
    if (!reason?.trim()) return NextResponse.json({ error: 'Motivo obrigatório (nível junior)' }, { status: 403 })
    approvedBy = await validateManagerPin(managerPin ?? '')
    if (!approvedBy) return NextResponse.json({ error: 'PIN de manager inválido' }, { status: 403 })
  } else if (isActiveChange && !reason?.trim()) {
    // Ativar/desativar sempre exige motivo, mesmo owner/manager
    return NextResponse.json({ error: 'Motivo obrigatório para ativar/desativar cliente' }, { status: 400 })
  }

  const db = serviceDb()
  const { data: current } = await db.from('clients').select('*').eq('id', clientId).single()
  if (!current) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })

  patch.updated_at = new Date().toISOString()
  const { error } = await db.from('clients').update(patch).eq('id', clientId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Auditoria
  const prev: Record<string, unknown> = {}
  const next: Record<string, unknown> = {}
  for (const k of Object.keys(patch)) {
    if (k === 'updated_at') continue
    prev[k] = current[k]; next[k] = patch[k]
  }
  const action = isActiveChange
    ? (patch.active ? 'activated' : 'deactivated')
    : (prev.email !== undefined && prev.email !== next.email ? 'email_changed' : 'profile_edited')

  await db.from('client_audit').insert({
    client_id: clientId, action, reason: reason ?? null,
    performed_by: auth.userId, approved_by: approvedBy,
    previous_state: prev, new_state: next,
  })

  return NextResponse.json({ ok: true })
}
