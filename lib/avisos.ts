// lib/avisos.ts — avisos ao cliente por e-mail (Resend) e no portal.
//
// Um lugar só para os dois canais que não passam pela lib de SMS:
//   enviarEmail   → Resend, remetente "Peace on Tax" (princípio 4: a firma fala)
//   avisarNoPortal → linha em chat_messages, o que o cliente vê ao entrar
// Documento que sai leva a marca (princípio 5): o rodapé é o da firma.

import { FIRM } from '@/lib/contract-html'

export const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://peaceontax-portal.vercel.app'

export async function enviarEmail(to: string, subject: string, html: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY
  if (!key || !to || !to.includes('@')) return false
  const from = process.env.RESEND_FROM_EMAIL || 'noreply@peaceontax.com'
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ from: `Peace on Tax <${from}>`, to, subject, html }),
    })
    if (!r.ok) console.error('[avisos] Resend:', await r.text().catch(() => ''))
    return r.ok
  } catch (e) {
    console.error('[avisos] Resend:', (e as Error).message)
    return false
  }
}

/** Mensagem que aparece no portal do cliente (mesma tabela do chat). */
export async function avisarNoPortal(db: any, clientId: string | null | undefined, texto: string): Promise<void> {
  if (!clientId) return
  await db.from('chat_messages').insert({
    client_id: clientId, role: 'assistant', channel: 'portal', content: texto,
  }).then(() => null, () => null)
}

/** Saudação e rodapé com a marca; o miolo vem pronto em HTML. */
export function emailComMarca(opts: { lang?: string | null; nome?: string | null; corpoHtml: string; botao?: { texto: string; url: string } }): string {
  const lang = (opts.lang || 'en').toLowerCase()
  const ola = opts.nome
    ? (lang === 'pt' ? `Olá, ${opts.nome}.` : lang === 'es' ? `Hola, ${opts.nome}.` : `Hello, ${opts.nome}.`)
    : ''
  const botao = opts.botao
    ? `<p style="margin:22px 0"><a href="${opts.botao.url}" style="background:#2D3278;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block">${opts.botao.texto}</a></p>
       <p style="font-size:12px;color:#6a7a9a">${lang === 'pt' ? 'Se o botão não abrir, copie este endereço:' : lang === 'es' ? 'Si el botón no abre, copie esta dirección:' : 'If the button does not open, copy this address:'} ${opts.botao.url}</p>`
    : ''
  return `<div style="font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#0f2340;line-height:1.6;max-width:600px">
    ${ola ? `<p>${ola}</p>` : ''}
    ${opts.corpoHtml}
    ${botao}
    <hr style="border:none;border-top:1px solid #e2e8f4;margin:24px 0">
    <p style="font-size:12px;color:#6a7a9a">${FIRM.name} · ${FIRM.address} · ${FIRM.phone} · ${FIRM.email}</p>
  </div>`
}

/** Locale do Stripe Checkout a partir do idioma do cadastro. */
export function localeStripe(lang: string | null | undefined): string {
  const l = (lang || 'en').toLowerCase()
  return l === 'pt' ? 'pt-BR' : l === 'es' ? 'es' : l === 'zh' ? 'zh' : l === 'fr' ? 'fr' : 'en'
}
