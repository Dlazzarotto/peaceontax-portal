// testes/grupo-do-resultado.mts — o que entra no P&L e em que seção
//
// O P&L mostrava, no fim, "Balance Sheet / Non-P&L Items": transferências,
// pagamentos de cartão, empréstimos. Decisão do sócio: o demonstrativo é só
// RESULTADO. E uma conta do motor que faltasse no plano caía em DESPESA —
// a transferência entre contas do cliente virava gasto. Aqui: cada grupo do
// plano, as contas do motor mesmo fora do plano, a sub-conta que herda a mãe,
// a soma em centavos e uma varredura de que movimento de balanço não mexe no
// lucro.

import {
  grupoNoResultado, somarPorConta, secoesDoResultado, totaisDoResultado,
  GRUPOS_DO_RESULTADO, MOVIMENTOS_DE_BALANCO, CONTA_SEM_NOME,
} from '../lib/grupo-do-resultado.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

const plano: Record<string, string | null> = {
  'Sales': 'income', 'Materials': 'cogs', 'Rent': 'expense', 'Interest Income': 'other_income',
  'Penalties': 'other_expense', 'Checking': 'asset', 'Loan Payable': 'liability', "Owner's Draw": 'non_pnl',
  'Transfer': 'non_pnl', 'Credit Card Payment': 'non_pnl', 'Depósito de recebimentos': 'non_pnl',
  'Utilities': 'expense', 'Utilities: Electric': 'expense', 'Loans': 'liability', 'Capital': 'equity',
  'Sem grupo': null, 'Grupo vazio': '',
}

// ── O grupo de cada conta ─────────────────────────────────────────────────
eq('as cinco seções do resultado são elas mesmas',
  ['Sales', 'Materials', 'Rent', 'Interest Income', 'Penalties'].map(c => grupoNoResultado(c, plano)),
  ['income', 'cogs', 'expense', 'other_income', 'other_expense'])
eq('ativo, passivo e fora do resultado ficam fora do P&L',
  ['Checking', 'Loan Payable', "Owner's Draw"].map(c => grupoNoResultado(c, plano)), [null, null, null])
eq('grupo que não é de resultado (patrimônio) fica fora', grupoNoResultado('Capital', plano), null)
eq('conta fora do plano entra como despesa — sumir não se vê', grupoNoResultado('Conta Nova', plano), 'expense')
eq('conta do plano sem grupo também entra como despesa',
  [grupoNoResultado('Sem grupo', plano), grupoNoResultado('Grupo vazio', plano)], ['expense', 'expense'])
eq('"Other" (lançamento sem conta) fora do plano entra como despesa', grupoNoResultado(CONTA_SEM_NOME, plano), 'expense')

// ── Os movimentos do motor: fora SEMPRE ───────────────────────────────────
eq('transferência e pagamento de cartão ficam fora',
  ['Transfer', 'Credit Card Payment', 'Depósito de recebimentos'].map(c => grupoNoResultado(c, plano)), [null, null, null])
eq('…mesmo FORA do plano (antes viravam despesa)',
  MOVIMENTOS_DE_BALANCO.map(c => grupoNoResultado(c, {})), [null, null, null])
eq('…mesmo com o grupo ERRADO no plano',
  MOVIMENTOS_DE_BALANCO.map(c => grupoNoResultado(c, { [c]: 'expense' })), [null, null, null])
eq('…e com espaço em volta do nome', grupoNoResultado(' Transfer ', {}), null)
eq('só o nome exato é do motor ("Transferências" é conta de quem a criou)', grupoNoResultado('Transferências', {}), 'expense')
eq('sub-conta de movimento do motor também fica fora',
  [grupoNoResultado('Transfer: Savings', {}), grupoNoResultado('Credit Card Payment: Amex', { 'Credit Card Payment: Amex': 'expense' })], [null, null])

// ── Sub-conta ─────────────────────────────────────────────────────────────
eq('sub-conta no plano usa o próprio grupo', grupoNoResultado('Utilities: Electric', plano), 'expense')
eq('sub-conta FORA do plano segue a mãe (despesa)', grupoNoResultado('Utilities: Water', plano), 'expense')
eq('sub-conta fora do plano de mãe de BALANÇO fica fora (antes virava despesa)', grupoNoResultado('Loans: Bank X', plano), null)
eq('sub-conta sem mãe no plano entra como despesa', grupoNoResultado('Nova: Filha', plano), 'expense')
eq('nome que começa com ":" não tem mãe', grupoNoResultado(':estranha', plano), 'expense')

