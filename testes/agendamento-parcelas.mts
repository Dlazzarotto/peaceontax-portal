// testes/agendamento-parcelas.mts — o agendamento das parcelas no Stripe
// (lib/agendamento-parcelas.ts).
//
// As parcelas NUNCA foram cobradas: o agendamento mandava `iterations`, que a
// API do Stripe tirou na versão 2025-09-30.clover, e o sistema fala na
// 2026-06-24.dahlia. Aqui: a conta das fases bate com o cronograma da fatura
// parcela por parcela, nenhuma fase leva `iterations`, e um agendamento que
// já existe é reaproveitado (reenvio do evento ou a equipe agendando à mão
// não podem cobrar cada parcela duas vezes).

import {
  fasesDoParcelamento, agendarParcelas, pagamentoDaSessao, metodoDoTipo, type ContaDasFases,
} from '../lib/agendamento-parcelas.ts'
import { montarCronograma } from '../lib/cronograma-parcelas.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const conta = (x: any) => fasesDoParcelamento(x) as ContaDasFases
const erro = (x: any) => (fasesDoParcelamento(x) as any).erro

// ── As fases ──
{
  const c = conta({ frequencia: 'monthly', parcelas: 4, valorParcela: 250, restante: 1000 })
  eq('parcelas iguais: uma fase', c.fases.map(f => [f.rotulo, f.parcelas, f.centavos]), [['unica', 4, 25000]])
  eq('a fase dura 4 meses', c.fases[0].duration, { interval: 'month', interval_count: 4 })
  eq('cada parcela a cada mes', c.recorrencia, { interval: 'month', interval_count: 1 })
  eq('total', c.totalCentavos, 100000)
}
{
  const c = conta({ frequencia: 'monthly', parcelas: 3, valorParcela: 333.33, restante: 1000 })
  eq('ultima absorve o centavo: duas fases', c.fases.map(f => [f.rotulo, f.parcelas, f.centavos]), [['base', 2, 33333], ['ultima', 1, 33334]])
  eq('duracoes: 2 meses e 1 mes', c.fases.map(f => f.duration), [{ interval: 'month', interval_count: 2 }, { interval: 'month', interval_count: 1 }])
  eq('soma exata', c.totalCentavos, 100000)
}
{
  const c = conta({ frequencia: 'biweekly', parcelas: 4, valorParcela: 100, restante: 400 })
  eq('quinzenal: a fase dura 8 semanas', c.fases[0].duration, { interval: 'week', interval_count: 8 })
  eq('quinzenal: cobra a cada 2 semanas', c.recorrencia, { interval: 'week', interval_count: 2 })
  const d = conta({ frequencia: 'biweekly', parcelas: 3, valorParcela: 33.33, restante: 100 })
  eq('quinzenal com centavo: 4 semanas + 2 semanas', d.fases.map(f => f.duration.interval_count), [4, 2])
}
{
  const c = conta({ frequencia: 'weekly', parcelas: 5, valorParcela: 20, restante: 100 })
  eq('semanal: 5 semanas', c.fases[0].duration, { interval: 'week', interval_count: 5 })
}
eq('parcela unica cobra o restante inteiro', conta({ frequencia: 'monthly', parcelas: 1, valorParcela: 1, restante: 87.5 }).fases.map(f => [f.parcelas, f.centavos]), [[1, 8750]])
eq('NENHUMA fase leva iterations', JSON.stringify(conta({ frequencia: 'monthly', parcelas: 3, valorParcela: 333.33, restante: 1000 })).includes('iterations'), false)

eq('frequencia desconhecida recusa', /frequência/.test(erro({ frequencia: 'daily', parcelas: 3, valorParcela: 10, restante: 30 })), true)
eq('zero parcelas recusa', /parcelas/.test(erro({ frequencia: 'monthly', parcelas: 0, valorParcela: 10, restante: 30 })), true)
eq('sem saldo recusa', /saldo/.test(erro({ frequencia: 'monthly', parcelas: 3, valorParcela: 10, restante: 0 })), true)
eq('parcelas que passam do saldo recusam (3 × 600 em 1000)', /passam do saldo/.test(erro({ frequencia: 'monthly', parcelas: 3, valorParcela: 600, restante: 1000 })), true)
eq('a ultima fecha o saldo mesmo menor (600 + 400)', conta({ frequencia: 'monthly', parcelas: 2, valorParcela: 600, restante: 1000 }).fases.map(f => f.centavos), [60000, 40000])
eq('parcela abaixo de 50 centavos recusa', /0,50/.test(erro({ frequencia: 'monthly', parcelas: 3, valorParcela: 0.4, restante: 1.2 })), true)
eq('ultima abaixo de 50 centavos recusa', /0,50/.test(erro({ frequencia: 'monthly', parcelas: 3, valorParcela: 0.6, restante: 1.5 })), true)

