// testes/contrato-recorrente.mts — a agenda do contrato recorrente
//
// A conta vivia na rota, sem teste, e errava em dois pontos que só
// apareceriam meses depois: somava UM mês qualquer que fosse o intervalo
// (trimestral cobrando todo mês) e usava o dia do SERVIDOR em UTC, não o do
// escritório. Como ainda não há quem cobre por essa data, o erro era mudo.

import {
  primeiraCobranca, proximaCobranca, situacaoDoContrato, mudancasDoContrato,
  diaValido, ehIntervalo, MESES_DO_INTERVALO, DIA_MAXIMO,
} from '../lib/contrato-recorrente.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// ── primeira ocorrência ──────────────────────────────────────────────
eq('dia ainda por vir no mês do início', primeiraCobranca(20, '2026-03-05'), '2026-03-20')
eq('dia igual ao início conta no mesmo mês', primeiraCobranca(5, '2026-03-05'), '2026-03-05')
eq('dia já passou no mês do início vai para o seguinte', primeiraCobranca(3, '2026-03-05'), '2026-04-03')
eq('vira o ano', primeiraCobranca(3, '2026-12-05'), '2027-01-03')

// ── mensal ───────────────────────────────────────────────────────────
eq('mensal: ainda este mês', proximaCobranca(20, '2026-01-10', 'monthly', '2026-03-05'), '2026-03-20')
eq('mensal: já passou, vai para o mês seguinte', proximaCobranca(3, '2026-01-10', 'monthly', '2026-03-05'), '2026-04-03')
// "Depois", nunca "a partir de": se hoje É o dia, a cobrança de hoje já é
// a de hoje -- a PRÓXIMA é a seguinte. Era assim antes e continua.
eq('mensal: hoje é o dia -> a próxima é a seguinte', proximaCobranca(5, '2026-01-10', 'monthly', '2026-03-05'), '2026-04-05')
eq('mensal: vira o ano', proximaCobranca(5, '2026-01-10', 'monthly', '2026-12-31'), '2027-01-05')

// ── trimestral: a régua é ANCORADA no início ─────────────────────────
// Começou em 10/jan: as ocorrências são jan, abr, jul, out. Recalcular a
// partir de HOJE somando três meses daria outra régua a cada edição.
eq('trimestral: em maio a próxima é julho, não junho',
   proximaCobranca(10, '2026-01-10', 'quarterly', '2026-05-01'), '2026-07-10')
eq('trimestral: em 09/abr a próxima é 10/abr',
   proximaCobranca(10, '2026-01-10', 'quarterly', '2026-04-09'), '2026-04-10')
eq('trimestral: em 10/abr (o próprio dia) a próxima é julho',
   proximaCobranca(10, '2026-01-10', 'quarterly', '2026-04-10'), '2026-07-10')
eq('trimestral: vira o ano pela âncora',
   proximaCobranca(10, '2026-01-10', 'quarterly', '2026-11-01'), '2027-01-10')

// ── anual ────────────────────────────────────────────────────────────
eq('anual: mesma data do ano seguinte',
   proximaCobranca(15, '2026-04-15', 'annual', '2026-04-15'), '2027-04-15')
eq('anual: antes da data, ainda este ano',
   proximaCobranca(15, '2026-04-15', 'annual', '2026-04-14'), '2026-04-15')

// ── contrato antigo: o salto não pode virar laço longo ───────────────
eq('contrato de 2015, mensal', proximaCobranca(12, '2015-01-12', 'monthly', '2026-03-05'), '2026-03-12')
eq('contrato de 2015, trimestral mantém a âncora de janeiro',
   proximaCobranca(12, '2015-01-12', 'quarterly', '2026-03-05'), '2026-04-12')
eq('contrato de 2015, anual mantém a âncora',
   proximaCobranca(12, '2015-06-12', 'annual', '2026-03-05'), '2026-06-12')

// ── início no futuro: a primeira cobrança é a do contrato ────────────
eq('início no futuro não é puxado para hoje',
   proximaCobranca(10, '2027-02-01', 'monthly', '2026-03-05'), '2027-02-10')

// ── o dia é limitado a 28, e isso é decisão ──────────────────────────
// 29, 30 e 31 não existem em todo mês. "Cobra no último dia" é outra regra,
// que ninguém pediu -- e mal feita faz fevereiro cobrar três dias antes.
eq('dia 31 vira 28', diaValido(31), DIA_MAXIMO)
eq('dia 0 vira 1', diaValido(0), 1)
eq('dia negativo vira 1', diaValido(-4), 1)
eq('texto vira 1', diaValido('abc'), 1)
eq('texto numérico vale', diaValido('15'), 15)
eq('fracionário trunca', diaValido(15.9), 15)
eq('fevereiro nunca estoura', proximaCobranca(31, '2026-02-01', 'monthly', '2026-02-10'), '2026-02-28')

// ── intervalo desconhecido cai em mensal, não quebra ─────────────────
eq('intervalo inválido não é intervalo', ehIntervalo('semanal'), false)
eq('intervalo inválido vira mensal', proximaCobranca(10, '2026-01-10', 'semanal' as any, '2026-03-05'), '2026-03-10')
eq('os três intervalos e seus meses', MESES_DO_INTERVALO, { monthly: 1, quarterly: 3, annual: 12 })

