// testes/balanco.mts — o Balanço Patrimonial por partidas dobradas
//
// O Balanço anterior não era um balanço: o caixa vinha só do saldo corrido do
// extrato (conta do Plaid nem aparecia), o ativo somava compras do ANO em
// valor absoluto, o empréstimo ficava fora e não havia patrimônio. Aqui:
// as referências de saldo (conciliação, extrato, banco), o fim do dia com as
// linhas fora de ordem, o sentido do saldo do cartão, a transferência que
// atravessa a data, o lançamento manual, o excluído, a conta sem banco, o
// Net Income igual ao do P&L — e uma varredura aleatória de que ATIVO =
// PASSIVO + PATRIMÔNIO sempre, ao centavo.

import {
  ehCartao, sentidoDoSaldoCorrido, saldoNoFimDoDia, referenciasDaConta, escolherReferencia, referenciaPosterior,
  ladoNoBalanco, montarBalanco,
  type LancamentoDoBalanco, type ContaDoBalanco,
} from '../lib/balanco.ts'
import { somarPorConta, secoesDoResultado, totaisDoResultado } from '../lib/grupo-do-resultado.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

const plano: Record<string, string> = {
  'Donations': 'income', 'Sales': 'income', 'Rent': 'expense', 'Utilities': 'expense', 'Utilities: Electric': 'expense',
  'Materials': 'cogs', 'Interest Income': 'other_income', 'Penalties': 'other_expense',
  'Equipment': 'asset', 'Loans': 'liability', 'Loan Payable': 'liability',
  'Owner Draw': 'non_pnl', 'Owner Contribution': 'non_pnl', 'Opening Balance Equity': 'non_pnl', 'Retained Earnings': 'non_pnl',
  'Transfer': 'non_pnl', 'Credit Card Payment': 'non_pnl',
}

// ── Tipo de conta ─────────────────────────────────────────────────────────
eq('cartão: credit_card', ehCartao('credit_card'), true)
eq('cartão: credit (importação antiga do QuickBooks)', ehCartao('credit'), true)
eq('cartão: em maiúscula', ehCartao(' CREDIT '), true)
eq('conta corrente não é cartão', ehCartao('checking'), false)
eq('poupança não é cartão', ehCartao('savings'), false)
eq('tipo nulo não é cartão', ehCartao(null), false)

// ── Sentido do saldo corrido ──────────────────────────────────────────────
const corrente = [
  { tx_date: '2024-01-02', amount: 100, balance: 1100 },
  { tx_date: '2024-01-03', amount: -50, balance: 1050 },
  { tx_date: '2024-01-04', amount: 20, balance: 1070 },
]
eq('saldo corrido da conta corrente sobe com a entrada', sentidoDoSaldoCorrido(corrente, -1), 1)
const fatura = [   // saldo do cartão = dívida: a compra (negativa) AUMENTA o saldo
  { tx_date: '2024-01-02', amount: -100, balance: 600 },
  { tx_date: '2024-01-03', amount: -50, balance: 650 },
  { tx_date: '2024-01-04', amount: 200, balance: 450 },
]
eq('saldo corrido da fatura do cartão anda ao contrário', sentidoDoSaldoCorrido(fatura, 1), -1)
eq('sem votos suficientes fica o padrão do tipo', sentidoDoSaldoCorrido([{ tx_date: '2024-01-02', amount: 5, balance: 5 }], -1), -1)
eq('linhas sem saldo não votam', sentidoDoSaldoCorrido([{ tx_date: '2024-01-02', amount: 5, balance: null }, { tx_date: '2024-01-03', amount: 5, balance: null }], 1), 1)

