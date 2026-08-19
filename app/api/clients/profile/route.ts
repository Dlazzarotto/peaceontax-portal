// POST /api/clients/profile — equipe edita dados de contato/status do cliente
// Body: { clientId, fields: {name?, email?, phone?, sms_phone?, language?, address_line1?, city?,
//         state?, zip?, filing_status?, business_name?, ein?, business_type?, industry?,
//         business_kind?, active?}, smsConsent?, reason?, managerPin? }
// owner/manager: direto (ativar/desativar sempre exige motivo)
// junior: PIN de manager + motivo
//
// CONSENTIMENTO SMS: não entra pela lista de campos comuns. Só muda por
// smsConsent explícito, com origem registrada — porque autorização marcada
// pela firma sem trilha não sustenta nada numa disputa.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel, validateManagerPin } from '@/lib/staff-perms'
import { registrarConsentimento, normalizarTelefone } from '@/lib/sms'

const EDITABLE = new Set([
  'name','email','phone','sms_phone','language','address_line1','city','state','zip',
  'filing_status','business_name','ein','business_type','industry','business_kind','active',
])

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito à equipe' }, { status: 403 })

  const { clientId, fields, reason, managerPin, smsConsent } = await req.json()
  if (!clientId || !fields || typeof fields !== 'object') {
    return NextResponse.json({ error: 'clientId e fields obrigatórios' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (EDITABLE.has(k)) patch[k] = v
  }
  if (Object.keys(patch).length === 0 && smsConsent === undefined) {
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
    return NextResponse.json({ error: 'Motivo obrigatório para ativar/desativar cliente' }, { status: 400 })
  }

  const db = serviceDb()
  const { data: current } = await db.from('clients').select('*').eq('id', clientId).single()
  if (!current) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })

  // ── Consentimento de SMS ──
  // Marcar exige que o cliente tenha autorizado de verdade (verbalmente ou
  // por escrito); a equipe registra a autorização, e fica gravado quem registrou.
  let avisoSms: string | undefined
  if (smsConsent !== undefined && !!smsConsent !== !!current.sms_consent) {
    const fone = normalizarTelefone(
      (patch.sms_phone as string) || current.sms_phone || (patch.phone as string) || current.phone)

    if (smsConsent && !fone) {
      return NextResponse.json({
        error: 'Informe um celular válido antes de registrar a autorização de SMS.',
      }, { status: 400 })
    }
    if (smsConsent && !reason?.trim()) {
      return NextResponse.json({
        error: 'Descreva como o cliente autorizou (ex.: "autorizou por telefone em 19/08"). Isso fica na auditoria.',
      }, { status: 400 })
    }

    const r = await registrarConsentimento({
      clientId,
      phone: fone || current.phone || '',
      action: smsConsent ? 'opt_in' : 'opt_out',
      source: 'staff',
      consentText: smsConsent
        ? 'Autorização registrada pela equipe: ' + String(reason).trim()
        : undefined,
      ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined,
      userAgent: req.headers.get('user-agent') || undefined,
      performedBy: auth.userId,
    })
    if (!r.ok) return NextResponse.json({ error: r.motivo }, { status: 400 })

    avisoSms = smsConsent
      ? 'Autorização de SMS registrada com data, hora e responsável.'
      : 'Cliente marcado como não autorizado a receber SMS.'

    // registrarConsentimento já gravou os campos em clients
    delete patch.sms_phone
  }

  if (Object.keys(patch).length > 0) {
    patch.updated_at = new Date().toISOString()
    const { error } = await db.from('clients').update(patch).eq('id', clientId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Auditoria
  const prev: Record<string, unknown> = {}
  const next: Record<string, unknown> = {}
  for (const k of Object.keys(patch)) {
    if (k === 'updated_at') continue
    prev[k] = current[k]; next[k] = patch[k]
  }
  if (smsConsent !== undefined) {
    prev.sms_consent = current.sms_consent
    next.sms_consent = !!smsConsent
  }

  const action = isActiveChange
    ? (patch.active ? 'activated' : 'deactivated')
    : (prev.email !== undefined && prev.email !== next.email ? 'email_changed' : 'profile_edited')

  await db.from('client_audit').insert({
    client_id: clientId, action, reason: reason ?? null,
    performed_by: auth.userId, approved_by: approvedBy,
    previous_state: prev, new_state: next,
  })

  return NextResponse.json({ ok: true, aviso: avisoSms })
}
