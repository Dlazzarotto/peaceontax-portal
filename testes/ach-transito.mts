import {
  diasEmTransito, achEmTransito, avisoDeBaixaComAchEmTransito,
  alertarAchParado, DIAS_ACH_PARADO,
} from '../lib/ach-transito.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

const hoje = new Date('2026-09-17T14:00:00Z')

eq('mesmo dia = 0', diasEmTransito('2026-09-17T02:00:00Z', hoje), 0)
eq('quatro dias uteis tipicos', diasEmTransito('2026-09-13', hoje), 4)
eq('limite do alerta', diasEmTransito('2026-09-10', hoje), 7)
eq('sem data = 0', diasEmTransito(null, hoje), 0)
eq('data futura nao fica negativa', diasEmTransito('2026-09-30', hoje), 0)

// achEmTransito so acusa quando ha carimbo
eq('fatura sem ACH', achEmTransito({ ach_desde: null, ach_valor: 100 }), null)
eq('fatura com ACH', achEmTransito({ ach_desde: '2026-09-13T10:00:00Z', ach_valor: '250.00' }),
  { desde: '2026-09-13T10:00:00Z', valor: 250 })
eq('valor ausente vira zero, nao NaN', achEmTransito({ ach_desde: '2026-09-13', ach_valor: null })?.valor, 0)
eq('fatura inexistente', achEmTransito(null), null)

// o aviso precisa dizer o valor, os dias e o RISCO
const aviso = avisoDeBaixaComAchEmTransito('INV-2026-0042', { desde: '2026-09-13', valor: 250 }, 4)
eq('aviso cita a fatura', /INV-2026-0042/.test(aviso), true)
eq('aviso cita o valor', /\$250\.00/.test(aviso), true)
eq('aviso cita o risco de dobro', /DOBRO/.test(aviso), true)

// --- fake do banco ---
function fakeDb(faturas: any[], jaAlertadas: string[] = []) {
  const inseridos: any[] = []
  const db: any = {
    inseridos,
    from(tabela: string) {
      const f: any = { tabela, filtros: [] as any[] }
      f.select = () => f
      f.eq = (c: string, v: any) => { f.filtros.push([c, v]); return f }
      f.not = () => f
      f.gte = () => f
      f.insert = (l: any) => { inseridos.push({ tabela, ...l }); return { then: (ok: any) => ok(null) } }
      f.then = (ok: any) => {
        if (tabela === 'invoices') return ok({ data: faturas })
        const id = (f.filtros.find(([c]: any) => c === 'invoice_id') || [])[1]
        return ok({ count: jaAlertadas.includes(id) ? 1 : 0 })
      }
      return f
    },
  }
  return db
}

const parada = { id: 'i1', number: 'INV-1', client_id: 'c1', ach_desde: '2026-09-05', ach_valor: 300 }
const recente = { id: 'i2', number: 'INV-2', client_id: 'c2', ach_desde: '2026-09-15', ach_valor: 100 }

let db = fakeDb([parada, recente])
let r = await alertarAchParado(db, { hoje })
eq('so o parado alerta', r.alertados, ['i1'])
eq('grava trilha e alerta', db.inseridos.map((i: any) => i.tabela).sort(), ['invoice_audit', 'plan_alerts'])
eq('o alerta cita os dias', /12 dias/.test(db.inseridos.find((i: any) => i.tabela === 'plan_alerts').message), true)

db = fakeDb([parada, recente], ['i1'])
eq('nao repete no mesmo dia', (await alertarAchParado(db, { hoje })).alertados, [])
eq('e nao escreve nada', db.inseridos.length, 0)

db = fakeDb([parada])
eq('dry lista sem escrever', (await alertarAchParado(db, { hoje, dry: true })).alertados, ['i1'])
eq('dry nao escreve', db.inseridos.length, 0)

db = fakeDb([{ ...parada, ach_desde: '2026-09-10' }])
eq(`${DIAS_ACH_PARADO} dias entra`, (await alertarAchParado(db, { hoje })).alertados, ['i1'])
db = fakeDb([{ ...parada, ach_desde: '2026-09-11' }])
eq(`${DIAS_ACH_PARADO - 1} dias nao entra`, (await alertarAchParado(db, { hoje })).alertados, [])

eq('sem faturas em transito nao faz nada', await alertarAchParado(fakeDb([]), { hoje }), { alvo: 0, alertados: [] })

console.log(`\n${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
