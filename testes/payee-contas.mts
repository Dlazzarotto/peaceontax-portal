// testes/payee-contas.mts — que contas o payee ja usou
//
// Decide LANCAMENTO CONTABIL: e o que a tela mostra a quem esta lancando um
// cheque, em que so vieram numero e valor. O sistema gravava a conta do
// ultimo lancamento sozinho; para o payee que cai sempre na mesma conta isso
// funciona, e para o que nao cai erra sempre.

import { historicoDoPayee, avisoDeVariacao } from '../lib/payee-contas.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// ── Payee de uma conta so: o caso que funcionava, e segue funcionando ──
{
  const h = historicoDoPayee([
    { category: 'Office Supplies', tx_date: '2026-09-01' },
    { category: 'Office Supplies', tx_date: '2026-08-01' },
  ])
  eq('uma conta so', h.contas.length, 1)
  eq('sugere ela',   h.sugerida, 'Office Supplies')
  eq('NAO e variado', h.variado, false)
  eq('conta duas vezes', h.contas[0].vezes, 2)
  eq('guarda a mais recente', h.contas[0].ultima, '2026-09-01')
  eq('sem aviso', avisoDeVariacao(h), null)
}

// ── O CASO: mesmo payee, contas diferentes ──
{
  const h = historicoDoPayee([
    { category: 'Materials',  tx_date: '2026-09-10' },
    { category: 'Subcontractor', tx_date: '2026-08-02' },
    { category: 'Materials',  tx_date: '2026-07-15' },
    { category: 'Fuel',       tx_date: '2026-06-01' },
    { category: 'Subcontractor', tx_date: '2026-05-20' },
    { category: 'Subcontractor', tx_date: '2026-04-11' },
  ])
  eq('tres contas',        h.contas.length, 3)
  eq('E variado',          h.variado, true)
  eq('a mais recente vem primeiro', h.contas[0].category, 'Materials')
  eq('a ordem e por data', h.contas.map(c => c.category),
     ['Materials', 'Subcontractor', 'Fuel'])
  eq('as contagens estao certas', h.contas.map(c => c.vezes), [2, 3, 1])
  const aviso = avisoDeVariacao(h)
  eq('avisa',              typeof aviso === 'string', true)
  eq('diz quantas contas', /3 contas/.test(aviso!), true)
  eq('diz quantos lancamentos', /6 lançamentos/.test(aviso!), true)
}

// A conta MAIS USADA nao vence a MAIS RECENTE: o lancador quer saber o que
// aconteceu por ultimo, e ve as outras logo abaixo.
{
  const h = historicoDoPayee([
    { category: 'Repairs', tx_date: '2026-09-10' },
    { category: 'Fuel',    tx_date: '2026-09-01' },
    { category: 'Fuel',    tx_date: '2026-08-01' },
    { category: 'Fuel',    tx_date: '2026-07-01' },
  ])
  eq('recente vence frequente', h.sugerida, 'Repairs')
  eq('mas a frequente aparece', h.contas[1].category, 'Fuel')
  eq('com a contagem',          h.contas[1].vezes, 3)
}

// ── Empate de data: a mais usada desempata ──
{
  const h = historicoDoPayee([
    { category: 'Alpha', tx_date: '2026-09-10' },
    { category: 'Beta',  tx_date: '2026-09-10' },
    { category: 'Beta',  tx_date: '2026-01-10' },
  ])
  eq('empate na data: mais usada primeiro', h.contas[0].category, 'Beta')
}
// Empate de data E de uso: ordem alfabetica, para a tela nao dancar a cada carga
{
  const h = historicoDoPayee([
    { category: 'Zeta',  tx_date: '2026-09-10' },
    { category: 'Alpha', tx_date: '2026-09-10' },
  ])
  eq('empate total: alfabetica', h.contas.map(c => c.category), ['Alpha', 'Zeta'])
}

// ── Lixo nao vira conta ──
eq('lista vazia',   historicoDoPayee([]), { contas: [], sugerida: null, variado: false })
eq('sem categoria e ignorado',
   historicoDoPayee([{ category: null, tx_date: '2026-09-01' }]).contas.length, 0)
eq('categoria vazia e ignorada',
   historicoDoPayee([{ category: '   ', tx_date: '2026-09-01' }]).contas.length, 0)
eq('nulo nao quebra', historicoDoPayee(null as any).contas.length, 0)

// ── Data ausente ou invalida nao ganha da data que existe ──
{
  const h = historicoDoPayee([
    { category: 'Alpha', tx_date: null },
    { category: 'Alpha', tx_date: '2026-03-01' },
  ])
  eq('a data real prevalece', h.contas[0].ultima, '2026-03-01')
  eq('e conta as duas',       h.contas[0].vezes, 2)
}
{
  const h = historicoDoPayee([
    { category: 'Alpha', tx_date: '2026-03-01' },
    { category: 'Alpha', tx_date: 'nao e data' },
  ])
  eq('data invalida nao apaga a boa', h.contas[0].ultima, '2026-03-01')
}
{
  const h = historicoDoPayee([{ category: 'Alpha', tx_date: null }])
  eq('so sem data: ultima e null', h.contas[0].ultima, null)
  eq('ainda assim sugere',         h.sugerida, 'Alpha')
}

// ── Timestamp completo tambem serve (o banco pode devolver com hora) ──
eq('timestamp e cortado em 10',
   historicoDoPayee([{ category: 'Alpha', tx_date: '2026-03-01T14:22:00Z' }]).contas[0].ultima,
   '2026-03-01')

// ── A ordem da entrada nao importa: quem ordena e a funcao ──
{
  const a = historicoDoPayee([
    { category: 'B', tx_date: '2026-01-01' },
    { category: 'A', tx_date: '2026-09-01' },
  ])
  const b = historicoDoPayee([
    { category: 'A', tx_date: '2026-09-01' },
    { category: 'B', tx_date: '2026-01-01' },
  ])
  eq('mesmo resultado em qualquer ordem', a, b)
}

console.log(`payee-contas: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
