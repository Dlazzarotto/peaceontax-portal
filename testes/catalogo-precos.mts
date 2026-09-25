// testes/catalogo-precos.mts — quando um serviço aparece na fatura
//
// O item nascia com `active` nulo (o POST não gravava) e a fatura exigia
// `= true`: cadastrava-se um serviço e ele não aparecia onde seria usado.

import { ehItemAtivo, FILTRO_ATIVO } from '../lib/catalogo-precos.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

eq('ativo explicito', ehItemAtivo(true), true)
eq('nulo e ativo -- ninguem desativou', ehItemAtivo(null), true)
eq('indefinido e ativo', ehItemAtivo(undefined), true)
eq('so false desativa', ehItemAtivo(false), false)

// Desativar e um ATO. Nada alem de false pode valer como desativado, senao
// um item volta a sumir por um detalhe de coluna.
eq('zero nao desativa', ehItemAtivo(0), true)
eq('string vazia nao desativa', ehItemAtivo(''), true)
eq('a string "false" nao desativa', ehItemAtivo('false'), true)

// O filtro que vai para o PostgREST tem de dizer a MESMA coisa.
eq('o filtro aceita nulo e true', FILTRO_ATIVO, 'active.is.null,active.eq.true')
eq('o filtro nao menciona false', FILTRO_ATIVO.includes('false'), false)

console.log(`catalogo-precos: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
