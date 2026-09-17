// POST /api/clients/profile — equipe edita dados de contato/status do cliente
// Body: { clientId, fields: {name?, email?, phone?, sms_phone?, language?, address_line1?, city?,
//         state?, zip?, filing_status?, business_name?, ein?, business_type?, industry?,
//         business_kind?, active?}, smsConsent?, reason?, managerPin? }
// Quem edita precisa da autorização `editarCliente` (gerente e sócio a têm
// por nível; o sócio concede a mais alguém em Settings → Users), e confirma
// com a PRÓPRIA senha + motivo. Antes o junior editava com o PIN de um
// gerente; agora não edita sem autorização, e quem edita assina.
//
// Por que senha e não PIN: a regra 3 da especificação diz senha, e o
// financeiro já fazia assim. Dois mecanismos para a mesma coisa é como se
// perde a conta de quem pode o quê.
//
// CONSENTIMENTO SMS: não entra pela lista de campos comuns. Só muda por
// smsConsent explícito, com origem registrada — porque autorização marcada
// pela firma sem trilha não sustenta nada numa disputa.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { permissoesFinanceiro } from '@/lib/billing-perms'
import { registrarConsentimento, normalizarTelefone } from '@/lib/sms'

const EDITABLE = new Set([
  'name','email','phone','sms_phone','language','address_line1','city','state','zip',
  'filing_status','business_name','ein','business_type','industry','business_kind','active',
])

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito à equipe' }, { status: 403 })

  const { clientId, fields, reason, password, smsConsent, consentReason } = await req.json()
  // O consentimento de SMS tem justificativa própria: é ela que vai para o
  // log permanente. O motivo da edição explica a alteração do cadastro; os
  // dois não são a mesma frase e o log de consentimento não aceita a errada.
  const motivoConsentimento = String(consentReason || reason || '').trim()
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
  const perms = await permissoesFinanceiro(auth.userId)
  const isActiveChange = 'active' in patch
  const approvedBy: string | null = null

  if (!perms.editarCliente) {
    return NextResponse.json({
      error: 'Editar o cadastro do cliente exige autorização. Fale com o sócio — ' +
             'ele libera em Settings → Users, sem mudar o seu nível.',
    }, { status: 403 })
  }
  if (!reason?.trim() || reason.trim().length < 5) {
    return NextResponse.json({
      error: 'Descreva o motivo da alteração (mínimo 5 caracteres). Ele fica na ficha.',
    }, { status: 400 })
  }
  if (!password) {
    return NextResponse.json({ error: 'Confirme com a sua senha.' }, { status: 400 })
  }
  {
    // Senha da PRÓPRIA pessoa: prova que é ela no teclado, não uma tela
    // destravada. Quem pode editar já foi decidido acima.
    const { data: quem } = await serviceDb().auth.admin.getUserById(auth.userId)
    const email = quem?.user?.email
    if (!email) return NextResponse.json({ error: 'Não foi possível identificar seu login.' }, { status: 400 })
    const sbAuth = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
    const { error: pwErr } = await sbAuth.auth.signInWithPassword({
      email, password: String(password).trim(),
    })
    if (pwErr) {
      const m = pwErr.message || ''
      if (/rate|too many|429/i.test(m)) {
        return NextResponse.json({ error: 'Muitas tentativas. Aguarde 1 minuto.' }, { status: 429 })
      }
      return NextResponse.json({ error: `Senha não confere para ${email}.` }, { status: 401 })
    }
  }
  if (isActiveChange && !reason?.trim()) {
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
    if (smsConsent && !motivoConsentimento) {
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
        ? 'Autorização registrada pela equipe: ' + motivoConsentimento
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
