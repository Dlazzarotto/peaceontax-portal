// testes/fluxo-de-caixa.mts — o caixa realizado e o projetado
//
// Dois erros aqui custam dinheiro de verdade, e os dois são de SOMA:
//   · contar o depósito duas vezes (no crédito do extrato E no recebimento
//     da conta de passagem) mostra um caixa que não existe;
//   · projetar a fatura vencida como se fosse entrada faz a firma contar
//     com o dinheiro que justamente não está vindo.
// Por isso a conta é testada, e não conferida lendo.

import { ehDoExtrato, movimentoDeBanco, fluxoRealizado, saldoEmConta,
         diasAte, faixaDoVencimento, projetarCaixa,
         ORIGENS_DE_PASSAGEM } from '../lib/fluxo-de-caixa.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const HOJE = '2026-10-15'
const tx = (o: any) => ({ id: o.id || Math.random().toString(36).slice(2),
                          tx_date: '2026-10-01', amount: 0, source: 'plaid', ...o })

// ── Extrato × conta de passagem ─────────────────────────────────────────
eq('plaid é extrato', ehDoExtrato({ source: 'plaid' }), true)
eq('csv é extrato', ehDoExtrato({ source: 'csv' }), true)
eq('manual é extrato', ehDoExtrato({ source: 'manual' }), true)
eq('sem origem conta como extrato', ehDoExtrato({ source: null }), true)
for (const o of ORIGENS_DE_PASSAGEM)
  eq(`${o} é passagem`, ehDoExtrato({ source: o }), false)

// O caso que motivou tudo: o cheque recebido e ainda não depositado.
// O `recebimento` está no livro (a receita é bruta, pelo 1099-K) mas o
// dinheiro não entrou em conta nenhuma.
{
  const livro = [
    tx({ id: 'r1', source: 'recebimento', amount: 1000, tx_date: '2026-10-02' }),
    tx({ id: 'b1', source: 'plaid', amount: -250, tx_date: '2026-10-03' }),
  ]
  eq('recebimento não depositado fica fora do caixa',
    fluxoRealizado(livro).liquido, -250)
}

// O depósito conciliado: três linhas da passagem + o crédito do extrato.
// Só o crédito é caixa; somar tudo contaria $970 duas vezes.
{
  const livro = [
    tx({ id: 'r1', source: 'recebimento', amount: 600 }),
    tx({ id: 'r2', source: 'recebimento', amount: 400 }),
    tx({ id: 'p1', source: 'deposito', amount: -970, transfer_match_id: 'b1' }),
    tx({ id: 'p2', source: 'taxa', amount: -30 }),
    tx({ id: 'b1', source: 'plaid', amount: 970, transfer_match_id: 'p1' }),
  ]
  const f = fluxoRealizado(livro)
  eq('o depósito conciliado entra UMA vez', f.entradas, 970)
  eq('e nada sai por conta dele', f.saidas, 0)
  eq('líquido do depósito', f.liquido, 970)
  eq('só um lançamento de caixa', f.lancamentos, 1)
}

// Transferência entre contas da PRÓPRIA firma: as duas pernas são extrato,
// o par sai inteiro. O líquido já daria zero — o que esta regra protege são
// as colunas de entradas e saídas, que é por onde se olha o gasto do mês.
{
  const livro = [
    tx({ id: 'a', source: 'plaid', amount: -10000, transfer_match_id: 'b' }),
    tx({ id: 'b', source: 'plaid', amount: 10000, transfer_match_id: 'a' }),
    tx({ id: 'c', source: 'plaid', amount: -300 }),
  ]
  const f = fluxoRealizado(livro)
  eq('transferência interna não incha as entradas', f.entradas, 0)
  eq('nem as saídas', f.saidas, 300)
  eq('líquido só o gasto real', f.liquido, -300)
}

// E o inverso, que é o erro fácil: o crédito do depósito TAMBÉM tem
// transfer_match_id, mas apontando para a passagem. Cortar por "tem
// transfer_match_id" apagaria a entrada de dinheiro.
{
  const livro = [
    tx({ id: 'p1', source: 'deposito', amount: -500, transfer_match_id: 'b1' }),
    tx({ id: 'b1', source: 'plaid', amount: 500, transfer_match_id: 'p1' }),
  ]
  eq('o crédito do depósito não é transferência interna',
    movimentoDeBanco(livro).map(t => t.id), ['b1'])
}

