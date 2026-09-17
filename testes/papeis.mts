// testes/papeis.mts — a porta de entrada: firma ou cliente?
//
// Este é o teste do defeito que mandou um convidado como "staff" para o
// portal do cliente. Não é dinheiro, mas decide quem vê a carteira inteira
// — e errou em produção porque a comparação estava escrita em três lugares.

import { ehDaFirma, papelDoLogin, PAPEIS_DA_FIRMA } from '../lib/papeis.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// ── O defeito: todo papel do convite tem de abrir a área da firma ──
// O formulário de convite oferece firm | admin | manager | staff.
for (const papel of ['firm', 'admin', 'manager', 'staff']) {
  eq(`convite como ${papel} entra na firma`, ehDaFirma(papel), true)
  eq(`convite como ${papel} nao cai no portal`,
     papelDoLogin({ user_metadata: { role: papel } }), 'firm')
}
eq('owner (sinonimo de firm) entra', ehDaFirma('owner'), true)

// ── Cliente é cliente ──
eq('cliente', ehDaFirma('client'), false)
eq('cliente no login', papelDoLogin({ user_metadata: { role: 'client' } }), 'client')

// ── A lista é fechada: desconhecido é CLIENTE, nunca firma ──
// Errar para o lado restritivo tranca um funcionário; para o outro,
// abre a carteira inteira.
for (const lixo of ['administrator', 'super', 'firma', '', 'staffx', 'partner'])
  eq(`papel desconhecido "${lixo}" NAO e firma`, ehDaFirma(lixo), false)

eq('sem papel', ehDaFirma(undefined), false)
eq('nulo', ehDaFirma(null), false)
eq('numero', ehDaFirma(1 as any), false)
eq('objeto', ehDaFirma({ role: 'firm' } as any), false)
eq('array', ehDaFirma(['firm'] as any), false)

// ── Tolerância ao que a mão digita, sem afrouxar a lista ──
eq('maiuscula', ehDaFirma('Manager'), true)
eq('espaco em volta', ehDaFirma(' staff '), true)
eq('maiuscula com espaco', ehDaFirma('Firm '), true)

// ── Login sem metadata nenhum ──
eq('login sem metadata', papelDoLogin({}), 'client')
eq('login nulo', papelDoLogin(null), 'client')
eq('metadata vazio', papelDoLogin({ user_metadata: {} }), 'client')

// ── A lista não pode crescer sem alguém notar ──
eq('a lista e exatamente esta',
   [...PAPEIS_DA_FIRMA], ['firm', 'owner', 'admin', 'manager', 'staff'])
eq('client jamais entra na lista',
   (PAPEIS_DA_FIRMA as readonly string[]).includes('client'), false)

console.log(`papeis: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
