// lib/sms-consent-text.ts — o texto EXATO que o cliente vê ao autorizar SMS.
//
// Consentimento é prova (princípio 6): o que fica em sms_consent_log é este
// texto, com a versão. Mudou uma vírgula? Sobe a versão, para que um registro
// antigo continue apontando para o que o cliente realmente leu.
// Sem dependência de servidor: é importado pela tela do portal e pela rota.

export const SMS_CONSENT_VERSION = 'portal-v1'

const TEXTOS: Record<string, string> = {
  en: 'I authorize Peace on Tax Corp to send text messages (SMS) to the mobile number above about my accounting and tax services, including document requests, appointment reminders and billing notices. Message frequency varies. Message and data rates may apply. Reply STOP to cancel at any time or HELP for help.',
  pt: 'Autorizo a Peace on Tax Corp a enviar mensagens de texto (SMS) para o celular acima sobre meus serviços contábeis e fiscais, incluindo pedidos de documentos, lembretes de compromissos e avisos de cobrança. A frequência das mensagens varia. Podem incidir taxas da operadora. Responda STOP para cancelar a qualquer momento ou HELP para ajuda.',
  es: 'Autorizo a Peace on Tax Corp a enviarme mensajes de texto (SMS) al celular indicado arriba sobre mis servicios contables y fiscales, incluidos pedidos de documentos, recordatorios de citas y avisos de cobro. La frecuencia de los mensajes varía. Pueden aplicarse tarifas de la operadora. Responda STOP para cancelar en cualquier momento o HELP para ayuda.',
}

/** Idioma do cliente → texto do consentimento (inglês quando não há tradução). */
export function textoConsentimentoSms(lang: string | null | undefined): string {
  return TEXTOS[(lang || 'en').toLowerCase()] || TEXTOS.en
}

/** Forma gravada na trilha: texto + versão, para nunca haver dúvida do que foi aceito. */
export function textoConsentimentoParaRegistro(lang: string | null | undefined): string {
  return `${textoConsentimentoSms(lang)} [${SMS_CONSENT_VERSION}]`
}