// ── Fim do dia, com as linhas fora de ordem ───────────────────────────────
eq('uma linha no dia: o saldo dela', saldoNoFimDoDia([{ amount: -50, balance: 950 }], 1), 95000)
// Ordem real: 1000 → +200 (1200) → -50 (1150) → -30 (1120). Embaralhadas:
const dia3 = [{ amount: -50, balance: 1150 }, { amount: -30, balance: 1120 }, { amount: 200, balance: 1200 }]
eq('três linhas embaralhadas: o último saldo do dia', saldoNoFimDoDia(dia3, 1), 112000)
eq('três linhas em outra ordem: o mesmo', saldoNoFimDoDia([dia3[2], dia3[0], dia3[1]], 1), 112000)
eq('entrada e saída iguais no mesmo dia: ambíguo', saldoNoFimDoDia([{ amount: 100, balance: 1100 }, { amount: -100, balance: 1000 }], 1), null)
eq('sem saldo no dia: nada', saldoNoFimDoDia([{ amount: 10, balance: null }], 1), null)
eq('cartão (saldo = dívida): o fim do dia no sentido dele', saldoNoFimDoDia([{ amount: -100, balance: 600 }, { amount: -50, balance: 650 }], -1), 65000)

// ── Referências ───────────────────────────────────────────────────────────
{
  const refs = referenciasDaConta({
    cartao: false,
    lancamentos: [
      { tx_date: '2024-12-30', amount: 100, balance: 1100, source: 'csv' },
      { tx_date: '2024-12-31', amount: -40, balance: 1060, source: 'csv' },
      { tx_date: '2024-12-31', amount: -400, balance: 999999, source: 'manual' },   // manual não é extrato
    ],
    conciliacoes: [
      { statement_date: '2024-11-30', ending_balance: 900, status: 'completed' },
      { statement_date: '2024-12-31', ending_balance: 1060, status: 'in_progress' },
    ],
    saldoDoBanco: 2000, saldoDoBancoEm: '2025-03-01',
  })
  eq('referências: conciliação concluída, dois dias de extrato e o banco', refs.map(r => `${r.fonte}:${r.data}:${r.saldo}`).sort(),
    ['banco:2025-03-01:200000', 'conciliacao:2024-11-30:90000', 'extrato:2024-12-30:110000', 'extrato:2024-12-31:106000'])
  const cartao = referenciasDaConta({ cartao: true, lancamentos: [], saldoDoBanco: 350, saldoDoBancoEm: '2025-01-05' })
  eq('o banco informa a dívida do cartão positiva: no livro ela é negativa', cartao, [{ data: '2025-01-05', saldo: -35000, fonte: 'banco' }])
  const fat = referenciasDaConta({ cartao: true, lancamentos: fatura.map(l => ({ ...l, source: 'csv' })) })
  eq('extrato do cartão: o saldo (dívida) vira negativo no livro', fat.find(r => r.data === '2024-01-04'), { data: '2024-01-04', saldo: -45000, fonte: 'extrato' })
}
{
  const r = (data: string, fonte: 'conciliacao' | 'extrato' | 'banco') => ({ data, saldo: 1, fonte })
  // O Balanço de uma data só usa saldo DAQUELA data ou de antes: o de depois
  // (o saldo de hoje do banco) fazia o Balanço de 2025 mudar com 2026.
  eq('a referência posterior não vale, nem mais próxima', escolherReferencia([r('2024-06-30', 'extrato'), r('2025-01-02', 'banco')], '2024-12-31')?.data, '2024-06-30')
  eq('vale a mais recente até a data', escolherReferencia([r('2023-12-31', 'extrato'), r('2024-11-30', 'conciliacao'), r('2024-03-31', 'extrato')], '2024-12-31')?.data, '2024-11-30')
  eq('a da própria data vale', escolherReferencia([r('2024-12-31', 'banco')], '2024-12-31')?.data, '2024-12-31')
  eq('só referências depois da data: nenhuma', escolherReferencia([r('2025-01-01', 'extrato'), r('2026-11-25', 'banco')], '2024-12-31'), null)
  eq('a posterior mais próxima fica à parte, para a estimativa', referenciaPosterior([r('2026-11-25', 'banco'), r('2025-01-02', 'extrato'), r('2024-06-30', 'extrato')], '2024-12-31')?.data, '2025-01-02')
  eq('com referência até a data, a posterior não importa', referenciaPosterior([r('2024-06-30', 'extrato')], '2024-12-31'), null)
  eq('na mesma data, a conciliação vence o extrato', escolherReferencia([r('2024-12-31', 'extrato'), r('2024-12-31', 'conciliacao')], '2024-12-31')?.fonte, 'conciliacao')
  eq('na mesma data, o extrato vence o banco', escolherReferencia([r('2024-12-31', 'banco'), r('2024-12-31', 'extrato')], '2024-12-31')?.fonte, 'extrato')
  eq('sem referência: nada', escolherReferencia([], '2024-12-31'), null)
}