// ── A conta bate com o cronograma da fatura, parcela por parcela ──
// O cronograma (lib/cronograma-parcelas.ts) é o que a fatura mostra e o que
// recebe a baixa; o agendamento é o que o Stripe cobra. Os dois têm de dizer
// a MESMA coisa em toda combinação, senão a fatura fecha com centavo sobrando.
{
  let divergiu = 0, casos = 0
  for (const freq of ['weekly', 'biweekly', 'monthly'] as const) {
    for (const n of [2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 17, 24, 36]) {
      for (const restante of [100, 250, 999.99, 1000, 1234.56, 3333.33, 7, 50.01]) {
        const cron = montarCronograma(restante, n, '2026-11-10', freq) as any
        if ('erro' in cron) continue
        casos++
        const c = fasesDoParcelamento({ frequencia: freq, parcelas: n, valorParcela: cron[0].amount, restante }) as any
        if ('erro' in c) { divergiu++; continue }
        const cobradas = c.fases.flatMap((f: any) => Array(f.parcelas).fill(f.centavos / 100))
        const doCronograma = cron.map((l: any) => Number(l.amount))
        if (JSON.stringify(cobradas) !== JSON.stringify(doCronograma)) divergiu++
      }
    }
  }
  eq(`agendamento = cronograma em todos os casos (${casos})`, divergiu, 0)
  eq('a varredura cobriu casos de verdade', casos > 200, true)
}

// ── O Stripe falso ──
function stripeFalso(agendamentos: any[] = []) {
  const chamadas: any[] = []
  const s: any = {
    chamadas,
    products: {
      search: async () => ({ data: [{ id: 'prod_parc' }] }),
      create: async () => { chamadas.push(['products.create']); return { id: 'prod_novo' } },
    },
    subscriptionSchedules: {
      list: async (p: any) => { chamadas.push(['list', p]); return { data: agendamentos } },
      create: async (p: any) => { chamadas.push(['create', p]); return { id: 'sub_sched_1', subscription: null, phases: [{ start_date: p.start_date }] } },
    },
    paymentIntents: {
      retrieve: async (id: string) => ({ id, created: 1_790_000_000, payment_method: { id: 'pm_card', type: 'card' }, latest_charge: { created: 1_790_000_100 } }),
    },
    setupIntents: {
      retrieve: async (id: string) => ({ id, status: 'succeeded', created: 1_790_000_200, payment_method: { id: 'pm_ach', type: 'us_bank_account' } }),
    },
  }
  return s
}

const plano = { id: 'plan_1', stripe_customer_id: 'cus_1' }
const tres = conta({ frequencia: 'monthly', parcelas: 3, valorParcela: 333.33, restante: 1000 })
const futuro = new Date(Date.now() + 10 * 86400_000)

