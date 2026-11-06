// testes/parcela-stripe.mts — qual parcela uma cobrança do Stripe representa.
//
// A amarração decide se a invoice que o Stripe acabou de emitir é ANULADA
// (`sem_parcela`). Anular a cobrança legítima de uma parcela é o cliente sem
// débito e a fatura em aberto sem ninguém saber; não anular a cobrança que
// sobrou é o cliente pagando duas vezes. Os casos que custam caro são os que
// não se vêem lendo: o mesmo evento entregue de novo, o invoice.paid chegando
// antes, a leitura que falha e duas entregas ao mesmo tempo. Banco falso em
// memória, com falha e corrida injetáveis.

import { amarrarCobrancaAParcela, parcelaDaInvoice, recontarParcelas, PAGA_ANTES_DO_AGENDAMENTO } from '../lib/parcela-stripe.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

type Linha = Record<string, any>
type Chamada = { n: number; modo: 'select' | 'update' }
function bancoFalso(linhas: Linha[], aoExecutar?: (c: Chamada, banco: { linhas: Linha[] }) => { error?: { message: string } } | void) {
  let n = 0
  const banco = {
    linhas,
    chamadas: 0,
    from(_tabela: string) {
      const filtros: ((r: Linha) => boolean)[] = []
      let modo: 'select' | 'update' = 'select'
      let patch: Linha = {}
      let ordem: string | null = null
      let limite = Infinity
      let colunas: string[] | null = null
      let contar = false, soCabecalho = false
      const projeta = (l: Linha) => colunas ? Object.fromEntries(colunas.map(c => [c, l[c]])) : { ...l }
      const q: any = {
        select(c?: string, o?: { count?: string; head?: boolean }) {
          colunas = c ? c.split(',').map(x => x.trim()) : null
          contar = !!o?.count; soCabecalho = !!o?.head
          return q
        },
        update(p: Linha) { modo = 'update'; patch = p; return q },
        eq(c: string, v: any) { filtros.push(r => r[c] === v); return q },
        in(c: string, vs: any[]) { filtros.push(r => vs.includes(r[c])); return q },
        is(c: string, v: any) { filtros.push(r => (r[c] ?? null) === v); return q },
        order(c: string) { ordem = c; return q },
        limit(k: number) { limite = k; return q },
        then(ok: any, erro: any) {
          n++; banco.chamadas = n
          const r = aoExecutar?.({ n, modo }, banco)
          if (r && r.error) return Promise.resolve({ data: null, error: r.error }).then(ok, erro)
          let achadas = banco.linhas.filter(l => filtros.every(f => f(l)))
          if (ordem) { const o = ordem; achadas = [...achadas].sort((a, b) => a[o] - b[o]) }
          achadas = achadas.slice(0, limite)
          if (modo === 'update') {
            for (const l of achadas) Object.assign(l, patch)
            return Promise.resolve({ data: achadas.map(projeta), error: null }).then(ok, erro)
          }
          if (contar) return Promise.resolve({ data: soCabecalho ? null : achadas.map(projeta), count: achadas.length, error: null }).then(ok, erro)
          return Promise.resolve({ data: achadas.map(projeta), error: null }).then(ok, erro)
        },
      }
      return q
    },
  }
  return banco
}

const P = (seq: number, status = 'scheduled', stripe_invoice: string | null = null, invoice_id = 'F') =>
  ({ invoice_id, seq, status, stripe_invoice, amount: 350 })
const cronograma = () => [P(1), P(2), P(3), P(1, 'scheduled', null, 'OUTRA')]
const amarras = (b: { linhas: Linha[] }, fatura = 'F') =>
  b.linhas.filter(l => l.invoice_id === fatura).map(l => `${l.seq}:${l.stripe_invoice ?? '-'}`)
const lanca = async (f: () => Promise<any>) => { try { await f(); return 'não lançou' } catch (e) { return 'lançou' } }