// ── Lado de cada conta do plano ───────────────────────────────────────────
eq('receita é resultado', ladoNoBalanco('Donations', plano), 'resultado')
eq('custo é resultado', ladoNoBalanco('Materials', plano), 'resultado')
eq('transferência é movimento', ladoNoBalanco('Transfer', plano), 'movimento')
eq('pagamento de cartão é movimento', ladoNoBalanco('Credit Card Payment', plano), 'movimento')
eq('transferência FORA do plano continua movimento', ladoNoBalanco('Transfer', {}), 'movimento')
eq('ativo do plano é ativo', ladoNoBalanco('Equipment', plano), 'ativo')
eq('passivo do plano é passivo', ladoNoBalanco('Loans', plano), 'passivo')
eq('sub-conta fora do plano segue a mãe passivo', ladoNoBalanco('Loans: GM Financial', plano), 'passivo')
eq('fora do resultado é patrimônio', ladoNoBalanco('Owner Draw', plano), 'patrimonio')
eq('conta fora do plano é resultado (despesa), como no P&L', ladoNoBalanco('Conta Nova', plano), 'resultado')

// ── Cenário 1: conta corrente com o saldo do banco depois da data ─────────
{
  const contas: ContaDoBalanco[] = [{ id: 'chk', name: 'Checking 8301', type: 'checking', current_balance: 5000, balance_as_of: '2025-01-10T15:00:00Z' }]
  const lancs: LancamentoDoBalanco[] = [
    { account_id: 'chk', tx_date: '2024-03-01', amount: 1000, category: 'Donations', status: 'approved', source: 'plaid' },
    { account_id: 'chk', tx_date: '2024-04-01', amount: -300, category: 'Rent', status: 'approved', source: 'plaid' },
    { account_id: 'chk', tx_date: '2024-05-01', amount: -100, category: 'Owner Draw', status: 'reviewed', source: 'plaid' },
    { account_id: 'chk', tx_date: '2024-06-01', amount: 50, category: null, status: 'pending', source: 'plaid' },
    { account_id: 'chk', tx_date: '2024-07-01', amount: -20, category: 'Utilities', status: 'auto', source: 'plaid' },
    { account_id: 'chk', tx_date: '2024-08-01', amount: -999, category: 'Rent', status: 'excluded', source: 'plaid' },
    { account_id: 'chk', tx_date: '2025-01-05', amount: 400, category: 'Donations', status: 'approved', source: 'plaid' },
  ]
  const b = montarBalanco({ contas, lancamentos: lancs, plano, corte: '2024-12-31' })
  // banco em 10/01/2025 = 5000; depois da data entrou +400 → em 31/12 = 4600
  // O banco só disse o saldo DEPOIS da data (10/01/2025): o Balanço de 31/12
  // não o usa — fica com os lançamentos do sistema até a data.
  eq('c1: sem saldo até a data, o caixa é só a soma dos lançamentos', b.bancos, [{ conta: 'Checking 8301', valor: 63000 }])
  eq('c1: a referência posterior não é usada', b.contas[0].referencia, null)
  eq('c1: ela vira só estimativa (saldo do banco menos o que entrou depois)', b.contas[0].estimativa, { saldo: 460000, referencia: { data: '2025-01-10', saldo: 500000, fonte: 'banco' } })
  // abertura = 5000 − (1000 − 300 − 100 + 50 − 20 + 400) = 3970
  eq('c1: sem referência, nada de saldo de abertura', b.composicaoDosLucros.saldoDeAbertura, 0)
  eq('c1: Retained Earnings zerado (nada antes de 2024, nada sem par)', b.lucrosAcumulados, 0)
  eq('c1: no patrimônio fica só a retirada do sócio', b.patrimonio, [{ conta: 'Owner Draw', valor: -10000 }])
  eq('c1: Net Income = só o livro aprovado do ano', b.resultadoDoExercicio, 70000)
  eq('c1: a fila (pendente e reconhecido) fica à parte', b.aguardandoRevisao, { quantidade: 2, valor: 3000 })
  eq('c1: o excluído não entra em nada', b.totais.ativo, 63000)
  eq('c1: fecha', b.fecha, true)
  // Na data em que o banco informou o saldo, ele vale (no dia do escritório)
  const noDia = montarBalanco({ contas, lancamentos: lancs, plano, corte: '2025-01-10' })
  eq('c1: na data do saldo do banco, o caixa é o do banco', noDia.bancos, [{ conta: 'Checking 8301', valor: 500000 }])
  eq('c1: e a abertura deduzida dele compõe o Retained Earnings', noDia.composicaoDosLucros.saldoDeAbertura, 397000)
  eq('c1: a referência é o banco, no dia do escritório', noDia.contas[0].referencia, { data: '2025-01-10', saldo: 500000, fonte: 'banco' })
  // O Balanço de uma data passada não muda quando o saldo de HOJE muda
  const outroDia = montarBalanco({ contas: [{ ...contas[0], current_balance: 3800 }], lancamentos: lancs, plano, corte: '2024-12-31' })
  eq('c1: o saldo de hoje mudou e o Balanço de 31/12 não', [outroDia.bancos, outroDia.totais], [b.bancos, b.totais])
  eq('c1: só a estimativa das notas acompanha', outroDia.contas[0].estimativa?.saldo, 340000)
}

