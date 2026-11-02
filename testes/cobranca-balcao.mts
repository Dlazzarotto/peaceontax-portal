// testes/cobranca-balcao.mts — cobrar no balcão: o quê e por quanto
//
// Duas regras, as duas de dinheiro, as duas com precedente de erro neste
// sistema: cobrar o TOTAL de uma fatura com entrada paga cobra a entrada
// duas vezes; e rascunho não é cobrável porque nunca chegou ao cliente.

import { saldoDaFatura, ehPagavel, PAGAVEL, decidirValorDaCobranca, MINIMO_STRIPE } from '../lib/cobranca-balcao.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// ── O valor é o SALDO, nunca o total ────────────────────────────────────
eq('fatura inteira em aberto', saldoDaFatura({ total: 1000, paid_total: 0 }), 1000)
eq('com entrada de $250 cobra $750', saldoDaFatura({ total: 1000, paid_total: 250 }), 750)
eq('quitada não tem saldo', saldoDaFatura({ total: 1000, paid_total: 1000 }), 0)
eq('pagou a mais dá negativo (a rota recusa)', saldoDaFatura({ total: 1000, paid_total: 1200 }), -200)
// O banco devolve numeric como STRING pelo PostgREST — somar string
// concatena, e `'1000' - '250'` só funciona por coerção. Testado de propósito.
eq('string do banco vira número', saldoDaFatura({ total: '1000.00', paid_total: '250.00' }), 750)
eq('paid_total nulo é zero', saldoDaFatura({ total: 500, paid_total: null }), 500)
eq('paid_total ausente é zero', saldoDaFatura({ total: 500 }), 500)
eq('total nulo não quebra', saldoDaFatura({ total: null }), 0)
// Centavos: o Stripe recebe `Math.round(saldo * 100)`, então um décimo de
// centavo perdido aqui vira recusa lá.
eq('centavo quebrado', saldoDaFatura({ total: 333.33, paid_total: 111.11 }), 222.22)
eq('terço que não fecha', saldoDaFatura({ total: 100, paid_total: 33.33 }), 66.67)

// ── Rascunho NÃO é cobrável ─────────────────────────────────────────────
eq('rascunho recusado', ehPagavel('draft'), false)
eq('enviada', ehPagavel('sent'), true)
eq('parcial', ehPagavel('partial'), true)
eq('vencida', ehPagavel('overdue'), true)
eq('paga não é cobrável', ehPagavel('paid'), false)
eq('cancelada não é cobrável', ehPagavel('void'), false)
eq('status desconhecido recusa', ehPagavel('inventado'), false)
eq('nulo recusa', ehPagavel(null), false)
eq('vazio recusa', ehPagavel(''), false)

// A lista é FECHADA: status novo nasce NÃO cobrável. Errar para o lado de
// "deixa cobrar" receberia dinheiro de documento que o cliente não viu.
eq('a lista tem exatamente três', [...PAGAVEL], ['sent', 'partial', 'overdue'])

// ── O valor que o Stripe cobra é o que a equipe DIGITOU ─────────────────
// O botão mostrava o valor digitado e a rota cobrava o saldo inteiro.
const d = (saldo: any, pedido: unknown, forma = 'card', parcelado = false) =>
  decidirValorDaCobranca({ saldo, pedido, forma, parcelado })
eq('vazio é o saldo', d(1000, ''), { ok: true, valor: 1000, parcial: false })
eq('ausente é o saldo', d(1000, undefined), { ok: true, valor: 1000, parcial: false })
eq('nulo é o saldo', d(1000, null), { ok: true, valor: 1000, parcial: false })
eq('só espaço é o saldo', d(1000, '   '), { ok: true, valor: 1000, parcial: false })
eq('parte do saldo é parcial', d(1000, '250'), { ok: true, valor: 250, parcial: true })
eq('número também serve', d(1000, 250), { ok: true, valor: 250, parcial: true })
eq('saldo em texto (vem do banco)', d('1000.00', '250'), { ok: true, valor: 250, parcial: true })
eq('igual ao saldo não é parcial', d(1000, '1000'), { ok: true, valor: 1000, parcial: false })
eq('centavos arredondam', d(1000, '249.999'), { ok: true, valor: 250, parcial: true })
eq('meio centavo acima do saldo ainda é o saldo', d(1000, 1000.004), { ok: true, valor: 1000, parcial: false })
eq('acima do saldo recusa dizendo o saldo', d(1000, '1200'),
  { ok: false, motivo: 'O valor ($1200.00) passa do saldo da fatura ($1000.00).' })
eq('um centavo acima recusa', d(1000, '1000.01').ok, false)
eq('zero recusa', d(1000, '0').ok, false)
eq('negativo recusa', d(1000, '-5').ok, false)
eq('texto recusa', d(1000, 'abc').ok, false)
eq('vírgula de milhar recusa, não adivinha', d(1000, '1,000').ok, false)
eq('abaixo do piso do Stripe recusa', d(1000, '0.49'), { ok: false, motivo: 'O Stripe não cobra menos de $0.50.' })
eq('piso exato passa', d(1000, '0.50'), { ok: true, valor: 0.5, parcial: true })
eq('saldo abaixo do piso recusa mesmo inteiro', d(0.3, '').ok, false)
eq('fatura quitada recusa', d(0, ''), { ok: false, motivo: 'Esta fatura já está quitada.' })
eq('saldo negativo (sobra) recusa', d(-10, '').ok, false)
eq('Klarna parcial recusa', d(1000, '250', 'klarna').ok, false)
eq('Klarna inteiro passa', d(1000, '', 'klarna'), { ok: true, valor: 1000, parcial: false })
eq('Klarna com o saldo digitado passa', d(1000, '1000', 'klarna'), { ok: true, valor: 1000, parcial: false })
eq('ACH parcial passa', d(1000, '400', 'us_bank_account'), { ok: true, valor: 400, parcial: true })
eq('todas as formas, parcial, passa (a rota tira o Klarna)', d(1000, '400', 'todas'), { ok: true, valor: 400, parcial: true })
eq('parcelada: parte recusa', d(1000, '250', 'card', true).ok, false)
eq('parcelada: quitação passa', d(1000, '1000', 'card', true), { ok: true, valor: 1000, parcial: false })
eq('parcelada: vazio é quitação', d(1000, '', 'card', true), { ok: true, valor: 1000, parcial: false })
eq('piso exportado', MINIMO_STRIPE, 0.5)

console.log(`cobranca-balcao: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
