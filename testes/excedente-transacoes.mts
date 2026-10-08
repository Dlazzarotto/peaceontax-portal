// testes/excedente-transacoes.mts — franquia MENSAL, apuração ANUAL
//
// O defeito: a franquia é por mês e era comparada com a contagem do ano
// inteiro. 100/mês contra 590 no ano dava 490 "acima" e $612,50 a cobrar.

import { vigenciaNoAno, apurarExcedente, TAXA_PADRAO } from '../lib/excedente-transacoes.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

const FIM_DE_ANO = '2026-12-31'

// ── O caso que originou ──────────────────────────────────────────────────
{
  const plano = { created_at: '2024-03-10T15:00:00Z', due_day: 5, included_transactions: 100, overage_rate: 1.25 }
  const v = vigenciaNoAno(plano, 2025, '2026-10-07')
  eq('ano fechado, contrato antigo: 12 meses', v, { meses: 12, desde: null, parcial: false })
  const a = apurarExcedente(plano, 590, v)
  eq('590 em 1.200 de franquia nao e excedente', [a.franquia, a.excedente, a.valor], [1200, 0, 0])
  eq('o calculo antigo daria 490 -- nao da mais', a.excedente === 490, false)
}

// ── Vigência contada da PRIMEIRA COBRANÇA, não da criação ────────────────
{
  // Criado 20/08 com débito no dia 5: a 1ª cobrança é 05/09 → set..dez = 4.
  const plano = { created_at: '2026-08-20T14:00:00Z', due_day: 5, included_transactions: 50 }
  const v = vigenciaNoAno(plano, 2026, FIM_DE_ANO)
  eq('criado em 20/08, dia 5: comeca em setembro', v.desde, '2026-09-05')
  eq('quatro meses, nao cinco', v.meses, 4)
}
{
  // Criado 01/08 com débito no dia 20: a 1ª cobrança é 20/08 → ago..dez = 5.
  const v = vigenciaNoAno({ created_at: '2026-08-01T14:00:00Z', due_day: 20 }, 2026, FIM_DE_ANO)
  eq('criado 01/08, dia 20: comeca em agosto', [v.desde, v.meses], ['2026-08-20', 5])
}
{
  // Criado na VÉSPERA do dia de débito: o Stripe exige 48h, a âncora pula um mês.
  const v = vigenciaNoAno({ created_at: '2026-08-04T14:00:00Z', due_day: 5 }, 2026, FIM_DE_ANO)
  eq('vespera do debito pula para o mes seguinte', [v.desde, v.meses], ['2026-09-05', 4])
}
{
  // Criado no fim de dezembro: a 1ª cobrança é no ano seguinte.
  const plano = { created_at: '2025-12-28T14:00:00Z', due_day: 5, included_transactions: 100 }
  const v25 = vigenciaNoAno(plano, 2025, '2026-10-07')
  eq('nao vigorava em 2025', v25.meses, 0)
  eq('lancamentos de 2025 nao viram excedente', apurarExcedente(plano, 900, v25).excedente, 0)
  const v26 = vigenciaNoAno(plano, 2026, FIM_DE_ANO)
  eq('em 2026 vale o ano todo', [v26.meses, v26.desde], [12, '2026-01-05'])
}

// ── Ano corrente: franquia só até o mês corrente ─────────────────────────
{
  const plano = { created_at: '2024-01-01T14:00:00Z', due_day: 5, included_transactions: 100 }
  const v = vigenciaNoAno(plano, 2026, '2026-10-07')
  eq('outubro: dez meses de franquia, parcial', [v.meses, v.parcial], [10, true])
  const a = apurarExcedente(plano, 1100, v)
  eq('1.100 em out contra 1.000 de franquia: 100 acima', [a.franquia, a.excedente], [1000, 100])
  // Com a franquia do ano inteiro (1.200) esse excedente ficaria escondido.
  eq('excedente que ja existe nao se esconde', a.excedente > 0, true)
}
{
  const plano = { created_at: '2026-08-20T14:00:00Z', due_day: 5, included_transactions: 50 }
  eq('contrato que ainda nao comecou a cobrar: zero meses',
    vigenciaNoAno(plano, 2026, '2026-08-25').meses, 0)
  eq('primeiro mes de vigencia conta', vigenciaNoAno(plano, 2026, '2026-09-10').meses, 1)
}
eq('ano futuro: nada', vigenciaNoAno({ created_at: '2020-01-01' }, 2027, '2026-10-07').meses, 0)

// ── Sem data de criação: ano inteiro (o lado favorável ao cliente) ───────
eq('sem created_at: ano fechado tem 12', vigenciaNoAno({}, 2025, '2026-10-07'), { meses: 12, desde: null, parcial: false })
eq('sem created_at: ano corrente ate o mes', vigenciaNoAno({}, 2026, '2026-03-15').meses, 3)
eq('created_at invalido conta como ausente', vigenciaNoAno({ created_at: 'xx' }, 2025, '2026-10-07').meses, 12)

// ── Apuração ─────────────────────────────────────────────────────────────
{
  const v = { meses: 12, desde: null, parcial: false }
  eq('sem plano: nada', apurarExcedente(null, 5000, v).excedente, 0)
  eq('franquia nula nao e zero: contrato que nao limita',
    apurarExcedente({ included_transactions: null }, 5000, v).franquia, null)
  eq('franquia 0 tambem nao limita', apurarExcedente({ included_transactions: 0 }, 5000, v).excedente, 0)
  eq('franquia como texto', apurarExcedente({ included_transactions: '100' }, 1300, v).excedente, 100)
  eq('taxa padrao quando falta', apurarExcedente({ included_transactions: 100 }, 1300, v).taxa, TAXA_PADRAO)
  eq('taxa gravada vale', apurarExcedente({ included_transactions: 100, overage_rate: '2' }, 1300, v).valor, 200)
  eq('taxa negativa nao vale', apurarExcedente({ included_transactions: 100, overage_rate: -1 }, 1300, v).taxa, TAXA_PADRAO)
  eq('centavos arredondados', apurarExcedente({ included_transactions: 100, overage_rate: 1.255 }, 1203, v).valor, 3.77)
  eq('abaixo da franquia: zero, nunca negativo', apurarExcedente({ included_transactions: 100 }, 10, v).excedente, 0)
  eq('exatamente na franquia: zero', apurarExcedente({ included_transactions: 100 }, 1200, v).excedente, 0)
  eq('o parcial viaja', apurarExcedente({ included_transactions: 1 }, 1, { meses: 1, desde: null, parcial: true }).parcial, true)
}

console.log(`excedente-transacoes: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