// ── Cenário 2: cartão, pagamento com as duas pontas ───────────────────────
{
  const contas: ContaDoBalanco[] = [
    { id: 'chk', name: 'Checking', type: 'checking' },
    { id: 'cc', name: 'Visa 2493', type: 'credit_card' },
  ]
  const lancs: LancamentoDoBalanco[] = [
    { account_id: 'chk', tx_date: '2024-01-02', amount: 2000, category: 'Sales', status: 'approved' },
    { account_id: 'cc', tx_date: '2024-02-01', amount: -500, category: 'Utilities', status: 'approved' },
    { account_id: 'cc', tx_date: '2024-02-03', amount: -200, category: 'Rent', status: 'approved' },
    { account_id: 'chk', tx_date: '2024-03-01', amount: -600, category: 'Credit Card Payment', status: 'approved' },
    { account_id: 'cc', tx_date: '2024-03-02', amount: 600, category: 'Credit Card Payment', status: 'auto' },
  ]
  const b = montarBalanco({ contas, lancamentos: lancs, plano, corte: '2024-12-31' })
  eq('c2: o cartão é passivo (dívida positiva)', b.cartoes, [{ conta: 'Visa 2493', valor: 10000 }])
  eq('c2: a conta corrente depois de pagar o cartão', b.bancos, [{ conta: 'Checking', valor: 140000 }])
  eq('c2: o pagamento com as duas pontas não deixa transferência sem par', b.composicaoDosLucros.transferenciasSemPar, 0)
  eq('c2: a ponta "auto" do pagamento conta (regra do motor), não fica na fila', b.aguardandoRevisao.quantidade, 0)
  eq('c2: Net Income', b.resultadoDoExercicio, 130000)
  eq('c2: fecha', b.fecha, true)
}

