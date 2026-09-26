// testes/deposito-match.mts — o depósito × os recebimentos que o compõem
//
// A conta de passagem ("Recebimentos a depositar") tem de FECHAR EM ZERO:
//   + recebimentos (bruto) − taxa − transferência para o banco = 0
// Se não fechar, a receita bruta não bate com o 1099-K e a taxa do Stripe
// deixa de ser despesa dedutível.

import { conferirDeposito, linhasDoDeposito, casarRepasse, round2, TOLERANCIA, CONTA_DO_DEPOSITO }
  from '../lib/deposito-match.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const rec = (...v: number[]) => v.map((amount, i) => ({ id: `r${i}`, amount }))

// ── Depósito de cheque/Zelle: fecha exato ───────────────────────────────
{
  const c = conferirDeposito(1000, rec(1000))
  eq('cheque: um recebimento, um depósito', c.situacao, 'exato')
  eq('cheque: diferença zero', c.diferenca, 0)
  eq('cheque: pode conciliar', c.podeConciliar, true)
}
{
  const c = conferirDeposito(1750.25, rec(1000, 500.25, 250))
  eq('malote: três cheques num depósito', c.situacao, 'exato')
  eq('malote: soma', c.soma, 1750.25)
}

// ── Repasse do Stripe: chega LÍQUIDO ────────────────────────────────────
{
  const c = conferirDeposito(970, rec(1000))
  eq('stripe: a diferença é taxa', c.situacao, 'taxa')
  eq('stripe: $30 de taxa', c.diferenca, 30)
  eq('stripe: concilia', c.podeConciliar, true)
  eq('stripe: 3% não é suspeito', c.alerta, null)
}
{
  // 14 cobranças num repasse só — o caso real de "mesma conta"
  const cobrancas = rec(...Array.from({ length: 14 }, () => 100))
  const taxa = round2(14 * (100 * 0.029 + 0.30))
  const c = conferirDeposito(round2(1400 - taxa), cobrancas)
  eq('repasse de 14 cobranças: taxa', c.diferenca, taxa)
  eq('repasse de 14 cobranças: concilia', c.podeConciliar, true)
}

// ── Depósito MAIOR que os recebimentos: falta lançar ────────────────────
{
  const c = conferirDeposito(1500, rec(1000))
  eq('entrou mais do que se explica', c.situacao, 'falta_recebimento')
  eq('e NÃO concilia -- depósito não vira receita sozinho', c.podeConciliar, false)
  eq('a diferença é negativa', c.diferenca, -500)
  eq('a mensagem diz quanto falta', c.mensagem.includes('$500.00'), true)
}

// ── Nada escolhido ──────────────────────────────────────────────────────
{
  const c = conferirDeposito(970, [])
  eq('sem seleção não concilia', c.podeConciliar, false)
  eq('sem seleção tem situação própria', c.situacao, 'sem_selecao')
}

// ── O alerta de taxa implausível ────────────────────────────────────────
{
  const c = conferirDeposito(800, rec(1000))
  eq('20% de retenção concilia (pode haver reembolso no repasse)', c.podeConciliar, true)
  eq('mas avisa', c.alerta !== null, true)
}
{
  const c = conferirDeposito(903, rec(1000))
  eq('9,7% ainda avisa? nao -- o limite e 10%', c.alerta, null)
}

// ── Ruído de ponto flutuante ────────────────────────────────────────────
{
  const c = conferirDeposito(0.1 + 0.2, rec(0.3))
  eq('0.1+0.2 nao inventa diferenca', c.situacao, 'exato')
}
{
  const c = conferirDeposito(999.99, rec(1000))
  eq('um centavo JA e diferenca', c.situacao, 'taxa')
  eq('um centavo de taxa', c.diferenca, 0.01)
}
eq('a tolerancia e meio centavo', TOLERANCIA, 0.005)

// ── As linhas gravadas: a conta de passagem ZERA ────────────────────────
{
  const l = linhasDoDeposito(970, rec(1000))
  eq('transferência sai pelo valor do banco', l.transferencia.amount, -970)
  eq('transferência não é despesa', l.transferencia.category, CONTA_DO_DEPOSITO)
  eq('taxa de $30 como despesa', l.taxa, { amount: -30, category: 'Taxas de processamento' })
  eq('A CONTA DE PASSAGEM ZERA', l.conferencia, 0)
}
{
  const l = linhasDoDeposito(1750.25, rec(1000, 500.25, 250))
  eq('sem taxa não cria linha de taxa', l.taxa, null)
  eq('e zera igual', l.conferencia, 0)
}
{
  // Centavos que não dividem redondo
  const l = linhasDoDeposito(96.77, rec(33.33, 33.33, 33.34))
  eq('centavo quebrado: taxa', l.taxa?.amount, -3.23)
  eq('centavo quebrado: zera', l.conferencia, 0)
}
{
  const l = linhasDoDeposito(1500, rec(1000))
  eq('depósito maior não vira taxa negativa', l.taxa, null)
  eq('e a conferência acusa que NÃO fecha', l.conferencia, -500)
}

// ── Casar o repasse do Stripe com os recebimentos ───────────────────────
{
  const r = casarRepasse(['ch_1', 'pi_2'], [
    { id: 'a', stripe_object: 'ch_1', reference: null },
    { id: 'b', stripe_object: 'cs_9', reference: 'pi_2' },
    { id: 'c', stripe_object: 'ch_zelle', reference: null },
  ])
  eq('casa pela cobrança e pela intenção, nas duas colunas', r.casados, ['a', 'b'])
  eq('o que não é do repasse sobra', r.naoCasados, ['c'])
  eq('e o repasse não tem cobrança órfã', r.semRecebimento, [])
}
{
  const r = casarRepasse(['ch_1', 'ch_2'], [{ id: 'a', stripe_object: 'ch_1' }])
  eq('cobrança no repasse sem recebimento lançado APARECE', r.semRecebimento, ['ch_2'])
}
{
  const r = casarRepasse([], [{ id: 'a', stripe_object: null, reference: null }])
  eq('recebimento sem chave do Stripe nunca casa por engano', r.casados, [])
  eq('e sobra para o cheque', r.naoCasados, ['a'])
}

console.log(`deposito-match: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