;(async () => {
  // ── Casos que já existiam (parcelaDaInvoice e recontarParcelas) ────────
  // O banco falso antigo devolvia a linha inteira; o PostgREST devolve só as
  // colunas pedidas (`seq, status, amount`), e é isso que este devolve agora.
  {
    const plan = { id: 'p1', invoice_id: 'inv1', paid_installments: 0 }
    const cron = (over: any[] = []) => {
      const base = [1, 2, 3, 4].map(seq => ({ invoice_id: 'inv1', seq, status: 'scheduled', stripe_invoice: null as string | null, amount: 100 }))
      for (const o of over) Object.assign(base[o.seq - 1], o)
      return base
    }
    // 1. caso simples: nada amarrado, primeira em aberto
    eq('primeira em aberto', await parcelaDaInvoice(bancoFalso(cron()), plan, { id: 'in_A' }), { seq: 1, status: 'scheduled', amount: 100, stripeInvoice: null, stripeIntent: null })
    // 2. A INVOICE MANDA: a 3a foi amarrada no finalized, mesmo com a 1a em aberto
    eq('amarrada vence a ordem', (await parcelaDaInvoice(
      bancoFalso(cron([{ seq: 3, stripe_invoice: 'in_C' }])), plan, { id: 'in_C' }))?.seq, 3)
    // 3. O CASO QUE O CONTADOR ERRAVA: 2a falhou, 3a paga antes.
    //    paid_installments = 1, então o contador diria "parcela 2" — e a 3a é que foi paga.
    const c3 = () => cron([{ seq: 1, status: 'paid' }, { seq: 2, status: 'failed', stripe_invoice: 'in_B' }, { seq: 3, stripe_invoice: 'in_C' }])
    eq('fora de ordem: acha a 3a, não a 2a', (await parcelaDaInvoice(bancoFalso(c3()), { ...plan, paid_installments: 1 }, { id: 'in_C' }))?.seq, 3)
    eq('e a falha continua sendo a 2a', (await parcelaDaInvoice(bancoFalso(c3()), { ...plan, paid_installments: 1 }, { id: 'in_B' }))?.seq, 2)
    // 4. parcela que falhou e foi recobrada: continua sendo a mesma
    eq('recobrança cai na mesma parcela', (await parcelaDaInvoice(
      bancoFalso(cron([{ seq: 2, status: 'failed', stripe_invoice: 'in_B' }])), plan, { id: 'in_B' }))?.seq, 2)
    // 5. Cronograma todo pago POR FORA (nenhuma parcela com cobrança): a
    //    cobrança é do período da 1ª, que está paga. Antes devolvia null; agora
    //    devolve a parcela paga e quem chama trata como cobrado a mais (no
    //    invoice.paid) e não marca falha (no invoice.payment_failed).
    eq('todo pago por fora: devolve a parcela paga do período', await parcelaDaInvoice(
      bancoFalso(cron([{ seq: 1, status: 'paid' }, { seq: 2, status: 'paid' }, { seq: 3, status: 'paid' }, { seq: 4, status: 'paid' }])), plan, { id: 'in_X' }),
      { seq: 1, status: 'paid', amount: 100, stripeInvoice: null, stripeIntent: null })
    // 6. recontagem: o total vem do cronograma, não do contador
    eq('reconta do cronograma', await recontarParcelas(
      bancoFalso(cron([{ seq: 1, status: 'paid' }, { seq: 3, status: 'paid' }])), { ...plan, paid_installments: 99 }), 2)
    eq('cronograma zerado conta zero', await recontarParcelas(bancoFalso(cron()), { ...plan, paid_installments: 99 }), 0)
    // 7. parcelamento antigo sem fatura de origem: cai no contador, sem quebrar
    eq('sem fatura de origem usa o contador', await recontarParcelas(bancoFalso([]), { id: 'p2', invoice_id: null, paid_installments: 3 }), 3)
    eq('sem fatura de origem não tem parcela', await parcelaDaInvoice(bancoFalso([]), { id: 'p2', invoice_id: null }, { id: 'in_A' }), null)
  }

  // ── O caminho normal ──────────────────────────────────────────────────
  {
    const b = bancoFalso(cronograma())
    eq('amarra a primeira parcela em aberto', await amarrarCobrancaAParcela(b, 'F', 'in_1'), { acao: 'amarrada', seq: 1 })
    eq('…e só ela', amarras(b), ['1:in_1', '2:-', '3:-'])
    eq('a outra fatura não é tocada', amarras(b, 'OUTRA'), ['1:-'])
    eq('a segunda cobrança vai para a parcela 2', await amarrarCobrancaAParcela(b, 'F', 'in_2'), { acao: 'amarrada', seq: 2 })
    eq('a terceira para a 3', await amarrarCobrancaAParcela(b, 'F', 'in_3'), { acao: 'amarrada', seq: 3 })
    eq('uma quarta cobrança não tem parcela: só ela pode ser anulada', await amarrarCobrancaAParcela(b, 'F', 'in_4'), { acao: 'sem_parcela' })
  }

  // ── O mesmo evento de novo (o Stripe entrega pelo menos uma vez) ──────
  {
    const b = bancoFalso(cronograma())
    await amarrarCobrancaAParcela(b, 'F', 'in_1')
    eq('evento repetido: já amarrada, nada muda', await amarrarCobrancaAParcela(b, 'F', 'in_1'), { acao: 'ja_amarrada', seq: 1 })
    eq('…a parcela 2 continua livre', amarras(b), ['1:in_1', '2:-', '3:-'])
    await amarrarCobrancaAParcela(b, 'F', 'in_2'); await amarrarCobrancaAParcela(b, 'F', 'in_3')
    eq('evento da ÚLTIMA parcela repetido NÃO vira "sem parcela" (não anula a cobrança legítima)',
       await amarrarCobrancaAParcela(b, 'F', 'in_3'), { acao: 'ja_amarrada', seq: 3 })
  }

  // ── O invoice.paid chegou antes do invoice.finalized ─────────────────
  {
    const b = bancoFalso([P(1, 'paid', 'in_1'), P(2), P(3)])
    eq('paga antes de emitida: a parcela já está amarrada a esta cobrança',
       await amarrarCobrancaAParcela(b, 'F', 'in_1'), { acao: 'ja_amarrada', seq: 1 })
    eq('…e a parcela 2 não é tomada por engano', amarras(b), ['1:in_1', '2:-', '3:-'])
    const ultima = bancoFalso([P(1, 'paid', 'in_1'), P(2, 'paid', 'in_2'), P(3, 'paid', 'in_3')])
    eq('a última, paga antes de emitida, também não é anulada', await amarrarCobrancaAParcela(ultima, 'F', 'in_3'), { acao: 'ja_amarrada', seq: 3 })
  }

  // ── Parcela paga por fora: a cobrança do período DELA vai para ela (o
  //    webhook a zera no rascunho ou a anula no finalized). Na regra antiga a
  //    1ª cobrança pulava para a parcela 2 — o cliente que pagou em Zelle era
  //    debitado no mesmo mês, e só a última deixava de ser cobrada.
  {
    const b = bancoFalso([P(1, 'paid'), P(2), P(3)])
    eq('parcela 1 paga por fora: a 1ª cobrança vai para ELA, não para a 2', await amarrarCobrancaAParcela(b, 'F', 'in_1'), { acao: 'amarrada', seq: 1 })
    eq('a 2ª vai para a 2', await amarrarCobrancaAParcela(b, 'F', 'in_2'), { acao: 'amarrada', seq: 2 })
    eq('a 3ª vai para a 3', await amarrarCobrancaAParcela(b, 'F', 'in_3'), { acao: 'amarrada', seq: 3 })
    eq('uma 4ª sobrou: sem parcela', await amarrarCobrancaAParcela(b, 'F', 'in_4'), { acao: 'sem_parcela' })
    eq('paga fora de ordem: o período dela continua sendo dela',
       await amarrarCobrancaAParcela(bancoFalso([P(1, 'paid', 'in_1'), P(2), P(3, 'paid')]), 'F', 'in_2'), { acao: 'amarrada', seq: 2 })
    eq('paga ANTES do agendamento fica de fora (o agendamento só cobra as em aberto)',
       await amarrarCobrancaAParcela(bancoFalso([P(1, 'paid', PAGA_ANTES_DO_AGENDAMENTO), P(2)]), 'F', 'in_1'), { acao: 'amarrada', seq: 2 })
    eq('parcela que falhou e não tem cobrança é escolhida',
       await amarrarCobrancaAParcela(bancoFalso([P(1, 'failed'), P(2)]), 'F', 'in_9'), { acao: 'amarrada', seq: 1 })
    eq('parcela amarrada a OUTRA cobrança não é tomada',
       await amarrarCobrancaAParcela(bancoFalso([P(1, 'failed', 'in_X'), P(2)]), 'F', 'in_Y'), { acao: 'amarrada', seq: 2 })
    eq('parcela cancelada não é em aberto', await amarrarCobrancaAParcela(bancoFalso([P(1, 'cancelled')]), 'F', 'in_1'), { acao: 'sem_parcela' })
  }

  // ── Leitura que falha LANÇA (o webhook responde 500 e o Stripe reenvia) ─
  for (const [rotulo, chamada] of [['a leitura da amarração', 1], ['a leitura do cronograma', 2], ['a gravação da amarração', 3]] as const) {
    const b = bancoFalso(cronograma(), c => (c.n === chamada ? { error: { message: 'timeout' } } : undefined))
    eq(`falha n${rotulo}: lança, nunca "sem parcela"`, await lanca(() => amarrarCobrancaAParcela(b, 'F', 'in_1')), 'lançou')
  }
  {
    // Sem parcela em aberto, a reconferência antes de anular também falha: lança.
    const b = bancoFalso([P(1, 'paid', 'in_1')], c => (c.n === 3 ? { error: { message: 'timeout' } } : undefined))
    eq('falha na reconferência antes de anular: lança', await lanca(() => amarrarCobrancaAParcela(b, 'F', 'in_2')), 'lançou')
  }

  // ── Duas entregas ao mesmo tempo ─────────────────────────────────────
  {
    // A outra entrega amarra ESTA cobrança à parcela 3 entre a 1ª e a 2ª leitura.
    const b = bancoFalso([P(1, 'paid', 'in_1'), P(2, 'paid', 'in_2'), P(3)], (c, banco) => {
      if (c.n === 2) banco.linhas[2].stripe_invoice = 'in_3'
    })
    eq('corrida entre as leituras: a reconferência acha a parcela, não anula',
       await amarrarCobrancaAParcela(b, 'F', 'in_3'), { acao: 'ja_amarrada', seq: 3 })
  }
  {
    // Outra cobrança leva a parcela 1 no instante da gravação: vai para a 2.
    const b = bancoFalso(cronograma(), (c, banco) => {
      if (c.modo === 'update' && banco.linhas[0].stripe_invoice == null) banco.linhas[0].stripe_invoice = 'in_OUTRA'
    })
    eq('gravação perdida para outra cobrança: tenta a próxima parcela', await amarrarCobrancaAParcela(b, 'F', 'in_1'), { acao: 'amarrada', seq: 2 })
    eq('…e a parcela 1 fica com a outra', amarras(b), ['1:in_OUTRA', '2:in_1', '3:-'])
  }
  {
    // Perde a corrida em toda tentativa: lança em vez de anular ou girar para sempre.
    let k = 0
    const b = bancoFalso([P(1), P(2), P(3), P(4)], (c, banco) => {
      if (c.modo === 'update') { const l = banco.linhas.find(x => x.stripe_invoice == null); if (l) l.stripe_invoice = `in_outra${++k}` }
    })
    eq('três corridas perdidas: lança', await lanca(() => amarrarCobrancaAParcela(b, 'F', 'in_1')), 'lançou')
  }

  // ── parcelaDaInvoice (invoice.paid e invoice.payment_failed) ─────────
  {
    const plano = { id: 'p1', invoice_id: 'F' }
    const b = bancoFalso([P(1, 'paid', 'in_1'), P(2, 'failed', 'in_2'), P(3)])
    eq('a parcela amarrada a esta cobrança, mesmo paga', await parcelaDaInvoice(b, plano, { id: 'in_1' }), { seq: 1, status: 'paid', amount: 350, stripeInvoice: 'in_1', stripeIntent: null })
    eq('sem amarração: a de menor número ainda sem cobrança', await parcelaDaInvoice(b, plano, { id: 'in_novo' }), { seq: 3, status: 'scheduled', amount: 350, stripeInvoice: null, stripeIntent: null })
    eq('sem amarração e o período é de uma parcela paga por fora: devolve ela',
       await parcelaDaInvoice(bancoFalso([P(1, 'paid'), P(2)]), plano, { id: 'in_novo' }), { seq: 1, status: 'paid', amount: 350, stripeInvoice: null, stripeIntent: null })
    eq('a paga antes do agendamento não recebe cobrança',
       await parcelaDaInvoice(bancoFalso([P(1, 'paid', PAGA_ANTES_DO_AGENDAMENTO), P(2)]), plano, { id: 'in_novo' }), { seq: 2, status: 'scheduled', amount: 350, stripeInvoice: null, stripeIntent: null })
    eq('a quitada por ESTA cobrança traz o pagamento (entrega repetida ≠ cobrado a mais)',
       (await parcelaDaInvoice(bancoFalso([{ ...P(1, 'paid', 'in_1'), stripe_intent: 'pi_1' }, P(2)]), plano, { id: 'in_1' }))?.stripeIntent, 'pi_1')
    const erroOriginal = console.error; console.error = () => {}
    eq('cronograma todo pago: nenhuma', await parcelaDaInvoice(bancoFalso([P(1, 'paid', 'in_1')]), plano, { id: 'in_9' }), null)
    console.error = erroOriginal
    eq('plano sem fatura: nenhuma, sem consulta', await parcelaDaInvoice(bancoFalso([]), { id: 'p' }, { id: 'in_1' }), null)
    eq('falha na leitura da amarração: lança (não vira "cobrado a mais")',
       await lanca(() => parcelaDaInvoice(bancoFalso(cronograma(), c => (c.n === 1 ? { error: { message: 'x' } } : undefined)), plano, { id: 'in_1' })), 'lançou')
    eq('falha na leitura do cronograma: lança',
       await lanca(() => parcelaDaInvoice(bancoFalso(cronograma(), c => (c.n === 2 ? { error: { message: 'x' } } : undefined)), plano, { id: 'in_1' })), 'lançou')
  }

  console.log(`parcela-stripe: ${passou} passaram, ${falhou} falharam`)
  if (falhou) process.exit(1)
})()