// ── Cenário 3: transferência que atravessa a data ─────────────────────────
{
  const contas: ContaDoBalanco[] = [{ id: 'a', name: 'Checking', type: 'checking' }, { id: 's', name: 'Savings', type: 'savings' }]
  const lancs: LancamentoDoBalanco[] = [
    { account_id: 'a', tx_date: '2024-12-01', amount: 3000, category: 'Donations', status: 'approved' },
    { account_id: 'a', tx_date: '2024-12-31', amount: -500, category: 'Transfer', status: 'approved' },
    { account_id: 's', tx_date: '2025-01-02', amount: 500, category: 'Transfer', status: 'approved' },
  ]
  const em31 = montarBalanco({ contas, lancamentos: lancs, plano, corte: '2024-12-31' })
  eq('c3: em 31/12 o dinheiro saiu de uma e não chegou na outra: ponta sem par', em31.composicaoDosLucros.transferenciasSemPar, -50000)
  eq('c3: ela vai para o Retained Earnings, não para uma linha de ativo', em31.lucrosAcumulados, -50000)
  eq('c3: no ativo, só o que está nos bancos', em31.totais.ativo, 250000)
  eq('c3: em 31/12 fecha', em31.fecha, true)
  const em02 = montarBalanco({ contas, lancamentos: lancs, plano, corte: '2025-01-02' })
  eq('c3: em 02/01 chegou: nada sem par', em02.composicaoDosLucros.transferenciasSemPar, 0)
  eq('c3: em 02/01 a poupança tem o dinheiro', em02.bancos.find(l => l.conta === 'Savings')?.valor, 50000)
  eq('c3: em 02/01 o resultado do ano NOVO começa do zero', em02.resultadoDoExercicio, 0)
  eq('c3: e o de 2024 virou lucros acumulados', em02.lucrosAcumulados, 300000)
}

// ── Cenário 4: empréstimo e equipamento ───────────────────────────────────
{
  const contas: ContaDoBalanco[] = [{ id: 'a', name: 'Checking', type: 'checking' }]
  const lancs: LancamentoDoBalanco[] = [
    { account_id: 'a', tx_date: '2023-05-01', amount: 10000, category: 'Loans: GM Financial', status: 'approved' },
    { account_id: 'a', tx_date: '2023-06-01', amount: -2500, category: 'Equipment', status: 'approved' },
    { account_id: 'a', tx_date: '2024-01-15', amount: -1000, category: 'Loans: GM Financial', status: 'approved' },
    { account_id: 'a', tx_date: '2024-02-15', amount: 300, category: 'Equipment', status: 'approved' },   // vendeu parte
    { account_id: 'a', tx_date: '2024-03-15', amount: -700, category: 'Loan Payable', status: 'approved' }, // sem o saldo inicial
  ]
  const b = montarBalanco({ contas, lancamentos: lancs, plano, corte: '2024-12-31' })
  eq('c4: o empréstimo acumula desde o começo, não só o ano', b.outrosPassivos.find(l => l.conta === 'Loans: GM Financial')?.valor, 900000)
  eq('c4: pagamento de empréstimo sem o saldo inicial fica negativo (como no QuickBooks)', b.outrosPassivos.find(l => l.conta === 'Loan Payable')?.valor, -70000)
  eq('c4: vender parte do equipamento DIMINUI o ativo', b.outrosAtivos, [{ conta: 'Equipment', valor: 220000 }])
  eq('c4: fecha', b.fecha, true)
}

