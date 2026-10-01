// testes/contas-a-pagar.mts — o que a firma deve, e qual débito pagou
//
// Contas a pagar NÃO é contabilidade: o livro é por caixa e a despesa vem
// do extrato. Se a conta virasse lançamento, a mesma despesa entraria duas
// vezes. O que se testa aqui é o caixa diário: situação, atraso e qual
// débito do banco pode ser o pagamento.

import { situacaoDaConta, diasAteVencer, agingDePagar, candidatosParaConta,
         chaveDoFornecedor, camposDaConta, criticarConta } from '../lib/contas-a-pagar.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const conta = (o: any) => ({ payee: 'Fornecedor', amount: 100, due_date: '2026-10-15', ...o })
const HOJE = '2026-10-15'

// ── Situação ────────────────────────────────────────────────────────────
eq('vence hoje', situacaoDaConta(conta({}), HOJE), 'vence_hoje')
eq('a vencer', situacaoDaConta(conta({ due_date: '2026-10-20' }), HOJE), 'a_vencer')
eq('vencida', situacaoDaConta(conta({ due_date: '2026-10-14' }), HOJE), 'vencida')
// Paga com atraso NÃO volta a ser vencida — senão a lista de atrasados
// nunca esvazia e deixa de ser lida.
eq('paga com atraso continua paga',
  situacaoDaConta(conta({ due_date: '2026-09-01', status: 'paga' }), HOJE), 'paga')
eq('cancelada não cobra nada',
  situacaoDaConta(conta({ due_date: '2026-09-01', status: 'cancelada' }), HOJE), 'cancelada')

// ── Dias, com o pulo do horário de verão no meio ────────────────────────
eq('amanhã é 1', diasAteVencer('2026-10-16', HOJE), 1)
eq('ontem é -1', diasAteVencer('2026-10-14', HOJE), -1)
eq('hoje é 0', diasAteVencer(HOJE, HOJE), 0)
// 11/01/2026 é o domingo em que o relógio volta (dia de 25 horas).
eq('a volta do horário de verão não some com um dia',
  diasAteVencer('2026-11-02', '2026-10-31'), 2)
eq('e a ida também não (dia de 23 horas)',
  diasAteVencer('2026-03-09', '2026-03-07'), 2)

// ── Aging ───────────────────────────────────────────────────────────────
{
  const a = agingDePagar([
    conta({ amount: 100, due_date: '2026-10-20' }),   // a vencer
    conta({ amount: 50,  due_date: '2026-10-15' }),   // vence hoje
    conta({ amount: 200, due_date: '2026-10-01' }),   // 14 dias
    conta({ amount: 300, due_date: '2026-08-20' }),   // 56 dias
    conta({ amount: 400, due_date: '2026-06-01' }),   // 136 dias
    conta({ amount: 999, due_date: '2026-01-01', status: 'paga' }),
    conta({ amount: 888, due_date: '2026-01-01', status: 'cancelada' }),
  ], HOJE)
  eq('vence hoje conta como A VENCER', a.aVencer, 150)
  eq('até 30 dias de atraso', a.ate30, 200)
  eq('de 31 a 60', a.ate60, 300)
  eq('de 61 a 90', a.ate90, 0)
  eq('mais de 90', a.mais90, 400)
  eq('total só do que está aberto', a.total, 1050)
  eq('vencido é a soma das faixas de atraso', a.vencido, 900)
}
eq('lista vazia não estoura', agingDePagar([], HOJE).total, 0)

// ── Qual débito pagou ───────────────────────────────────────────────────
const tx = (o: any) => ({ id: 'x', tx_date: '2026-10-14', description: 'PAGAMENTO', amount: -100, ...o })
{
  const c = candidatosParaConta(conta({ payee: 'Verizon' }), [
    tx({ id: 'a', description: 'VERIZON WIRELESS', amount: -100 }),
    tx({ id: 'b', description: 'OUTRA COISA', amount: -100 }),
    tx({ id: 'c', description: 'VERIZON', amount: -99.99 }),     // centavo a menos
    tx({ id: 'd', description: 'VERIZON', amount: 100 }),        // entrada, não saída
  ])
  eq('o que parece o fornecedor vem primeiro', c[0].id, 'a')
  eq('valor diferente NÃO entra -- fechar com o débito errado é pior', c.map(x => x.id), ['a', 'b'])
  eq('entrada não é pagamento', c.some(x => x.id === 'd'), false)
}
{
  const c = candidatosParaConta(conta({}), [
    tx({ id: 'perto', tx_date: '2026-10-14' }),
    tx({ id: 'longe', tx_date: '2026-10-01' }),
  ])
  eq('sem casar o nome, o mais perto do vencimento vem primeiro', c[0].id, 'perto')
}
eq('fora da janela de 45 dias não aparece',
  candidatosParaConta(conta({}), [tx({ tx_date: '2026-07-01' })]).length, 0)
eq('débito que já pagou outra conta não aparece',
  candidatosParaConta(conta({}), [tx({ bill_id: 'outra' })]).length, 0)

// A chave do fornecedor é só para ORDENAR sugestão — não é o motor de
// classificação, que vive em três arquivos e tem de continuar idêntico.
eq('ignora acento, caixa e pontuação', chaveDoFornecedor('Açaí & Cia., Inc.'), 'acai cia inc')
eq('nulo vira vazio', chaveDoFornecedor(null), '')

// ── O que o formulário pode gravar ──────────────────────────────────────
eq('só os campos da lista',
  camposDaConta({ payee: 'X', amount: '12.5', status: 'paga', paid_tx_id: 'abc', client_id: 'z' }),
  { payee: 'X', amount: 12.5 })
eq('valor vira número com 2 casas', camposDaConta({ amount: '10.999' }).amount, 11)
eq('vazio vira nulo', camposDaConta({ payee: 'X', notes: '' }), { payee: 'X', notes: null })

// ── A crítica ───────────────────────────────────────────────────────────
eq('sem fornecedor', criticarConta({ amount: 10, due_date: '2026-10-01' }), 'Informe o fornecedor.')
eq('sem vencimento', criticarConta({ payee: 'X', amount: 10 }), 'Informe o vencimento.')
eq('vencimento torto', criticarConta({ payee: 'X', amount: 10, due_date: '15/10/2026' }),
  'Vencimento inválido (use AAAA-MM-DD).')
eq('valor zero', criticarConta({ payee: 'X', amount: 0, due_date: '2026-10-01' }),
  'Informe um valor maior que zero.')
eq('valor negativo', criticarConta({ payee: 'X', amount: -5, due_date: '2026-10-01' }),
  'Informe um valor maior que zero.')
eq('valor que não é número', criticarConta({ payee: 'X', amount: 'abc', due_date: '2026-10-01' }),
  'Informe um valor maior que zero.')
eq('vencimento antes da emissão',
  criticarConta({ payee: 'X', amount: 10, issue_date: '2026-10-10', due_date: '2026-10-01' }),
  'O vencimento não pode ser antes da emissão.')
eq('conta boa passa', criticarConta({ payee: 'X', amount: 10, due_date: '2026-10-01' }), null)
eq('emissão igual ao vencimento passa (à vista)',
  criticarConta({ payee: 'X', amount: 10, issue_date: '2026-10-01', due_date: '2026-10-01' }), null)

console.log(`contas-a-pagar: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