{
  const st = stripeFalso()
  const r = await agendarParcelas(st, plano, tres, 'pm_card', futuro)
  const p = st.chamadas.find((c: any) => c[0] === 'create')?.[1]
  eq('cria quando nao existe', r.reaproveitado, false)
  eq('fases com duration, nunca iterations', p.phases.map((f: any) => [!!f.duration, 'iterations' in f]), [[true, false], [true, false]])
  eq('valor e recorrencia por fase', p.phases.map((f: any) => [f.items[0].price_data.unit_amount, f.items[0].price_data.recurring]),
    [[33333, { interval: 'month', interval_count: 1 }], [33334, { interval: 'month', interval_count: 1 }]])
  eq('debita na forma salva, automatico', p.default_settings, { default_payment_method: 'pm_card', collection_method: 'charge_automatically' })
  eq('o plano viaja no metadata (agendamento e fases)', [p.metadata.planId, p.phases.every((f: any) => f.metadata.planId === 'plan_1')], ['plan_1', true])
  eq('encerra depois da ultima', p.end_behavior, 'cancel')
  eq('comeca na data pedida', p.start_date, Math.floor(futuro.getTime() / 1000))
  eq('produto reaproveitado', st.chamadas.some((c: any) => c[0] === 'products.create'), false)
}
{
  const st = stripeFalso()
  const antes = Math.floor(Date.now() / 1000)
  const r = await agendarParcelas(st, plano, tres, 'pm_card', new Date('2026-01-01T12:00:00Z'))
  const p = st.chamadas.find((c: any) => c[0] === 'create')?.[1]
  eq('data no passado vira agora (o Stripe recusa start_date passado)', p.start_date >= antes + 100 && p.start_date <= antes + 200, true)
  eq('o inicio devolvido e o real', Math.floor(r.inicio.getTime() / 1000), p.start_date)
}
{
  const st = stripeFalso([{ id: 'sub_sched_velho', status: 'not_started', metadata: { planId: 'plan_1' }, phases: [{ start_date: 1_800_000_000 }] }])
  const r = await agendarParcelas(st, plano, tres, 'pm_card', futuro)
  eq('agendamento que ja existe e reaproveitado (reenvio nao cobra em dobro)', [r.reaproveitado, r.schedule.id], [true, 'sub_sched_velho'])
  eq('...e nada e criado', st.chamadas.some((c: any) => c[0] === 'create'), false)
  eq('...e o inicio e o dele', Math.floor(r.inicio.getTime() / 1000), 1_800_000_000)
}
{
  const st = stripeFalso([
    { id: 'outro_plano', status: 'active', metadata: { planId: 'plan_2' } },
    { id: 'cancelado', status: 'canceled', metadata: { planId: 'plan_1' } },
  ])
  const r = await agendarParcelas(st, plano, tres, 'pm_card', futuro)
  eq('agendamento de outro plano ou cancelado nao conta', [r.reaproveitado, r.schedule.id], [false, 'sub_sched_1'])
}
{
  let msg = ''
  try { await agendarParcelas(stripeFalso(), { id: 'p', stripe_customer_id: null }, tres, 'pm', futuro) } catch (e) { msg = (e as Error).message }
  eq('sem cliente no Stripe recusa', /cliente no Stripe/.test(msg), true)
  msg = ''
  try { await agendarParcelas(stripeFalso(), plano, tres, '', futuro) } catch (e) { msg = (e as Error).message }
  eq('sem forma de pagamento recusa', /forma de pagamento/.test(msg), true)
}

// ── O que o cliente fez na sessão ──
{
  const st = stripeFalso()
  const pago = await pagamentoDaSessao(st, { id: 'cs_1', mode: 'payment', status: 'complete', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 25000 } as any)
  eq('entrada paga: forma, intent e valor', [pago.concluido, pago.paymentMethod, pago.tipo, pago.intent, pago.valor], [true, 'pm_card', 'card', 'pi_1', 250])
  eq('a hora e a da cobranca, nao a de hoje', pago.quando?.toISOString(), new Date(1_790_000_100 * 1000).toISOString())
  const ach = await pagamentoDaSessao(st, { id: 'cs_2', mode: 'payment', status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_2', amount_total: 25000 } as any)
  eq('ACH a caminho: nao esta pago, esta em processamento', [ach.concluido, ach.emProcessamento], [false, true])
  const aberta = await pagamentoDaSessao(st, { id: 'cs_3', mode: 'payment', status: 'open', payment_status: 'unpaid', amount_total: 25000 } as any)
  eq('sessao aberta: nada feito', [aberta.concluido, aberta.emProcessamento], [false, false])
  const mandato = await pagamentoDaSessao(st, { id: 'cs_4', mode: 'setup', status: 'complete', setup_intent: 'seti_1' } as any)
  eq('sem entrada: o debito autorizado', [mandato.modo, mandato.concluido, mandato.paymentMethod, mandato.tipo], ['setup', true, 'pm_ach', 'us_bank_account'])
}
eq('forma para o livro', [metodoDoTipo('us_bank_account'), metodoDoTipo('klarna'), metodoDoTipo('card'), metodoDoTipo(null)], ['ach', 'external', 'card', 'card'])

console.log(`agendamento-parcelas: ${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
