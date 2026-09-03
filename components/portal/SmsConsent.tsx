'use client'
// SmsConsent — o cliente autoriza (ou cancela) mensagens de texto no próprio portal.
// O texto exibido vem do servidor (lib/sms-consent-text), o mesmo que fica gravado
// em sms_consent_log com data, hora, IP e navegador.

import { useEffect, useState } from 'react'

const T: Record<string, any> = {
  en: {
    title: 'Text messages (SMS)', phone: 'Mobile number', agree: 'I have read and agree to the text above',
    authorize: 'Authorize text messages', cancel: 'Stop text messages',
    on: (d: string) => `Authorized on ${d}. Reply STOP to any message to cancel.`,
    off: 'You are not receiving text messages from us. Authorize below to get document requests, appointment reminders and billing notices by SMS.',
    stopped: (d: string) => `Cancelled on ${d}. You can authorize again below.`,
    saving: 'Saving…', saved: 'Saved.', error: 'Could not save. Try again.',
    why: 'Optional. Used only for messages about your own services — never marketing lists.',
  },
  pt: {
    title: 'Mensagens de texto (SMS)', phone: 'Celular', agree: 'Li e concordo com o texto acima',
    authorize: 'Autorizar mensagens de texto', cancel: 'Parar de receber mensagens',
    on: (d: string) => `Autorizado em ${d}. Responda STOP a qualquer mensagem para cancelar.`,
    off: 'Você não recebe mensagens de texto nossas. Autorize abaixo para receber pedidos de documentos, lembretes de compromissos e avisos de cobrança por SMS.',
    stopped: (d: string) => `Cancelado em ${d}. Você pode autorizar de novo abaixo.`,
    saving: 'Salvando…', saved: 'Salvo.', error: 'Não foi possível salvar. Tente de novo.',
    why: 'Opcional. Usado só para mensagens sobre os seus próprios serviços — nunca lista de marketing.',
  },
  es: {
    title: 'Mensajes de texto (SMS)', phone: 'Celular', agree: 'Leí y acepto el texto de arriba',
    authorize: 'Autorizar mensajes de texto', cancel: 'Dejar de recibir mensajes',
    on: (d: string) => `Autorizado el ${d}. Responda STOP a cualquier mensaje para cancelar.`,
    off: 'No recibe mensajes de texto nuestros. Autorice abajo para recibir pedidos de documentos, recordatorios de citas y avisos de cobro por SMS.',
    stopped: (d: string) => `Cancelado el ${d}. Puede autorizar de nuevo abajo.`,
    saving: 'Guardando…', saved: 'Guardado.', error: 'No se pudo guardar. Intente de nuevo.',
    why: 'Opcional. Se usa solo para mensajes sobre sus propios servicios — nunca listas de marketing.',
  },
}

type Situacao = {
  phone: string; consent: boolean; consentAt: string | null
  optedOutAt: string | null; text: string; version: string
}

export default function SmsConsent({ lang }: { lang: string }) {
  const t = T[lang] || T.en
  const [s, setS] = useState<Situacao | null>(null)
  const [phone, setPhone] = useState('')
  const [agree, setAgree] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = async () => {
    const r = await fetch('/api/portal/sms-consent')
    const d = await r.json().catch(() => null)
    if (d?.ok) { setS(d); setPhone(d.phone || '') }
  }
  useEffect(() => { load() }, [])

  const enviar = async (action: 'opt_in' | 'opt_out') => {
    setBusy(true); setMsg(t.saving)
    const r = await fetch('/api/portal/sms-consent', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, phone }),
    })
    const d = await r.json().catch(() => null)
    if (d?.ok) { setS(d); setAgree(false); setMsg(t.saved) }
    else setMsg(d?.error || t.error)
    setBusy(false)
  }

  if (!s) return null
  const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US')

  return (
    <div style={{ background: '#fff', borderRadius: 14, padding: 20, border: '1px solid #e2e8f4', marginBottom: 28 }}>
      <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 16, color: '#0f2340', margin: '0 0 10px' }}>📱 {t.title}</h2>

      {s.consent ? (
        <>
          <p style={{ fontSize: 13.5, color: '#1a6b4a', background: '#e8f5ee', borderRadius: 8, padding: '10px 14px', margin: '0 0 12px' }}>
            ✓ {t.on(fmt(s.consentAt || new Date().toISOString()))} <span style={{ color: '#3a4a5a' }}>({s.phone})</span>
          </p>
          <button onClick={() => enviar('opt_out')} disabled={busy}
            style={{ padding: '8px 14px', background: '#fff', color: '#b02020', border: '1.5px solid #b02020', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            {t.cancel}
          </button>
        </>
      ) : (
        <>
          <p style={{ fontSize: 13.5, color: '#3a4a5a', margin: '0 0 12px', lineHeight: 1.5 }}>
            {s.optedOutAt ? t.stopped(fmt(s.optedOutAt)) : t.off}
          </p>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#6a7a9a', marginBottom: 4 }}>{t.phone}</label>
          <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(857) 555-1234"
            style={{ padding: '9px 11px', border: '1.5px solid #e2e8f4', borderRadius: 8, fontSize: 14, width: 220, maxWidth: '100%', marginBottom: 12 }} />

          {/* Texto exato do consentimento — é o que fica gravado */}
          <p style={{ fontSize: 12.5, color: '#3a4a5a', background: '#f8faff', border: '1px solid #e2e8f4', borderRadius: 8, padding: '10px 14px', margin: '0 0 10px', lineHeight: 1.55 }}>
            {s.text}
          </p>
          <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer', fontSize: 13, marginBottom: 12 }}>
            <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ marginTop: 3, width: 16, height: 16 }} />
            <span>{t.agree}</span>
          </label>
          <button onClick={() => enviar('opt_in')} disabled={busy || !agree || !phone.trim()}
            style={{ padding: '9px 16px', background: busy || !agree || !phone.trim() ? '#e2e8f4' : '#2D3278', color: busy || !agree || !phone.trim() ? '#9aaab0' : '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: busy || !agree ? 'not-allowed' : 'pointer' }}>
            {t.authorize}
          </button>
          <p style={{ fontSize: 11.5, color: '#9aaab0', margin: '10px 0 0' }}>{t.why}</p>
        </>
      )}
      {msg && <p style={{ fontSize: 12.5, marginTop: 10, marginBottom: 0, color: msg === t.saved ? '#1a6b4a' : msg === t.saving ? '#6a7a9a' : '#b02020' }}>{msg}</p>}
    </div>
  )
}
