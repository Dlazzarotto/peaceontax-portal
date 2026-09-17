// testes/entrada-parcelamento.mts — a entrada em dolar
//
// Decide dinheiro: e o valor que sai do saldo antes de dividir as parcelas.
// O caso que originou: fatura de $1.000 com entrada de $250. O campo pedia
// PORCENTAGEM, entao digitar 250 era recusado com "a entrada vai de 0% a 90%".

import { entradaDoPedido, tetoDaEntrada, LIMITE_PCT } from '../lib/entrada-parcelamento.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const ok = (n: string, r: any) => ('erro' in r ? (falhou++, console.log('FALHOU:', n, '\n  erro:', r.erro)) : passou++)
const erro = (n: string, r: any) => ('erro' in r ? passou++ : (falhou++, console.log('FALHOU:', n, '-- deveria recusar, veio', JSON.stringify(r))))

// ── O CASO ──
eq('fatura de 1000 com entrada de 250',
   entradaDoPedido({ saldo: 1000, entryAmount: 250 }),
   { entrada: 250, pct: 25, restante: 750 })

// ── Entrada quebrada, como o cliente paga de verdade ──
eq('entrada de 237',
   entradaDoPedido({ saldo: 1000, entryAmount: 237 }),
   { entrada: 237, pct: 23.7, restante: 763 })
eq('entrada com centavos',
   entradaDoPedido({ saldo: 1000, entryAmount: 333.33 }),
   { entrada: 333.33, pct: 33.33, restante: 666.67 })
eq('saldo quebrado e entrada quebrada',
   entradaDoPedido({ saldo: 1287.45, entryAmount: 300 }),
   { entrada: 300, pct: 23.3, restante: 987.45 })

// ── Sem entrada ──
eq('entrada zero',
   entradaDoPedido({ saldo: 1000, entryAmount: 0 }),
   { entrada: 0, pct: 0, restante: 1000 })
eq('entrada ausente = zero',
   entradaDoPedido({ saldo: 1000 }),
   { entrada: 0, pct: 0, restante: 1000 })
eq('campo vazio = zero',
   entradaDoPedido({ saldo: 1000, entryAmount: '' }),
   { entrada: 0, pct: 0, restante: 1000 })

// ── O formato antigo (porcentagem) continua funcionando ──
eq('25% de 1000', entradaDoPedido({ saldo: 1000, entryPct: 25 }),
   { entrada: 250, pct: 25, restante: 750 })
eq('valor tem precedencia sobre porcentagem',
   entradaDoPedido({ saldo: 1000, entryAmount: 100, entryPct: 50 }),
   { entrada: 100, pct: 10, restante: 900 })

// ── O teto ──
eq('teto de 1000 e 900', tetoDaEntrada(1000), 900)
eq('o limite e 90', LIMITE_PCT, 90)
ok('exatamente no teto passa', entradaDoPedido({ saldo: 1000, entryAmount: 900 }))
eq('no teto sobra o que parcelar',
   entradaDoPedido({ saldo: 1000, entryAmount: 900 }),
   { entrada: 900, pct: 90, restante: 100 })
erro('um centavo acima do teto recusa', entradaDoPedido({ saldo: 1000, entryAmount: 900.01 }))

// ── Entrada que cobre o saldo: manda para o caminho certo ──
{
  const r: any = entradaDoPedido({ saldo: 1000, entryAmount: 1000 })
  erro('entrada igual ao saldo recusa', r)
  eq('e diz que e pagamento a vista', /à vista/.test(r.erro), true)
  eq('e aponta a tela de Receber', /Receber/.test(r.erro), true)
}
{
  const r: any = entradaDoPedido({ saldo: 1000, entryAmount: 950 })
  erro('acima do teto recusa', r)
  eq('a mensagem diz o valor maximo, nao a regra', /\$900\.00/.test(r.erro), true)
}

// ── Lixo ──
erro('negativa recusa',      entradaDoPedido({ saldo: 1000, entryAmount: -10 }))
erro('texto recusa',         entradaDoPedido({ saldo: 1000, entryAmount: 'abc' }))
erro('infinito recusa',      entradaDoPedido({ saldo: 1000, entryAmount: Infinity }))
erro('saldo zero recusa',    entradaDoPedido({ saldo: 0, entryAmount: 0 }))
erro('saldo negativo recusa',entradaDoPedido({ saldo: -5, entryAmount: 0 }))

// ── Saldo pequeno ──
eq('saldo de 10 com entrada de 1',
   entradaDoPedido({ saldo: 10, entryAmount: 1 }),
   { entrada: 1, pct: 10, restante: 9 })
erro('saldo de 10 com entrada de 9.50 passa do teto',
   entradaDoPedido({ saldo: 10, entryAmount: 9.5 }))

console.log(`entrada-parcelamento: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