// ── situação: encerrado VENCE pausado ────────────────────────────────
// Encerrar também desliga o `active`. Olhando só o `active`, um contrato
// acabado apareceria como "pausado" -- com botão de Reativar, que
// ressuscitaria um acordo que as duas partes já desfizeram.
eq('ativo', situacaoDoContrato({ active: true, end_date: null }, '2026-03-05'), 'ativo')
eq('pausado', situacaoDoContrato({ active: false, end_date: null }, '2026-03-05'), 'pausado')
eq('encerrado vence pausado', situacaoDoContrato({ active: false, end_date: '2026-01-31' }, '2026-03-05'), 'encerrado')
eq('encerrado hoje já é encerrado', situacaoDoContrato({ active: false, end_date: '2026-03-05' }, '2026-03-05'), 'encerrado')
eq('fim marcado para o FUTURO ainda é ativo',
   situacaoDoContrato({ active: true, end_date: '2026-12-31' }, '2026-03-05'), 'ativo')
eq('fim no futuro com active falso é pausado, não encerrado',
   situacaoDoContrato({ active: false, end_date: '2026-12-31' }, '2026-03-05'), 'pausado')

// ── o que mudou de verdade ───────────────────────────────────────────
const antes = {
  description: 'Bookkeeping mensal', amount: 350, interval: 'monthly',
  day_of_month: 10, start_date: '2026-01-01', auto_charge: false,
}
eq('nada enviado, nada muda', mudancasDoContrato(antes, {}), { campos: [], update: {} })
eq('mesmo valor não vira mudança', mudancasDoContrato(antes, { amount: 350 }), { campos: [], update: {} })
eq('valor em texto, mesmo número, não vira mudança', mudancasDoContrato(antes, { amount: '350.00' }), { campos: [], update: {} })
eq('mesma descrição com espaço em volta não vira mudança',
   mudancasDoContrato(antes, { description: '  Bookkeeping mensal  ' }), { campos: [], update: {} })
eq('valor muda', mudancasDoContrato(antes, { amount: 400 }), { campos: ['amount'], update: { amount: 400 } })
eq('centavos contam', mudancasDoContrato(antes, { amount: 350.01 }), { campos: ['amount'], update: { amount: 350.01 } })
eq('descrição muda', mudancasDoContrato(antes, { description: 'Bookkeeping + Payroll' }),
   { campos: ['description'], update: { description: 'Bookkeeping + Payroll' } })
eq('dia muda e é limitado', mudancasDoContrato(antes, { dayOfMonth: 99 }),
   { campos: ['dayOfMonth'], update: { day_of_month: 28 } })
eq('intervalo muda', mudancasDoContrato(antes, { interval: 'quarterly' }),
   { campos: ['interval'], update: { interval: 'quarterly' } })
eq('auto_charge muda', mudancasDoContrato(antes, { autoCharge: true }),
   { campos: ['autoCharge'], update: { auto_charge: true } })

// Corpo de requisição NUNCA vai inteiro para o banco: campo que não está na
// lista é ignorado em silêncio pela montagem (não entra no update).
eq('campo fora da lista não entra', mudancasDoContrato(antes, { client_id: 'outro', active: true } as any),
   { campos: [], update: {} })

// As tres armadilhas da comparacao: cada uma marcaria "mudou" sem nada ter
// mudado, enchendo a trilha de ruido e escondendo a alteracao de verdade.
eq('auto_charge nulo no banco e igual a false',
   mudancasDoContrato({ ...antes, auto_charge: null }, { autoCharge: false }), { campos: [], update: {} })
eq('auto_charge nulo -> true e mudanca de verdade',
   mudancasDoContrato({ ...antes, auto_charge: null }, { autoCharge: true }),
   { campos: ['autoCharge'], update: { auto_charge: true } })
eq('start_date com hora nao e mudanca',
   mudancasDoContrato({ ...antes, start_date: '2026-01-01T00:00:00' }, { startDate: '2026-01-01' }),
   { campos: [], update: {} })
eq('start_date diferente e mudanca',
   mudancasDoContrato(antes, { startDate: '2026-02-01' }),
   { campos: ['startDate'], update: { start_date: '2026-02-01' } })

// Campo de data VAZIO e "nao mexi nisso", nao "data invalida". Contrato antigo
// pode estar sem start_date: o formulario manda '' e, recusando, quem so queria
// trocar o VALOR levava um erro falando de data.
eq('data vazia nao e recusa', mudancasDoContrato(antes, { startDate: '' }), { campos: [], update: {} })
eq('data vazia nao impede o resto', mudancasDoContrato(antes, { startDate: '', amount: 400 }),
   { campos: ['amount'], update: { amount: 400 } })
eq('data so com espacos nao e recusa', mudancasDoContrato(antes, { startDate: '   ' }), { campos: [], update: {} })
eq('contrato sem start_date edita o valor normalmente',
   mudancasDoContrato({ ...antes, start_date: null }, { startDate: '', amount: 400 }),
   { campos: ['amount'], update: { amount: 400 } })

// Recusas
eq('descrição vazia recusa', mudancasDoContrato(antes, { description: '   ' }).erro,
   'Descreva o serviço do contrato.')
eq('valor zero recusa', mudancasDoContrato(antes, { amount: 0 }).erro, 'Informe o valor do contrato.')
eq('valor negativo recusa', mudancasDoContrato(antes, { amount: -10 }).erro, 'Informe o valor do contrato.')
eq('valor não numérico recusa', mudancasDoContrato(antes, { amount: 'abc' }).erro, 'Informe o valor do contrato.')
eq('intervalo inválido recusa', mudancasDoContrato(antes, { interval: 'semanal' }).erro, 'Intervalo inválido.')
eq('data inválida recusa', mudancasDoContrato(antes, { startDate: '05/03/2026' }).erro,
   'Data de início inválida (use MM/DD/YYYY no campo).')

console.log(`contrato-recorrente: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
