// testes/cobranca-balcao.mts — cobrar no balcão: o quê e por quanto
//
// Duas regras, as duas de dinheiro, as duas com precedente de erro neste
// sistema: cobrar o TOTAL de uma fatura com entrada paga cobra a entrada
// duas vezes; e rascunho não é cobrável porque nunca chegou ao cliente.

import { saldoDaFatura, ehPagavel, PAGAVEL } from '../lib/cobranca-balcao.ts'

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

console.log(`cobranca-balcao: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
