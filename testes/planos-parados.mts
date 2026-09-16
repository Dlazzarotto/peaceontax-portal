import { diasParados, avisoDePlanoParado, DIAS_PARADO, alertarPlanosParados } from '../lib/planos-parados.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

const hoje = new Date('2026-09-16T18:00:00Z')

// contagem por data civil, sem tropecar em fuso nem em hora
eq('mesmo dia = 0', diasParados('2026-09-16', hoje), 0)
eq('ontem = 1', diasParados('2026-09-15', hoje), 1)
eq('sete dias', diasParados('2026-09-09', hoje), 7)
eq('carimbo com hora tambem conta', diasParados('2026-09-09T23:59:00Z', hoje), 7)
eq('virada de mes', diasParados('2026-08-31', hoje), 16)
eq('data futura nao fica negativa', diasParados('2026-09-20', hoje), 0)
eq('sem data = 0', diasParados(null, hoje), 0)
eq('data invalida = 0', diasParados('nao-e-data', hoje), 0)

// o texto diz o que falta
eq('entrada pendente aparece no texto',
  /pagar a entrada/.test(avisoDePlanoParado({ status: 'awaiting_entry', kind: 'installment', installments: 6 }, 9)), true)
eq('cadastro de debito aparece no texto',
  /cadastrar o débito automático/.test(avisoDePlanoParado({ status: 'awaiting_setup', description: 'Bookkeeping' }, 9)), true)
eq('usa o nome da empresa quando ha',
  /Padaria Boa/.test(avisoDePlanoParado({ status: 'awaiting_setup', clients: { name: 'Ana', business_name: 'Padaria Boa' } }, 8)), true)

// --- fake do banco, so o que a funcao usa ---
function fakeDb(planos: any[], auditoriasHoje: string[] = []) {
  const inseridos: any[] = []
  const db: any = {
    inseridos,
    from(tabela: string) {
      const f: any = { tabela, filtros: [] as any[] }
      f.select = (_c: string, _o?: any) => f
      f.eq = (c: string, v: any) => { f.filtros.push([c, v]); return f }
      f.in = () => f
      f.gte = () => f
      f.insert = (linha: any) => { inseridos.push({ tabela, ...linha }); return { then: (ok: any) => ok(null) } }
      f.then = (ok: any) => {
        if (tabela === 'payment_plans') return ok({ data: planos })
        const planId = (f.filtros.find(([c]: any) => c === 'plan_id') || [])[1]
        return ok({ count: auditoriasHoje.includes(planId) ? 1 : 0 })
      }
      return f
    },
  }
  return db
}

const parado = { id: 'p1', client_id: 'c1', kind: 'installment', status: 'awaiting_entry', installments: 4, updated_at: '2026-09-01', clients: { name: 'Ana' } }
const novo = { id: 'p2', client_id: 'c2', kind: 'monthly', status: 'awaiting_setup', updated_at: '2026-09-15', clients: { name: 'Bia' } }

let db = fakeDb([parado, novo])
let r = await alertarPlanosParados(db, { hoje })
eq('so o parado e alertado', r.alertados, ['p1'])
eq('gera alerta e trilha', db.inseridos.map((i: any) => i.tabela).sort(), ['plan_alerts', 'plan_audit'])

// ja alertado hoje: nao repete (o cron pode rodar duas vezes)
db = fakeDb([parado, novo], ['p1'])
r = await alertarPlanosParados(db, { hoje })
eq('nao repete alerta no mesmo dia', r.alertados, [])
eq('e nao grava nada', db.inseridos.length, 0)

// dry: lista sem escrever
db = fakeDb([parado, novo])
r = await alertarPlanosParados(db, { hoje, dry: true })
eq('dry lista', r.alertados, ['p1'])
eq('dry nao escreve', db.inseridos.length, 0)

// no limite exato do prazo ja entra
db = fakeDb([{ ...parado, updated_at: '2026-09-09' }])
eq(`${DIAS_PARADO} dias entra`, (await alertarPlanosParados(db, { hoje })).alertados, ['p1'])
db = fakeDb([{ ...parado, updated_at: '2026-09-10' }])
eq(`${DIAS_PARADO - 1} dias nao entra`, (await alertarPlanosParados(db, { hoje })).alertados, [])

// plano sem updated_at cai no created_at
db = fakeDb([{ ...parado, updated_at: null, created_at: '2026-08-20' }])
eq('sem updated_at usa created_at', (await alertarPlanosParados(db, { hoje })).alertados, ['p1'])

console.log(`\n${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