// ── Soma em centavos ──────────────────────────────────────────────────────
eq('0,10 + 0,20 fecha em 0,30', somarPorConta([{ category: 'Rent', amount: 0.1 }, { category: 'Rent', amount: 0.2 }]), { Rent: 0.3 })
eq('mil lançamentos de um centavo dão 10,00',
  somarPorConta(Array.from({ length: 1000 }, () => ({ category: 'Fees', amount: -0.01 }))), { Fees: -10 })
eq('valor em texto (numeric do PostgREST) soma', somarPorConta([{ category: 'Sales', amount: '1250.50' }, { category: 'Sales', amount: 49.5 }]), { Sales: 1300 })
eq('lançamento sem conta vai para "Other"', somarPorConta([{ category: null, amount: -5 }, { category: '', amount: -5 }]), { Other: -10 })
eq('valor que não é número não envenena a soma', somarPorConta([{ category: 'Rent', amount: 'x' }, { category: 'Rent', amount: -100 }]), { Rent: -100 })

// ── Seções e totais ───────────────────────────────────────────────────────
{
  const porConta = {
    'Sales': 10000, 'Materials': -2000, 'Rent': -3000, 'Utilities: Electric': -500, 'Interest Income': 25,
    'Penalties': -75, 'Transfer': -4000, 'Credit Card Payment': -1500, 'Checking': 999, 'Loan Payable': 800, 'Conta Nova': -100,
  }
  const s = secoesDoResultado(porConta, plano)
  eq('as seções levam só o que é resultado',
    GRUPOS_DO_RESULTADO.map(g => s[g].map(l => l.conta)),
    [['Sales'], ['Materials'], ['Conta Nova', 'Rent', 'Utilities: Electric'], ['Interest Income'], ['Penalties']])
  eq('nenhuma conta de balanço aparece em seção alguma',
    GRUPOS_DO_RESULTADO.flatMap(g => s[g].map(l => l.conta)).filter(c => ['Transfer', 'Credit Card Payment', 'Checking', 'Loan Payable'].includes(c)), [])
  const t = totaisDoResultado(s)
  eq('totais do demonstrativo', t, {
    receita: 10000, custo: -2000, bruto: 8000, despesa: -3600, operacional: 4400,
    outrasReceitas: 25, outrasDespesas: -75, liquido: 4350,
  })
}
eq('período sem nada: tudo zero', totaisDoResultado(secoesDoResultado({}, plano)),
  { receita: 0, custo: 0, bruto: 0, despesa: 0, operacional: 0, outrasReceitas: 0, outrasDespesas: 0, liquido: 0 })
eq('prejuízo sai negativo', totaisDoResultado(secoesDoResultado({ Sales: 100, Rent: -250.55 }, plano)).liquido, -150.55)

// ── Varredura: movimento de balanço nunca mexe no lucro ───────────────────
{
  const base = { Sales: 5000, Rent: -1200.33, Materials: -800.1 }
  const liquidoBase = totaisDoResultado(secoesDoResultado(base, plano)).liquido
  let mexeu = 0
  for (let i = 1; i <= 200; i++) {
    const v = (i % 2 ? -1 : 1) * (i * 37.13)
    for (const conta of [...MOVIMENTOS_DE_BALANCO, 'Checking', 'Loan Payable', "Owner's Draw", 'Loans: Bank X', 'Transfer: Savings']) {
      for (const p of [plano, {}]) {
        const l = totaisDoResultado(secoesDoResultado({ ...base, [conta]: v }, p)).liquido
        const esperado = p === plano || MOVIMENTOS_DE_BALANCO.includes(conta) || conta.startsWith('Transfer')
          ? liquidoBase : null
        if (esperado !== null && l !== esperado) mexeu++
      }
    }
  }
  eq('200 valores × contas de balanço × com e sem plano: o lucro não se mexe', mexeu, 0)
}

console.log(`grupo-do-resultado: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
