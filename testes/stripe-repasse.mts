// testes/stripe-repasse.mts — qual repasse do Stripe é ESTE depósito
//
// Conciliar o repasse errado embaralha a receita de dois dias. Por isso a
// regra é estreita: valor IGUAL ao centavo e data próxima, e ambiguidade
// devolve null em vez de chutar.

import { repasseDoDeposito } from '../lib/stripe-repasse.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const r = (id: string, valor: number, chegadaEm: string) =>
  ({ id, valor, chegadaEm, status: 'paid', descricao: null })

const lista = [r('po_1', 970, '2026-09-04'), r('po_2', 1500.25, '2026-09-10')]

eq('casa por valor e data', repasseDoDeposito(lista, 970, '2026-09-04').repasse?.id, 'po_1')
eq('o banco credita um ou dois dias depois', repasseDoDeposito(lista, 970, '2026-09-06').repasse?.id, 'po_1')
eq('quatro dias ainda casa', repasseDoDeposito(lista, 970, '2026-09-08').repasse?.id, 'po_1')
eq('cinco dias nao casa mais', repasseDoDeposito(lista, 970, '2026-09-09').repasse, null)
eq('o banco nao credita dois dias ANTES do repasse', repasseDoDeposito(lista, 970, '2026-09-02').repasse, null)
eq('um dia antes passa (fuso do Stripe)', repasseDoDeposito(lista, 970, '2026-09-03').repasse?.id, 'po_1')

eq('um centavo de diferenca NAO e o mesmo repasse', repasseDoDeposito(lista, 970.01, '2026-09-04').repasse, null)
eq('valor com centavos casa', repasseDoDeposito(lista, 1500.25, '2026-09-11').repasse?.id, 'po_2')
eq('valor que nao existe', repasseDoDeposito(lista, 42, '2026-09-04').repasse, null)
eq('sem repasse nenhum', repasseDoDeposito([], 970, '2026-09-04').repasse, null)

// Dois repasses do mesmo valor na mesma semana: nao chuta.
{
  const dois = [r('po_a', 970, '2026-09-04'), r('po_b', 970, '2026-09-05')]
  const x = repasseDoDeposito(dois, 970, '2026-09-06')
  eq('ambiguidade nao escolhe', x.repasse, null)
  eq('e diz por que', x.motivo !== null, true)
}
// Mesmo valor, mas um deles fora da janela: escolhe o que sobra.
{
  const dois = [r('po_a', 970, '2026-09-04'), r('po_b', 970, '2026-07-01')]
  eq('fora da janela nao concorre', repasseDoDeposito(dois, 970, '2026-09-05').repasse?.id, 'po_a')
}

console.log(`stripe-repasse: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
