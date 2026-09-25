// lib/email-motivo.ts — por que o e-mail ao cliente não sai.
//
// Módulo PURO, sem import nenhum, por dois motivos: é o que dá para testar
// sem subir nada, e `lib/avisos.ts` depende de `contract-html` (a marca da
// firma), o que impediria o teste de importar de lá.
//
// "Falha no envio" não é resposta. Quem lê a mensagem precisa saber ONDE
// está o conserto:
//   sem chave            → o sócio, no Vercel
//   cadastro sem e-mail  → a equipe, na ficha do cliente
//   endereço inválido    → a equipe, na ficha, e o texto mostra qual é
//   recusa do Resend     → o painel do Resend (domínio não verificado é o
//                          caso comum) — esse motivo vem do próprio Resend

/** Endereço do remetente. O diagnóstico e o envio leem daqui, para não divergir. */
export function remetenteDoEmail(): string {
  return process.env.RESEND_FROM_EMAIL || 'noreply@peaceontax.com'
}

/**
 * O que impede a tentativa, ou `null` quando dá para tentar.
 *
 * A falta da CHAVE vem primeiro de propósito: sem ela nenhum e-mail sai para
 * ninguém, então é o conserto que resolve todos os casos de uma vez. Dizer
 * "cliente sem e-mail" quando o servidor inteiro está sem chave mandaria a
 * equipe caçar fichas uma a uma.
 */
export function porqueNaoTenta(temChave: boolean, para: string | null | undefined): string | null {
  if (!temChave) return 'e-mail não está configurado no servidor (falta RESEND_API_KEY)'
  const e = String(para || '').trim()
  if (!e) return 'cliente sem e-mail no cadastro'
  if (!e.includes('@')) return `e-mail do cadastro é inválido: ${e}`
  return null
}