// ── Cenário 5: lançamento manual com referência no extrato ────────────────
{
  const contas: ContaDoBalanco[] = [{ id: 'a', name: 'Checking', type: 'checking' }]
  const lancs: LancamentoDoBalanco[] = [
    { account_id: 'a', tx_date: '2024-12-20', amount: 200, balance: 1200, category: 'Sales', status: 'approved', source: 'csv' },
    { account_id: 'a', tx_date: '2024-12-30', amount: -400, category: 'Rent', status: 'approved', source: 'manual' },  // cheque não compensado
    { account_id: 'a', tx_date: '2024-12-31', amount: -100, balance: 1100, category: 'Utilities', status: 'approved', source: 'csv' },
  ]
  const b = montarBalanco({ contas, lancamentos: lancs, plano, corte: '2024-12-31' })
  // banco em 31/12 = 1100 (o cheque ainda não passou); livro = 1100 − 400
  eq('c5: o cheque não compensado sai do caixa do livro', b.bancos, [{ conta: 'Checking', valor: 70000 }])
  eq('c5: a abertura não engole o lançamento manual', b.composicaoDosLucros.saldoDeAbertura, 100000)
  eq('c5: fecha', b.fecha, true)
}

// ── Cenário 6: conta sem banco, conta inativa, cartão importado como "credit" ──
{
  const contas: ContaDoBalanco[] = [
    { id: 'a', name: 'Checking', type: 'checking' },
    { id: 'old', name: 'Old Savings', type: 'savings' },        // inativa — mas tinha saldo na data
    { id: 'qb', name: 'Amex (3005)', type: 'credit' },           // importado do QuickBooks
  ]
  const lancs: LancamentoDoBalanco[] = [
    { account_id: 'old', tx_date: '2024-02-01', amount: 800, category: 'Donations', status: 'approved' },
    { account_id: null, tx_date: '2024-03-01', amount: -60, category: 'Rent', status: 'approved' },
    { account_id: 'qb', tx_date: '2024-04-01', amount: -250, category: 'Utilities', status: 'approved' },
  ]
  const b = montarBalanco({ contas, lancamentos: lancs, plano, corte: '2024-12-31' })
  eq('c6: a conta inativa com saldo na data aparece', b.bancos, [{ conta: 'Old Savings', valor: 80000 }])
  eq('c6: o lançamento sem conta bancária não some', b.semConta, { quantidade: 1, valor: -6000 })
  eq('c6: o cartão gravado como "credit" é passivo, não dinheiro', b.cartoes, [{ conta: 'Amex (3005)', valor: 25000 }])
  eq('c6: fecha', b.fecha, true)
}

// ── Cenário 7: histórico do QuickBooks com Opening Balance Equity e Retained Earnings no plano ──
{
  const contas: ContaDoBalanco[] = [{ id: 'a', name: 'Business Adv Relationship - 8301 - 1', type: 'checking' }]
  const lancs: LancamentoDoBalanco[] = [
    { account_id: 'a', tx_date: '2023-01-01', amount: 5000, balance: 5000, category: 'Opening Balance Equity', status: 'approved', source: 'quickbooks' },
    { account_id: 'a', tx_date: '2023-06-01', amount: 1000, balance: 6000, category: 'Donations', status: 'approved', source: 'quickbooks' },
    { account_id: 'a', tx_date: '2024-01-02', amount: -250, balance: 5750, category: 'Retained Earnings', status: 'approved', source: 'quickbooks' },
  ]
  const b = montarBalanco({ contas, lancamentos: lancs, plano, corte: '2024-12-31' })
  eq('c7: o saldo corrido do QuickBooks dá abertura zero (o lançamento de abertura já está no livro)', b.contas[0].abertura, 0)
  eq('c7: a conta Opening Balance Equity do plano sai do patrimônio', b.patrimonio, [])
  eq('c7: e entra no saldo de abertura do Retained Earnings', b.composicaoDosLucros, { resultadoAnterior: 100000, contaDoPlano: -25000, saldoDeAbertura: 500000, transferenciasSemPar: 0 })
  eq('c7: Retained Earnings = 1.000 de 2023 − 250 da conta do plano + 5.000 de abertura', b.lucrosAcumulados, 575000)
  eq('c7: fecha', b.fecha, true)
}