// Par quebrado: a outra perna foi apagada. Sem o par, não há o que cancelar.
{
  const livro = [tx({ id: 'a', source: 'plaid', amount: -100, transfer_match_id: 'sumiu' })]
  eq('perna órfã continua contando', fluxoRealizado(livro).saidas, 100)
}

// ── Classificação não é condição ────────────────────────────────────────
// O P&L espera `approved`; o caixa não. O débito saiu da conta mesmo sem
// ninguém ter dito em que categoria ele entra.
{
  const livro = [
    tx({ id: 'a', source: 'plaid', amount: -4000, status: 'pending', category: null }),
    tx({ id: 'b', source: 'plaid', amount: 1200, status: 'auto' }),
  ]
  eq('lançamento sem classificação entra no caixa', fluxoRealizado(livro).liquido, -2800)
}

// ── Agrupamento por mês ─────────────────────────────────────────────────
{
  const livro = [
    tx({ source: 'plaid', amount: 1000, tx_date: '2026-08-10' }),
    tx({ source: 'plaid', amount: -400, tx_date: '2026-08-20' }),
    tx({ source: 'plaid', amount: -900, tx_date: '2026-09-05' }),
    tx({ source: 'plaid', amount: 2000, tx_date: '2026-10-01' }),
  ]
  const f = fluxoRealizado(livro)
  eq('três meses', f.meses.map(m => m.mes), ['2026-08', '2026-09', '2026-10'])
  eq('agosto', f.meses[0], { mes: '2026-08', entradas: 1000, saidas: 400, liquido: 600 })
  eq('setembro', f.meses[1], { mes: '2026-09', entradas: 0, saidas: 900, liquido: -900 })
  eq('total de entradas', f.entradas, 3000)
  eq('total de saídas', f.saidas, 1300)
  eq('líquido', f.liquido, 1700)
  // Média dos meses COM movimento. Inventar meses zerados num extrato que
  // começa no meio do ano derrubaria a média e mentiria sobre o gasto.
  eq('média dos meses com movimento', f.mediaLiquida, round(1700 / 3))
  // Janela inclusiva nos dois lados
  eq('janela corta o começo', fluxoRealizado(livro, '2026-09-01').liquido, 1100)
  eq('janela corta o fim', fluxoRealizado(livro, null, '2026-09-30').liquido, -300)
  eq('janela de um dia só', fluxoRealizado(livro, '2026-08-10', '2026-08-10').liquido, 1000)
}
function round(n: number) { return Math.round(n * 100) / 100 }

eq('livro vazio não quebra', fluxoRealizado([]),
  { meses: [], entradas: 0, saidas: 0, liquido: 0, mediaLiquida: 0, lancamentos: 0 })

// ── Saldo em conta ──────────────────────────────────────────────────────
{
  const contas = [{ id: 'c1', name: 'Checking', type: 'depository' },
                  { id: 'c2', name: 'Savings', type: 'depository' },
                  { id: 'cc', name: 'Amex', type: 'credit_card' }]
  const livro = [
    tx({ account_id: 'c1', tx_date: '2026-09-30', balance: 5000 }),
    tx({ account_id: 'c1', tx_date: '2026-10-05', balance: 7200.5 }),
    tx({ account_id: 'c1', tx_date: '2026-10-02', balance: 1 }),   // mais antigo
    tx({ account_id: 'c2', tx_date: '2026-10-01', balance: 300 }),
    tx({ account_id: 'cc', tx_date: '2026-10-06', balance: 9000 }),  // DÍVIDA
  ]
  const s = saldoEmConta(contas, livro)
  eq('pega o balance mais recente do extrato',
    s.contas[0], { id: 'c1', nome: 'Checking', saldo: 7200.5, em: '2026-10-05', fonte: 'extrato' })
  eq('cartão de crédito fica de fora', s.contas.length, 2)
  eq('soma só as contas em dinheiro', s.total, 7500.5)
}

