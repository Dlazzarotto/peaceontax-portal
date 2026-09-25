// testes/email-motivo.mts — por que o e-mail ao cliente não saiu
//
// "Falha no envio" não é resposta: quem lê precisa saber se o conserto é no
// servidor (variável), na ficha do cliente (cadastro) ou no painel do Resend.

import { porqueNaoTenta, remetenteDoEmail } from '../lib/email-motivo.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const contem = (n: string, txt: any, pedaco: string) =>
  String(txt || '').includes(pedaco) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(txt), '\n  devia conter:', pedaco))

// ── Sem chave: nem tenta, e o motivo aponta o VERCEL ──
contem('sem chave diz qual variavel falta', porqueNaoTenta(false, 'a@b.com'), 'RESEND_API_KEY')
// A falta da chave vence a falta do e-mail: e o primeiro conserto.
contem('sem chave vence sem e-mail', porqueNaoTenta(false, ''), 'RESEND_API_KEY')

// ── Com chave, o problema e o cadastro ──
contem('cadastro sem e-mail', porqueNaoTenta(true, ''), 'sem e-mail')
contem('so espacos conta como sem e-mail', porqueNaoTenta(true, '   '), 'sem e-mail')
contem('nulo conta como sem e-mail', porqueNaoTenta(true, null), 'sem e-mail')
contem('indefinido conta como sem e-mail', porqueNaoTenta(true, undefined), 'sem e-mail')

// ── E-mail invalido diz QUAL, para a equipe achar na ficha ──
contem('invalido aparece no motivo', porqueNaoTenta(true, 'joao.silva'), 'joao.silva')
contem('invalido e chamado de invalido', porqueNaoTenta(true, 'joao.silva'), 'inválido')

// ── Nada impede: null quer dizer "pode tentar" ──
eq('endereco bom nao impede', porqueNaoTenta(true, 'cliente@exemplo.com'), null)
eq('espaco em volta nao impede', porqueNaoTenta(true, '  cliente@exemplo.com  '), null)

// ── O remetente do diagnostico e o MESMO do envio ──
eq('remetente padrao', remetenteDoEmail(), process.env.RESEND_FROM_EMAIL || 'noreply@peaceontax.com')
contem('remetente tem arroba', remetenteDoEmail(), '@')

console.log(`email-motivo: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