// ── Cenário 8: conciliação vence o extrato na mesma data ──────────────────
{
  const contas: ContaDoBalanco[] = [{ id: 'a', name: 'Checking', type: 'checking' }]
  const lancs: LancamentoDoBalanco[] = [
    { account_id: 'a', tx_date: '2024-12-31', amount: 100, balance: 9999, category: 'Sales', status: 'approved', source: 'pdf' },
  ]
  const b = montarBalanco({
    contas, lancamentos: lancs, plano, corte: '2024-12-31',
    conciliacoes: [{ account_id: 'a', statement_date: '2024-12-31', ending_balance: 1500, status: 'completed' }],
  })
  eq('c8: o saldo da conciliação concluída manda', b.bancos, [{ conta: 'Checking', valor: 150000 }])
  eq('c8: fonte conciliação', b.contas[0].referencia?.fonte, 'conciliacao')
}

// ── O Net Income do Balanço é o do P&L do mesmo período ───────────────────
{
  const contas: ContaDoBalanco[] = [{ id: 'a', name: 'Checking', type: 'checking' }]
  const lancs: LancamentoDoBalanco[] = [
    { account_id: 'a', tx_date: '2024-02-01', amount: 1234.56, category: 'Sales', status: 'approved' },
    { account_id: 'a', tx_date: '2024-03-01', amount: -100.1, category: 'Materials', status: 'approved' },
    { account_id: 'a', tx_date: '2024-04-01', amount: -0.2, category: 'Conta Nova', status: 'approved' },
    { account_id: 'a', tx_date: '2024-05-01', amount: 7.77, category: 'Interest Income', status: 'reviewed' },
    { account_id: 'a', tx_date: '2024-06-01', amount: -3.33, category: 'Penalties', status: 'approved' },
    { account_id: 'a', tx_date: '2024-07-01', amount: -45, category: null, status: 'approved' },
    { account_id: 'a', tx_date: '2024-08-01', amount: -50, category: 'Transfer', status: 'approved' },
    { account_id: 'a', tx_date: '2024-09-01', amount: -60, category: 'Owner Draw', status: 'approved' },
  ]
  const b = montarBalanco({ contas, lancamentos: lancs, plano, corte: '2024-09-30' })
  const doLivro = lancs.filter(l => l.status === 'approved' || l.status === 'reviewed').map(l => ({ category: l.category, amount: l.amount as number }))
  const pnl = totaisDoResultado(secoesDoResultado(somarPorConta(doLivro), plano))
  eq('Net Income do Balanço = NET INCOME do P&L (ao centavo)', b.resultadoDoExercicio, Math.round(pnl.liquido * 100))
}

