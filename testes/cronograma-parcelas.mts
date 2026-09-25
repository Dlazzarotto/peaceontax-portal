// testes/cronograma-parcelas.mts — o cronograma fecha, e a parcela tem piso
//
// Dinheiro com arredondamento, e a conta estava dentro de uma rota (sem
// teste). O piso é a correção que faltava: o Stripe RECUSA cobrança abaixo
// de US$ 0,50, então um plano com parcela menor falharia para sempre.

import {
  montarCronograma, somaDoCronograma, maximoDeParcelas, MINIMO_POR_PARCELA,
} from '../lib/cronograma-parcelas.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const contem = (n: string, txt: any, pedaco: string) =>
  String(txt || '').includes(pedaco) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(txt), '\n  devia conter:', pedaco))

const linhas = (r: any) => (Array.isArray(r) ? r : (console.log('esperava cronograma, veio', r), []))

// ── A SOMA TEM DE FECHAR, sempre. Um centavo a menos e a fatura nunca quita.
for (const [saldo, n] of [[1000, 3], [1000, 7], [999.99, 3], [100, 6], [0.5 * 36, 36],
                          [1234.56, 11], [750, 2], [333.33, 3], [20, 36]] as [number, number][]) {
  const r = montarCronograma(saldo, n, '2026-10-15', 'monthly')
  const ls = linhas(r)
  eq(`soma fecha: $${saldo} em ${n}x`, somaDoCronograma(ls), Math.round(saldo * 100) / 100)
  eq(`quantidade: $${saldo} em ${n}x`, ls.length, n)
}

// ── A sobra vai para a ULTIMA, e as outras sao iguais
{
  const ls = linhas(montarCronograma(1000, 3, '2026-10-15', 'monthly'))
  eq('as primeiras sao iguais', [ls[0].amount, ls[1].amount], [333.33, 333.33])
  eq('a ultima leva a sobra', ls[2].amount, 333.34)
  eq('a ultima nunca e MENOR que as outras', ls[2].amount >= ls[0].amount, true)
}

// ── O PISO: o Stripe recusa abaixo de US$ 0,50
eq('o piso e o do cartao', MINIMO_POR_PARCELA, 0.5)
{
  const r = montarCronograma(15, 36, '2026-10-15', 'monthly') as any
  contem('$15 em 36x e recusado', r.erro, 'baixa demais')
  contem('a recusa diz o MAXIMO de parcelas', r.erro, '30 parcelas')
}
{
  // $0,02 em 36x dava parcela de $0,00 -- cobranca de zero no Stripe
  const r = montarCronograma(0.02, 36, '2026-10-15', 'monthly') as any
  contem('saldo minusculo nao vira parcela de zero', r.erro, 'não dá para parcelar')
}
eq('exatamente no piso passa', linhas(montarCronograma(1, 2, '2026-10-15', 'monthly'))[0].amount, 0.5)
{
  const r = montarCronograma(0.99, 2, '2026-10-15', 'monthly') as any
  contem("um centavo abaixo do piso e recusado", r.erro, "não dá para parcelar")
}

// ── maximoDeParcelas
eq('maximo de $15', maximoDeParcelas(15), 30)
eq('maximo de $1', maximoDeParcelas(1), 2)
eq('maximo de $0.99', maximoDeParcelas(0.99), 1)
eq('maximo de saldo zero', maximoDeParcelas(0), 0)
eq('maximo de saldo negativo', maximoDeParcelas(-5), 0)

// ── Recusas de entrada
contem('saldo zero', (montarCronograma(0, 3, '2026-10-15', 'monthly') as any).erro, 'Não há saldo')
contem('uma parcela so nao e parcelamento', (montarCronograma(100, 1, '2026-10-15', 'monthly') as any).erro, '2 a 36')
contem('quebrado nao e quantidade', (montarCronograma(100, 2.5, '2026-10-15', 'monthly') as any).erro, '2 a 36')
contem('data invalida', (montarCronograma(100, 2, 'dia 15', 'monthly') as any).erro, 'inválida')

// ── As datas andam conforme a frequencia
{
  const m = linhas(montarCronograma(300, 3, '2026-01-31', 'monthly'))
  eq('mensal comeca na data pedida', m[0].due_date, '2026-01-31')
  eq('mensal nao inventa 31 de fevereiro', m[1].due_date, '2026-02-28')
  const s = linhas(montarCronograma(300, 3, '2026-10-15', 'weekly'))
  eq('semanal anda 7 dias', s[1].due_date, '2026-10-22')
  const q = linhas(montarCronograma(300, 3, '2026-10-15', 'biweekly'))
  eq('quinzenal anda 14 dias', q[1].due_date, '2026-10-29')
}

// ── A sequencia comeca em 1 e nao pula
{
  const ls = linhas(montarCronograma(500, 5, '2026-10-15', 'monthly'))
  eq('seq de 1 a n', ls.map(l => l.seq), [1, 2, 3, 4, 5])
}

console.log(`cronograma-parcelas: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
