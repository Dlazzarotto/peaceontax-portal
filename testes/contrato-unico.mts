// testes/contrato-unico.mts — o contrato recorrente num lugar só (lib/contrato-unico.ts)
//
// É o que decide QUANDO e QUANTO se cobra da carteira inteira, todo período:
// a fatura emitida pela rotina diária, a fatura da mensalidade do débito, a
// receita recorrente do relatório e o preço da assinatura no Stripe.

import {
  cobrancaAPartirDe, cobrancaSeguinte, decidirEmissao, linhasDaMensalidade,
  valorMensalEquivalente, recorrenciaDoStripe, porPeriodo, decidirEdicao, ehFormaDeCobranca,
  ancoraDoDebito, rotuloDoPeriodo,
  type PlanoParaEmitir,
} from '../lib/contrato-unico.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// ── Ativar: a primeira cobrança é no dia ou depois, nunca para trás ──
eq('ativado antes do dia: cobra neste mes', cobrancaAPartirDe(10, '2026-01-10', 'monthly', '2026-10-05'), '2026-10-10')
eq('ativado no proprio dia: cobra hoje', cobrancaAPartirDe(10, '2026-01-10', 'monthly', '2026-10-10'), '2026-10-10')
eq('ativado depois do dia: mes seguinte', cobrancaAPartirDe(10, '2026-01-10', 'monthly', '2026-10-11'), '2026-11-10')
eq('contrato antigo de janeiro NAO cobra jan-set', cobrancaAPartirDe(1, '2026-01-01', 'monthly', '2026-10-17'), '2026-11-01')
eq('trimestral segue a regua do inicio (jan-abr-jul-out)', cobrancaAPartirDe(10, '2026-01-10', 'quarterly', '2026-08-01'), '2026-10-10')
eq('anual', cobrancaAPartirDe(15, '2025-03-15', 'annual', '2026-01-01'), '2026-03-15')
eq('sem inicio: a regua comeca no dia de ativar', cobrancaAPartirDe(5, null, 'monthly', '2026-10-17'), '2026-11-05')
eq('inicio no futuro: espera o inicio', cobrancaAPartirDe(5, '2027-01-01', 'monthly', '2026-10-17'), '2027-01-05')
eq('virada de ano', cobrancaAPartirDe(5, '2026-01-05', 'monthly', '2026-12-20'), '2027-01-05')

// ── Depois de emitir: UM passo, sem pular período ──
eq('mensal: o mes seguinte', cobrancaSeguinte(10, '2026-01-10', 'monthly', '2026-10-10'), '2026-11-10')
eq('trimestral: tres meses', cobrancaSeguinte(10, '2026-01-10', 'quarterly', '2026-10-10'), '2027-01-10')
eq('anual: um ano', cobrancaSeguinte(15, '2025-03-15', 'annual', '2026-03-15'), '2027-03-15')
eq('rotina atrasada: o passo e da data da regua, nao de hoje',
   cobrancaSeguinte(5, '2026-01-05', 'monthly', '2026-08-05'), '2026-09-05')

// ── A emissão da rotina diária ──
const plano = (x: Partial<PlanoParaEmitir> = {}): PlanoParaEmitir => ({
  collection_method: 'fatura', status: 'active', due_day: 10, start_date: '2026-01-10',
  billing_interval: 'monthly', next_charge_date: '2026-10-10', due_days: 15,
  discount: 50, monthly_amount: 420, end_date: null, ...x,
})
const linhas = [
  { service_id: 's1', description: 'Bookkeeping', quantity: 1, unit_price: 350 },
  { service_id: null, description: 'Payroll', quantity: 1, unit_price: 120 },
]
const e = decidirEmissao(plano(), linhas, '2026-10-10') as any
eq('emite no dia', e.emitir, true)
eq('competencia e o mes do periodo', e.competencia, '2026-10-01')
eq('vence N dias depois da emissao', e.vencimento, '2026-10-25')
eq('linhas, bruto, desconto e total', [e.linhas.length, e.bruto, e.desconto, e.total], [2, 470, 50, 420])
eq('linha leva o servico do catalogo e o valor', e.linhas[0], { service_id: 's1', description: 'Bookkeeping', qty: 1, unit_price: 350, amount: 350 })
eq('a seguinte', e.seguinte, '2026-11-10')
eq('nao e a ultima', e.ultima, false)

const atrasada = decidirEmissao(plano({ next_charge_date: '2026-08-10' }), linhas, '2026-10-17') as any
eq('atrasada: emite o periodo CERTO (agosto)', atrasada.competencia, '2026-08-01')
eq('atrasada: emissao e vencimento contam de hoje', [atrasada.emissao, atrasada.vencimento], ['2026-10-17', '2026-11-01'])
eq('atrasada: a seguinte e setembro (um passo)', atrasada.seguinte, '2026-09-10')

