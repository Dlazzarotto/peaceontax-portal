import { parcelaDaInvoice, recontarParcelas } from '../lib/parcela-stripe.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// Fake do PostgREST: só o que estas funções usam (eq / in / is / order / limit / count)
function fakeDb(linhas: any[]) {
  return {
    from() {
      const f: any = { filtros: [] as any[], _count: false }
      f.select = (_c: string, o?: any) => { f._count = !!o?.count; return f }
      f.eq = (c: string, v: any) => { f.filtros.push((r: any) => r[c] === v); return f }
      f.in = (c: string, v: any[]) => { f.filtros.push((r: any) => v.includes(r[c])); return f }
      f.is = (c: string, v: any) => { f.filtros.push((r: any) => (r[c] ?? null) === v); return f }
      f.order = (c: string) => { f._ord = c; return f }
      const resolver = () => {
        let d = linhas.filter(r => f.filtros.every((p: any) => p(r)))
        if (f._ord) d = [...d].sort((a, b) => a[f._ord] - b[f._ord])
        return d
      }
      f.limit = (n: number) => Promise.resolve({ data: resolver().slice(0, n) })
      f.then = (ok: any) => ok({ data: resolver(), count: resolver().length })
      return f
    },
  } as any
}

const plan = { id: 'p1', invoice_id: 'inv1', paid_installments: 0 }
const cron = (over: any[] = []) => {
  const base = [1, 2, 3, 4].map(seq => ({ invoice_id: 'inv1', seq, status: 'scheduled', stripe_invoice: null }))
  for (const o of over) Object.assign(base[o.seq - 1], o)
  return base
}

// 1. caso simples: nada amarrado, primeira em aberto
eq('primeira em aberto', await parcelaDaInvoice(fakeDb(cron()), plan, { id: 'in_A' }), { invoice_id:'inv1', seq: 1, status: 'scheduled', stripe_invoice: null })

// 2. A INVOICE MANDA: a 3a foi amarrada no finalized, mesmo com a 1a em aberto
eq('amarrada vence a ordem', (await parcelaDaInvoice(
  fakeDb(cron([{ seq: 3, stripe_invoice: 'in_C' }])), plan, { id: 'in_C' }))?.seq, 3)

// 3. O CASO QUE O CONTADOR ERRAVA: 2a falhou, 3a paga antes.
//    paid_installments = 1, entao o contador diria "parcela 2" — e a 3a e que foi paga.
const c3 = cron([{ seq: 1, status: 'paid' }, { seq: 2, status: 'failed', stripe_invoice: 'in_B' }, { seq: 3, stripe_invoice: 'in_C' }])
eq('fora de ordem: acha a 3a, nao a 2a', (await parcelaDaInvoice(fakeDb(c3), { ...plan, paid_installments: 1 }, { id: 'in_C' }))?.seq, 3)
eq('e a falha continua sendo a 2a', (await parcelaDaInvoice(fakeDb(c3), { ...plan, paid_installments: 1 }, { id: 'in_B' }))?.seq, 2)

// 4. parcela que falhou e foi recobrada: continua sendo a mesma
eq('recobranca cai na mesma parcela', (await parcelaDaInvoice(
  fakeDb(cron([{ seq: 2, status: 'failed', stripe_invoice: 'in_B' }])), plan, { id: 'in_B' }))?.seq, 2)

// 5. cronograma todo pago e chega evento repetido: nao inventa parcela
eq('sem parcela em aberto devolve null', await parcelaDaInvoice(
  fakeDb(cron([{seq:1,status:'paid'},{seq:2,status:'paid'},{seq:3,status:'paid'},{seq:4,status:'paid'}])), plan, { id: 'in_X' }), null)

// 6. recontagem: o total vem do cronograma, nao do contador
eq('reconta do cronograma', await recontarParcelas(
  fakeDb(cron([{ seq: 1, status: 'paid' }, { seq: 3, status: 'paid' }])), { ...plan, paid_installments: 99 }), 2)
eq('cronograma zerado conta zero', await recontarParcelas(fakeDb(cron()), { ...plan, paid_installments: 99 }), 0)

// 7. parcelamento antigo sem fatura de origem: cai no contador, sem quebrar
eq('sem fatura de origem usa o contador', await recontarParcelas(fakeDb([]), { id:'p2', invoice_id: null, paid_installments: 3 }), 3)
eq('sem fatura de origem nao tem parcela', await parcelaDaInvoice(fakeDb([]), { id:'p2', invoice_id: null }, { id: 'in_A' }), null)

console.log(`\n${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