// O saldo do BANCO vence o saldo corrido do extrato — e essa ordem é o que
// faz a projeção funcionar para quem conecta o Plaid: o /transactions/sync
// não traz saldo nenhum, então sem isto o saldo seria sempre desconhecido.
{
  const contas = [{ id: 'c1', name: 'Checking', type: 'depository',
                    current_balance: 8300.25, balance_as_of: '2026-10-15T14:02:00Z' }]
  const livro = [tx({ account_id: 'c1', tx_date: '2026-09-20', balance: 1000 })]
  const s = saldoEmConta(contas, livro)
  eq('o banco vence o extrato', s.contas[0].saldo, 8300.25)
  eq('e a fonte é dita', s.contas[0].fonte, 'banco')
  eq('com a data em que foi lido', s.contas[0].em, '2026-10-15')
}
// Saldo zero informado pelo banco é um SALDO, não "sem saldo". A conta
// zerada é informação; tratá-la como desconhecida esconderia o aperto.
{
  const s = saldoEmConta([{ id: 'c1', name: 'Checking', type: 'depository', current_balance: 0 }], [])
  eq('zero do banco é saldo', s.contas[0].saldo, 0)
  eq('e não entra em semSaldo', s.semSaldo, [])
  eq('total é zero, não null', s.total, 0)
}
// Saldo negativo informado pelo banco passa como está — conta no vermelho
// existe, e é justamente o caso em que o fluxo precisa estar certo.
{
  const s = saldoEmConta([{ id: 'c1', name: 'Checking', type: 'depository', current_balance: -412.3 }], [])
  eq('negativo do banco passa', s.total, -412.3)
}
// Sem saldo do banco, cai no extrato. Esse é o caminho de quem importa CSV.
{
  const contas = [{ id: 'c1', name: 'Checking', type: 'depository', current_balance: null }]
  const s = saldoEmConta(contas, [tx({ account_id: 'c1', tx_date: '2026-09-20', balance: 1000 })])
  eq('sem o banco, vale o extrato', s.contas[0].saldo, 1000)
  eq('e a fonte diz de onde veio', s.contas[0].fonte, 'extrato')
}
// Saldo desconhecido NÃO é zero: zero, na tela, é uma afirmação.
{
  const s = saldoEmConta([{ id: 'c1', name: 'Checking', type: 'depository' }], [])
  eq('conta sem balance devolve null', s.contas[0].saldo, null)
  eq('e sem fonte', s.contas[0].fonte, null)
  eq('e o total também', s.total, null)
  eq('e ela é nomeada', s.semSaldo, ['Checking'])
}
{
  // Uma com saldo e outra sem: o total existe, mas a que falta é dita.
  const s = saldoEmConta(
    [{ id: 'c1', name: 'Checking', type: 'depository' }, { id: 'c2', name: 'Savings', type: 'depository' }],
    [tx({ account_id: 'c1', tx_date: '2026-10-01', balance: 100 })])
  eq('total parcial', s.total, 100)
  eq('a conta sem saldo aparece', s.semSaldo, ['Savings'])
}
eq('sem conta nenhuma o total é null', saldoEmConta([], []).total, null)

// ── Faixas de vencimento ────────────────────────────────────────────────
eq('ontem é vencido', faixaDoVencimento('2026-10-14', HOJE), 'vencido')
eq('hoje ainda dá para pagar', faixaDoVencimento('2026-10-15', HOJE), 'd7')
eq('sétimo dia', faixaDoVencimento('2026-10-22', HOJE), 'd7')
eq('oitavo dia', faixaDoVencimento('2026-10-23', HOJE), 'd30')
eq('trigésimo', faixaDoVencimento('2026-11-14', HOJE), 'd30')
eq('trigésimo primeiro', faixaDoVencimento('2026-11-15', HOJE), 'd60')
eq('sexagésimo', faixaDoVencimento('2026-12-14', HOJE), 'd60')
eq('além', faixaDoVencimento('2026-12-15', HOJE), 'd60mais')
// Sem data não se cobra nem se paga hoje: vai para o fim, não para o começo.
eq('sem vencimento vai para o fim', faixaDoVencimento(null, HOJE), 'd60mais')

// O pulo do horário de verão (1º de novembro de 2026 nos EUA): o dia de 25
// horas não pode fazer um vencimento mudar de faixa.
eq('dia 1 atravessando o verão', diasAte('2026-11-02', '2026-10-31'), 2)
eq('e na volta', diasAte('2026-10-31', '2026-11-02'), -2)
eq('março, o dia de 23 horas', diasAte('2026-03-09', '2026-03-07'), 2)

// ── Projeção ────────────────────────────────────────────────────────────
const fatura = (o: any) => ({ total: 1000, paid_total: 0, due_date: '2026-10-20', ...o })
const conta = (o: any) => ({ amount: 500, due_date: '2026-10-20', status: 'aberta', ...o })