eq('antes do dia nao emite', decidirEmissao(plano(), linhas, '2026-10-09').emitir, false)
eq('debito nao emite (quem cobra e o Stripe)', decidirEmissao(plano({ collection_method: 'debito' }), linhas, '2026-10-10').emitir, false)
eq('pausado nao emite', decidirEmissao(plano({ status: 'paused' }), linhas, '2026-10-10').emitir, false)
eq('rascunho nao emite', decidirEmissao(plano({ status: 'draft' }), linhas, '2026-10-10').emitir, false)
eq('ativo sem data nao emite (e diz)', (decidirEmissao(plano({ next_charge_date: null }), linhas, '2026-10-10') as any).motivo,
   'o contrato ativo está sem a data da próxima cobrança')
eq('terminou: nao emite e pede encerrar', decidirEmissao(plano({ end_date: '2026-10-10' }), linhas, '2026-10-10'),
   { emitir: false, motivo: 'o contrato terminou', encerrar: true })
eq('a ultima antes do fim', (decidirEmissao(plano({ end_date: '2026-11-01' }), linhas, '2026-10-10') as any).ultima, true)
// O fim chega ENTRE duas cobranças: encerra no dia do fim, não na cobrança seguinte
eq('termina entre cobrancas: encerra no dia do fim',
   decidirEmissao(plano({ end_date: '2026-10-20', next_charge_date: '2026-11-10' }), linhas, '2026-10-20'),
   { emitir: false, motivo: 'o contrato terminou', encerrar: true })
eq('antes do fim e antes do dia: so espera',
   (decidirEmissao(plano({ end_date: '2026-12-01', next_charge_date: '2026-11-10' }), linhas, '2026-10-20') as any).motivo, 'ainda não é o dia')
eq('periodo vencido ANTES do fim ainda se cobra (rotina parada)',
   (decidirEmissao(plano({ end_date: '2026-10-15', next_charge_date: '2026-10-10' }), linhas, '2026-10-20') as any).competencia, '2026-10-01')
eq('cobranca no proprio dia do fim nao sai',
   decidirEmissao(plano({ end_date: '2026-10-10', next_charge_date: '2026-10-10' }), linhas, '2026-10-12').emitir, false)
eq('sem data, mas o fim passou: encerra (nao fica pedindo data)',
   (decidirEmissao(plano({ next_charge_date: null, end_date: '2026-10-01' }), linhas, '2026-10-10') as any).encerrar, true)
eq('sem linhas nao emite', decidirEmissao(plano(), [], '2026-10-10').emitir, false)
eq('valor gravado diferente das linhas NAO emite',
   (decidirEmissao(plano({ monthly_amount: 400 }), linhas, '2026-10-10') as any).motivo,
   'o valor gravado (400.00) não bate com as linhas (420.00) — salve o contrato para acertar')
eq('desconto maior que as linhas nao emite', decidirEmissao(plano({ discount: 500, monthly_amount: -30 }), linhas, '2026-10-10').emitir, false)
eq('quantidade fracionada e centavos',
   (decidirEmissao(plano({ discount: 0, monthly_amount: 0.3, due_days: 0 }),
     [{ description: 'A', quantity: 1, unit_price: 0.1 }, { description: 'B', quantity: 1, unit_price: 0.2 }], '2026-10-10') as any).total, 0.3)
eq('prazo zero vence no dia', (decidirEmissao(plano({ due_days: 0 }), linhas, '2026-10-10') as any).vencimento, '2026-10-10')
eq('trimestral: a seguinte em janeiro',
   (decidirEmissao(plano({ billing_interval: 'quarterly' }), linhas, '2026-10-10') as any).seguinte, '2027-01-10')
eq('linha vazia nao entra na fatura',
   (decidirEmissao(plano(), [...linhas, { description: '  ', quantity: 1, unit_price: 0 }], '2026-10-10') as any).linhas.length, 2)

// ── A fatura da mensalidade do débito ──
eq('bate com o cobrado: leva as linhas e o desconto',
   linhasDaMensalidade(linhas, 50, 420)?.desconto, 50)
eq('nao bate (mudou no meio do ciclo): linha unica', linhasDaMensalidade(linhas, 50, 400), null)
eq('sem linhas: linha unica', linhasDaMensalidade([], 0, 420), null)
eq('compara em centavos (420.004 do Stripe nao existe, 420.00 sim)', linhasDaMensalidade(linhas, 50, 420.0)?.bruto, 470)

// ── Receita mensal equivalente ──
eq('mensal', valorMensalEquivalente(350, 'monthly'), 350)
eq('trimestral divide por 3', valorMensalEquivalente(300, 'quarterly'), 100)
eq('anual divide por 12', valorMensalEquivalente(1200, 'annual'), 100)
eq('centavo arredondado', valorMensalEquivalente(100, 'quarterly'), 33.33)
eq('intervalo desconhecido conta como mensal', valorMensalEquivalente(50, 'weekly'), 50)