// ── Varredura: o Balanço fecha SEMPRE ─────────────────────────────────────
{
  let semente = 20261125
  const sorte = () => { semente = (semente * 1103515245 + 12345) % 2147483648; return semente / 2147483648 }
  const escolha = <T,>(xs: readonly T[]) => xs[Math.floor(sorte() * xs.length)]
  const categorias = [...Object.keys(plano), 'Conta Nova', null, 'Loans: Banco X', 'Utilities: Gas']
  const status = ['approved', 'reviewed', 'pending', 'auto', 'excluded']
  const origens = ['plaid', 'csv', 'manual', 'quickbooks', 'recebimento', null]
  let falhas = 0
  for (let rodada = 0; rodada < 300; rodada++) {
    const contas: ContaDoBalanco[] = [
      { id: 'a', name: 'A', type: 'checking', current_balance: sorte() < 0.5 ? Math.round(sorte() * 1e6) / 100 : null, balance_as_of: '2025-06-01T12:00:00Z' },
      { id: 'b', name: 'B', type: escolha(['savings', 'credit_card', 'credit']), current_balance: sorte() < 0.5 ? Math.round(sorte() * 1e5) / 100 : null, balance_as_of: '2024-09-30T23:00:00Z' },
    ]
    const lancs: LancamentoDoBalanco[] = []
    const n = Math.floor(sorte() * 60)
    for (let i = 0; i < n; i++) {
      const m = 1 + Math.floor(sorte() * 12), d = 1 + Math.floor(sorte() * 28)
      lancs.push({
        account_id: escolha(['a', 'b', 'b', 'a', null, 'sumiu']),
        tx_date: `${escolha([2023, 2024, 2025])}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        amount: Math.round((sorte() - 0.5) * 2e5) / 100,
        balance: sorte() < 0.3 ? Math.round((sorte() - 0.3) * 1e6) / 100 : null,
        category: escolha(categorias), status: escolha(status), source: escolha(origens),
      })
    }
    const conc = sorte() < 0.3 ? [{ account_id: 'a', statement_date: '2024-06-30', ending_balance: Math.round(sorte() * 1e5) / 100, status: 'completed' }] : []
    const corte = escolha(['2023-12-31', '2024-06-30', '2024-12-31', '2025-03-15'])
    const b = montarBalanco({ contas, lancamentos: lancs, plano, corte, conciliacoes: conc })
    if (!b.fecha || b.totais.ativo !== b.totais.passivoEPatrimonio) falhas++
  }
  eq('varredura: 300 livros aleatórios, todos fecham ao centavo', falhas, 0)
}

// ── Retained Earnings = as quatro partes, em qualquer livro ───────────────
{
  const contas: ContaDoBalanco[] = [
    { id: 'a', name: 'Checking', type: 'checking', current_balance: 9000, balance_as_of: '2025-06-01T12:00:00Z' },
    { id: 'b', name: 'Savings', type: 'savings' },
  ]
  const lancs: LancamentoDoBalanco[] = [
    { account_id: 'a', tx_date: '2023-05-01', amount: 4000, category: 'Sales', status: 'approved' },
    { account_id: 'a', tx_date: '2024-05-01', amount: -1500, category: 'Rent', status: 'approved' },
    { account_id: 'a', tx_date: '2024-06-01', amount: 700, category: 'Opening Balance Equity', status: 'approved' },
    { account_id: 'a', tx_date: '2024-07-01', amount: -300, category: 'Retained Earnings', status: 'approved' },
    { account_id: 'a', tx_date: '2024-12-31', amount: -2000, category: 'Transfer', status: 'approved' },
    { account_id: 'b', tx_date: '2025-01-03', amount: 2000, category: 'Transfer', status: 'approved' },
  ]
  const b = montarBalanco({ contas, lancamentos: lancs, plano, corte: '2024-12-31' })
  const k = b.composicaoDosLucros
  eq('quatro partes: resultado anterior (2023)', k.resultadoAnterior, 400000)
  eq('quatro partes: conta do plano', k.contaDoPlano, -30000)
  eq('quatro partes: transferência sem par', k.transferenciasSemPar, -200000)
  // O saldo do banco é de 01/06/2025, depois da data: não entra; fica a conta OBE do plano (700)
  eq('quatro partes: saldo de abertura (só a conta do plano: o banco é de depois)', k.saldoDeAbertura, 70000)
  const comConciliacao = montarBalanco({ contas, lancamentos: lancs, plano, corte: '2024-12-31',
    conciliacoes: [{ account_id: 'a', statement_date: '2024-12-31', ending_balance: 9000, status: 'completed' }] })
  // conciliação em 31/12 = 9000; lançamentos do banco até lá = 4000−1500+700−300−2000 = 900 → abertura 8100; + 700 da conta OBE
  eq('quatro partes: com a conciliação de 31/12, a abertura deduzida entra', comConciliacao.composicaoDosLucros.saldoDeAbertura, 880000)
  eq('quatro partes: e o caixa é o da conciliação', comConciliacao.bancos, [{ conta: 'Checking', valor: 900000 }])
  eq('quatro partes: fecha com a conciliação', comConciliacao.fecha, true)
  eq('o Retained Earnings é a soma das quatro', b.lucrosAcumulados, k.resultadoAnterior + k.contaDoPlano + k.saldoDeAbertura + k.transferenciasSemPar)
  eq('e o Balanço fecha', b.fecha, true)
}

console.log(`balanco: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
