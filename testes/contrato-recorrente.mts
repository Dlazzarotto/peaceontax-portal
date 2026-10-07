// testes/contrato-recorrente.mts — a agenda do contrato recorrente
//
// A conta vivia na rota, sem teste, e errava em dois pontos que só
// apareceriam meses depois: somava UM mês qualquer que fosse o intervalo
// (trimestral cobrando todo mês) e usava o dia do SERVIDOR em UTC, não o do
// escritório. Como ainda não há quem cobre por essa data, o erro era mudo.

import {
  primeiraCobranca, proximaCobranca, situacaoDoContrato, mudancasDoContrato,
  diaValido, ehIntervalo, MESES_DO_INTERVALO, DIA_MAXIMO,
  montarContrato, resumoDosItens, vencimentoDaCobranca, prazoValido, PRAZO_MAXIMO,
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

// ── o que mudou de verdade (so os campos ESCALARES) ─────────────────
// `amount` e `description` NAO entram aqui: sao DERIVADOS das linhas.
// Aceitar os dois caminhos deixaria o cabecalho discordar dos itens no
// primeiro item acrescentado -- o defeito que a impressao de fatura ja teve.
const antes = {
  description: 'Bookkeeping mensal', amount: 350, discount: 0, due_days: 0,
  interval: 'monthly', day_of_month: 10, start_date: '2026-01-01', auto_charge: false,
}
eq('nada enviado, nada muda', mudancasDoContrato(antes, {}), { campos: [], update: {} })
eq('valor NAO e editavel direto -- vem dos itens',
   mudancasDoContrato(antes, { amount: 999 }), { campos: [], update: {} })
eq('descricao NAO e editavel direto -- vem dos itens',
   mudancasDoContrato(antes, { description: 'outra coisa' }), { campos: [], update: {} })
eq('dia muda e e limitado', mudancasDoContrato(antes, { dayOfMonth: 99 }),
   { campos: ['dayOfMonth'], update: { day_of_month: 28 } })
eq('mesmo dia nao vira mudanca', mudancasDoContrato(antes, { dayOfMonth: 10 }), { campos: [], update: {} })
eq('intervalo muda', mudancasDoContrato(antes, { interval: 'quarterly' }),
   { campos: ['interval'], update: { interval: 'quarterly' } })
eq('auto_charge muda', mudancasDoContrato(antes, { autoCharge: true }),
   { campos: ['autoCharge'], update: { auto_charge: true } })

// Corpo de requisicao NUNCA vai inteiro para o banco: campo fora da lista
// nao entra, nem mesmo client_id ou active.
eq('campo fora da lista nao entra', mudancasDoContrato(antes, { client_id: 'outro', active: true } as any),
   { campos: [], update: {} })

// As armadilhas da comparacao: cada uma marcaria "mudou" sem nada ter
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

// Campo de data VAZIO e "nao mexi nisso", nao "data invalida". Contrato
// antigo pode estar sem start_date: o formulario manda '' e, recusando, quem
// so queria trocar o DIA levava um erro falando de data.
eq('data vazia nao e recusa', mudancasDoContrato(antes, { startDate: '' }), { campos: [], update: {} })
eq('data vazia nao impede o resto', mudancasDoContrato(antes, { startDate: '', dayOfMonth: 20 }),
   { campos: ['dayOfMonth'], update: { day_of_month: 20 } })
eq('data so com espacos nao e recusa', mudancasDoContrato(antes, { startDate: '   ' }), { campos: [], update: {} })
eq('contrato sem start_date edita o dia normalmente',
   mudancasDoContrato({ ...antes, start_date: null }, { startDate: '', dayOfMonth: 20 }),
   { campos: ['dayOfMonth'], update: { day_of_month: 20 } })

// Recusas
eq('intervalo invalido recusa', mudancasDoContrato(antes, { interval: 'semanal' }).erro, 'Intervalo inválido.')
eq('data invalida recusa', mudancasDoContrato(antes, { startDate: '05/03/2026' }).erro,
   'Data de início inválida (use MM/DD/YYYY no campo).')

// ── vencimento: prazo em DIAS, nao em dia do mes ─────────────────────
// "Emite no dia 1 e vence no dia 10" desmonta quando a emissao e no dia 25:
// o vencimento cairia ANTES da emissao.
eq('vence no mesmo dia com prazo zero', vencimentoDaCobranca('2026-03-10', 0), '2026-03-10')
eq('Net 15', vencimentoDaCobranca('2026-03-10', 15), '2026-03-25')
eq('Net 15 atravessa o mes', vencimentoDaCobranca('2026-03-25', 15), '2026-04-09')
eq('Net 30 atravessa o ano', vencimentoDaCobranca('2026-12-20', 30), '2027-01-19')
eq('fevereiro de ano bissexto', vencimentoDaCobranca('2024-02-20', 10), '2024-03-01')
eq('fevereiro de ano comum', vencimentoDaCobranca('2026-02-20', 10), '2026-03-02')
// Meio-dia UTC: somar dias em cima da meia-noite escorrega um dia nas
// viradas do horario de verao (domingos de 23 e de 25 horas).
eq('virada do horario de verao (marco)', vencimentoDaCobranca('2026-03-07', 2), '2026-03-09')
eq('virada do horario de verao (novembro)', vencimentoDaCobranca('2026-10-31', 2), '2026-11-02')
eq('prazo negativo vira zero', prazoValido(-5), 0)
eq('prazo acima do teto e limitado', prazoValido(5000), PRAZO_MAXIMO)
eq('prazo em texto', prazoValido('30'), 30)
eq('prazo invalido vira zero', prazoValido('abc'), 0)
eq('data invalida devolve o que veio', vencimentoDaCobranca('nao-e-data', 10), 'nao-e-data')

// ── resumo: a coluna Servico e DERIVADA ──────────────────────────────
// Um rotulo digitado a parte divergiria das linhas no primeiro item novo.
eq('um item', resumoDosItens([{ description: 'Bookkeeping', quantity: 1, unit_price: 350 }]), 'Bookkeeping')
eq('dois itens', resumoDosItens([
  { description: 'Bookkeeping', quantity: 1, unit_price: 350 },
  { description: 'Payroll', quantity: 1, unit_price: 120 }]), 'Bookkeeping + Payroll')
eq('mais de tres resume', resumoDosItens([
  { description: 'A', quantity: 1, unit_price: 1 }, { description: 'B', quantity: 1, unit_price: 1 },
  { description: 'C', quantity: 1, unit_price: 1 }, { description: 'D', quantity: 1, unit_price: 1 },
  { description: 'E', quantity: 1, unit_price: 1 }]), 'A + B + C +2')
eq('sem item nenhum nao quebra', resumoDosItens([]), 'Serviço')

// ── a conta do contrato ──────────────────────────────────────────────
const itens2 = [
  { description: 'Bookkeeping mensal', quantity: 1, unit_price: 350 },
  { description: 'Payroll', quantity: 1, unit_price: 120 },
]
eq('soma simples', montarContrato({ itens: itens2, desconto: 0 }),
   { itens: itens2, bruto: 470, desconto: 0, total: 470, resumo: 'Bookkeeping mensal + Payroll' })
eq('com desconto em dolar', (montarContrato({ itens: itens2, desconto: 50 }) as any).total, 420)
// Desconto QUEBRADO e o caso que originou a regra do dolar no parcelamento:
// $37 em $470 e 7,8723...%, e ninguem digita isso.
eq('desconto quebrado fecha no centavo', (montarContrato({ itens: itens2, desconto: 37 }) as any).total, 433)
eq('quantidade fracionaria (meia hora)',
   (montarContrato({ itens: [{ description: 'Consultoria', quantity: 1.5, unit_price: 200 }] }) as any).total, 300)
eq('centavos nao escorregam',
   (montarContrato({ itens: [{ description: 'X', quantity: 3, unit_price: 33.33 }] }) as any).total, 99.99)
eq('aceita unitPrice em camelCase, como a tela manda',
   (montarContrato({ itens: [{ description: 'X', quantity: 2, unitPrice: 10 }] }) as any).total, 20)

// Linha inteiramente vazia e o campo em branco que todo formulario deixa
// sobrando -- some sem reclamar.
eq('linha vazia some', (montarContrato({ itens: [...itens2, { description: '', quantity: 1, unit_price: 0 }] }) as any).itens.length, 2)
eq('so linhas vazias e recusa',
   (montarContrato({ itens: [{ description: '', quantity: 1, unit_price: 0 }] }) as any).erro,
   'O contrato precisa de pelo menos um item.')
eq('lista ausente e recusa', (montarContrato({}) as any).erro, 'O contrato precisa de pelo menos um item.')

// Linha com PRECO e sem nome NAO some: e dinheiro sem justificativa, e o
// cliente recebe a conta.
eq('preco sem nome recusa',
   (montarContrato({ itens: [...itens2, { description: '  ', quantity: 1, unit_price: 90 }] }) as any).erro,
   'Há uma linha com valor e sem descrição. Diga o que é, ou apague a linha.')

eq('quantidade zero recusa',
   (montarContrato({ itens: [{ description: 'X', quantity: 0, unit_price: 10 }] }) as any).erro,
   'Quantidade inválida em "X".')
eq('quantidade negativa recusa',
   (montarContrato({ itens: [{ description: 'X', quantity: -1, unit_price: 10 }] }) as any).erro,
   'Quantidade inválida em "X".')
eq('preco negativo recusa e aponta o campo certo',
   (montarContrato({ itens: [{ description: 'X', quantity: 1, unit_price: -10 }] }) as any).erro,
   'Preço negativo em "X" — desconto é o campo de baixo.')

// Desconto maior que a soma viraria contrato com valor NEGATIVO -- a firma
// pagando o cliente todo mes.
eq('desconto maior que a soma recusa',
   (montarContrato({ itens: itens2, desconto: 500 }) as any).erro,
   'O desconto (500.00) é maior que a soma dos itens (470.00).')
eq('desconto igual a soma recusa (contrato de zero nao e contrato)',
   (montarContrato({ itens: itens2, desconto: 470 }) as any).erro,
   'O contrato ficaria em zero. Um acordo que não cobra nada não é contrato — apague-o ou ajuste o desconto.')
eq('desconto negativo vira zero, nao acrescimo',
   (montarContrato({ itens: itens2, desconto: -100 }) as any).total, 470)

console.log(`contrato-recorrente: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