{
  const p = projetarCaixa({ saldoInicial: 10000, hoje: HOJE,
    faturas: [fatura({ due_date: '2026-10-18' }), fatura({ due_date: '2026-11-20', total: 2000 })],
    contas: [conta({ due_date: '2026-10-17' }), conta({ due_date: '2026-12-30', amount: 800 })] })
  eq('receber projetado', p.receber, 3000)
  eq('pagar projetado', p.pagar, 1300)
  eq('saldo final', p.saldoFinal, 11700)
  eq('acumulado por faixa', p.linhas.map(l => l.saldo), [10000, 10500, 10500, 12500, 11700])
  eq('sem aperto, sem alerta', p.alerta, null)
}

// A decisão que mais importa: fatura VENCIDA fica fora da projeção.
{
  const p = projetarCaixa({ saldoInicial: 1000, hoje: HOJE,
    faturas: [fatura({ due_date: '2026-08-01', total: 50000 })],
    contas: [] })
  eq('vencido não entra no receber', p.receber, 0)
  eq('vencido é mostrado à parte', p.receberVencido, 50000)
  eq('e não infla o saldo', p.saldoFinal, 1000)
  eq('a faixa vencido fica zerada no receber', p.linhas[0].receber, 0)
}

// Conta a pagar vencida, ao contrário, ENTRA — e na primeira faixa.
{
  const p = projetarCaixa({ saldoInicial: 1000, hoje: HOJE,
    faturas: [], contas: [conta({ due_date: '2026-07-01', amount: 400 })] })
  eq('conta vencida entra na faixa vencido', p.linhas[0].pagar, 400)
  eq('e derruba o saldo já na primeira linha', p.linhas[0].saldo, 600)
  eq('total a pagar', p.pagar, 400)
}

// O aperto: o alerta diz ONDE e QUANTO falta, e ressalva o vencido.
{
  const p = projetarCaixa({ saldoInicial: 500, hoje: HOJE,
    faturas: [fatura({ due_date: '2026-09-01', total: 9000 })],
    contas: [conta({ due_date: '2026-10-18', amount: 2000 })] })
  eq('o fundo do poço', p.menorSaldo, -1500)
  eq('a faixa do aperto', p.faixaDoAperto, 'd7')
  eq('o alerta nomeia a faixa e o valor',
    p.alerta, 'O caixa fica negativo em "Até 7 dias". Faltam $1,500.00 — há $9,000.00 vencidos a receber, fora da projeção.')
}

// Conta já negativa HOJE não é aperto da projeção — e dizer que o caixa
// "fica" negativo numa faixa qualquer seria enganoso.
{
  const p = projetarCaixa({ saldoInicial: -200, hoje: HOJE, faturas: [], contas: [] })
  eq('faixa do aperto é null', p.faixaDoAperto, null)
  eq('o alerta fala do hoje', p.alerta, 'A conta já está negativa em $200.00 hoje.')
}

// Sem saldo conhecido não se projeta número nenhum — e se diz por quê.
{
  const p = projetarCaixa({ saldoInicial: null, hoje: HOJE,
    faturas: [fatura({})], contas: [conta({})] })
  eq('saldo acumulado fica null', p.linhas.map(l => l.saldo), [null, null, null, null, null])
  eq('mas os totais continuam valendo', [p.receber, p.pagar], [1000, 500])
  eq('o alerta explica', p.alerta,
    'Sem o saldo da conta não dá para projetar — conecte o banco ou sincronize o extrato.')
}

// Fatura já quitada ou com saldo zero não é a receber.
{
  const p = projetarCaixa({ saldoInicial: 0, hoje: HOJE,
    faturas: [fatura({ total: 1000, paid_total: 1000 }), fatura({ total: 1000, paid_total: 1200 })],
    contas: [] })
  eq('fatura quitada não entra', p.receber, 0)
  eq('nem a que pagou a mais', p.saldoFinal, 0)
}
// Pagamento parcial entra pelo SALDO, não pelo total.
{
  const p = projetarCaixa({ saldoInicial: 0, hoje: HOJE,
    faturas: [fatura({ total: 1000, paid_total: 250 })], contas: [] })
  eq('entra só o saldo', p.receber, 750)
}
// Conta paga ou cancelada não é a pagar.
{
  const p = projetarCaixa({ saldoInicial: 0, hoje: HOJE, faturas: [],
    contas: [conta({ status: 'paga' }), conta({ status: 'cancelada' }), conta({ status: 'aberta' })] })
  eq('só a aberta conta', p.pagar, 500)
}

console.log(`fluxo-de-caixa: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