// ── O Stripe ──
eq('mensal no Stripe', recorrenciaDoStripe('monthly'), { interval: 'month', interval_count: 1 })
eq('trimestral no Stripe', recorrenciaDoStripe('quarterly'), { interval: 'month', interval_count: 3 })
eq('anual no Stripe', recorrenciaDoStripe('annual'), { interval: 'year', interval_count: 1 })
eq('por periodo', [porPeriodo('monthly'), porPeriodo('quarterly'), porPeriodo('annual', 'en')], ['/mês', '/trimestre', '/year'])

// ── A primeira cobrança do débito (o Stripe exige 48 horas) ──
eq('debito: o dia da regua a 3+ dias', ancoraDoDebito(20, null, 'monthly', '2026-10-17'), '2026-10-20')
eq('debito: dia a 2 dias vai para o mes seguinte', ancoraDoDebito(19, null, 'monthly', '2026-10-17'), '2026-11-19')
eq('debito: dia de amanha vai para o mes seguinte', ancoraDoDebito(18, null, 'monthly', '2026-10-17'), '2026-11-18')
eq('debito: dia de hoje vai para o mes seguinte', ancoraDoDebito(17, null, 'monthly', '2026-10-17'), '2026-11-17')
eq('debito trimestral segue a regua do inicio (out, nao set)', ancoraDoDebito(10, '2026-01-10', 'quarterly', '2026-08-20'), '2026-10-10')
eq('debito trimestral perto demais: o trimestre seguinte', ancoraDoDebito(10, '2026-01-10', 'quarterly', '2026-10-08'), '2027-01-10')
eq('debito anual', ancoraDoDebito(15, '2026-03-15', 'annual', '2026-10-17'), '2027-03-15')
eq('debito com inicio no futuro espera o inicio', ancoraDoDebito(5, '2027-01-01', 'monthly', '2026-10-17'), '2027-01-05')
eq('debito na virada do mes (31/out + 2 = 2/nov)', ancoraDoDebito(3, null, 'monthly', '2026-10-31'), '2026-11-03')
eq('debito na virada do ano (29/dez: 1/jan esta a 3 dias)', ancoraDoDebito(1, null, 'monthly', '2026-12-29'), '2027-01-01')
eq('debito em 30/dez: 1/jan pode cair a 31h (noite em Malden), vai a fevereiro', ancoraDoDebito(1, null, 'monthly', '2026-12-30'), '2027-02-01')
eq('debito: dia 31 do cadastro antigo vira 28', ancoraDoDebito(31, null, 'monthly', '2026-10-17'), '2026-10-28')

// ── O período na fatura ──
eq('periodo mensal', rotuloDoPeriodo('2026-10-01', 'monthly'), 'outubro de 2026')
eq('periodo trimestral', rotuloDoPeriodo('2026-10-01', 'quarterly'), 'out a dez de 2026')
eq('periodo trimestral atravessando o ano', rotuloDoPeriodo('2026-11-01', 'quarterly'), 'nov/2026 a jan/2027')
eq('periodo anual', rotuloDoPeriodo('2026-10-01', 'annual'), 'out/2026 a set/2027')
eq('periodo anual de janeiro', rotuloDoPeriodo('2026-01-01', 'annual'), 'jan a dez de 2026')
eq('periodo sem intervalo conhecido e mensal', rotuloDoPeriodo('2026-03-01', null), 'março de 2026')

// ── Editar ──
eq('encerrado nao edita', decidirEdicao({ status: 'cancelled', collection_method: 'fatura' }).ok, false)
eq('concluido nao edita', decidirEdicao({ status: 'completed', collection_method: 'debito' }).ok, false)
eq('fatura edita (vale da proxima emissao)', decidirEdicao({ status: 'active', collection_method: 'fatura' }), { ok: true, mudaStripe: false, refazLink: false })
eq('debito com assinatura muda o preco no Stripe',
   decidirEdicao({ status: 'active', collection_method: 'debito', stripe_subscription_id: 'sub_1' }), { ok: true, mudaStripe: true, refazLink: false })
eq('debito aguardando o cadastro: o link antigo deixa de valer',
   decidirEdicao({ status: 'awaiting_setup', collection_method: 'debito' }), { ok: true, mudaStripe: false, refazLink: true })
eq('debito em rascunho', decidirEdicao({ status: 'draft', collection_method: 'debito' }), { ok: true, mudaStripe: false, refazLink: false })

eq('formas', [ehFormaDeCobranca('debito'), ehFormaDeCobranca('fatura'), ehFormaDeCobranca('boleto')], [true, true, false])

console.log(`contrato-unico: ${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
