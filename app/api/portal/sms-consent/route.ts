// GET  /api/portal/sms-consent — situação do consentimento de SMS do cliente logado
// POST /api/portal/sms-consent — o PRÓPRIO cliente autoriza ou cancela
//   Body: { action: 'opt_in' | 'opt_out', phone?: string }
//
// Só o cliente (dono do cadastro). A equipe registra consentimento pela ficha
// (/api/clients/profile), com motivo e responsável. Aqui a prova é mais forte:
// o cliente marca, e ficam data, hora, IP, navegador e o texto exato que leu.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { normalizarTelefone, registrarConsentimento } from '@/lib/sms'
import { textoConsentimentoSms, textoConsentimentoParaRegistro, SMS_CONSENT_VERSION } from '@/lib/sms-consent-text'

async function clienteLogado(userId: string) {
  const { data } = await serviceDb()
    .from('clients')
    .select('id, name, language, phone, sms_phone, sms_consent, sms_consent_at, sms_consent_source, sms_opted_out_at')
    .eq('user_id', userId)
    .maybeSingle()
  return data
}

function situacao(c: any) {
  return {
    phone: c.sms_phone || c.phone || '',
    consent: !!c.sms_consent,
    consentAt: c.sms_consent_at || null,
    consentSource: c.sms_consent_source || null,
    optedOutAt: c.sms_opted_out_at || null,
    text: textoConsentimentoSms(c.language),
    version: SMS_CONSENT_VERSION,
  }
}

export async function GET() {
  const auth = await getAuth()
  if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
  if (auth.isStaff) return NextResponse.json({ error: 'Rota do cliente' }, { status: 403 })

  const c = await clienteLogado(auth.userId)
  if (!c) return NextResponse.json({ error: 'Cadastro não encontrado' }, { status: 404 })
  return NextResponse.json({ ok: true, ...situacao(c) })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
  if (auth.isStaff) return NextResponse.json({ error: 'Rota do cliente' }, { status: 403 })

  const c = await clienteLogado(auth.userId)
  if (!c) return NextResponse.json({ error: 'Cadastro não encontrado' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const action = body?.action
  if (action !== 'opt_in' && action !== 'opt_out') {
    return NextResponse.json({ error: 'action deve ser opt_in ou opt_out' }, { status: 400 })
  }

  // Celular: o informado agora, senão o já cadastrado
  const telefone = normalizarTelefone(body?.phone || c.sms_phone || c.phone)
  if (action === 'opt_in' && !telefone) {
    return NextResponse.json({ error: 'Informe um celular válido com DDD (ex.: (857) 555-1234).' }, { status: 400 })
  }

  const r = await registrarConsentimento({
    clientId: c.id,
    phone: telefone || c.phone || '',
    action,
    source: 'portal',
    // O texto gravado é o canônico do idioma do cadastro, com a versão — é o que a tela mostra
    consentText: action === 'opt_in' ? textoConsentimentoParaRegistro(c.language) : `Cancelado pelo cliente no portal [${SMS_CONSENT_VERSION}]`,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || undefined,
    userAgent: req.headers.get('user-agent') || undefined,
    performedBy: auth.userId,
  })
  if (!r.ok) return NextResponse.json({ error: r.motivo }, { status: 400 })

  const atualizado = await clienteLogado(auth.userId)
  return NextResponse.json({ ok: true, ...situacao(atualizado || c) })
}
