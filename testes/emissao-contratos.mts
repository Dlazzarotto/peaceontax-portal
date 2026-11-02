// testes/emissao-contratos.mts — a rotina diária dos contratos por fatura
// (lib/emissao-contratos.ts), com um banco FALSO.
//
// A regra (quando e quanto) já tem teste próprio (contrato-unico.mts). Aqui é
// o que só acontece rodando sozinho, de madrugada, na carteira inteira: não
// emitir duas vezes o mesmo período, não pular um, não deixar fatura sem
// itens, encerrar o que acabou só com a trilha gravada, avisar a equipe uma
// vez por dia — e, na simulação, não gravar nada.

import { emitirFaturasDosContratos } from '../lib/emissao-contratos.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

type Op = { tabela: string; op: string; dados?: any; filtros: [string, string, any][] }

/**
 * Só o que a rotina usa do supabase-js: from().select/insert/update/delete,
 * os filtros encadeados, maybeSingle/single e a resposta "thenable"; rpc.
 */
function bancoFalso(cfg: {
  planos: any[]
  itens?: any[]
  faturasDoPeriodo?: { plan_id: string; competencia: string }[]
  erroPlanos?: string
  insertFatura?: 'ok' | '23505' | 'erro'
  insertItens?: 'ok' | 'erro'
  insertTrilha?: 'ok' | 'erro'
  trilhaDeHoje?: string[]
}) {
  const ops: Op[] = []
  let numero = 0
  const db: any = {
    ops,
    rpc(nome: string) {
      ops.push({ tabela: 'rpc', op: nome, filtros: [] })
      numero++
      return Promise.resolve({ data: `INV-2026-${String(numero).padStart(4, '0')}`, error: null })
    },
    from(tabela: string) {
      const q: Op & any = { tabela, op: 'select', filtros: [] }
      const filtro = (tipo: string) => (c: string, v?: any) => { q.filtros.push([tipo, c, v]); return q }
      q.select = (_c?: string, o?: any) => { if (q.op === 'select') q.cabeca = o; return q }
      q.eq = filtro('eq'); q.in = filtro('in'); q.or = filtro('or'); q.gte = filtro('gte')
      q.order = () => q; q.limit = () => q
      q.insert = (dados: any) => { q.op = 'insert'; q.dados = dados; return q }
      q.update = (dados: any) => { q.op = 'update'; q.dados = dados; return q }
      q.delete = () => { q.op = 'delete'; return q }
      const resolver = () => {
        ops.push({ tabela, op: q.op, dados: q.dados, filtros: q.filtros })
        const f = (c: string) => (q.filtros.find(([, k]: any) => k === c) || [])[2]
        if (tabela === 'payment_plans' && q.op === 'select') {
          return cfg.erroPlanos ? { data: null, error: { message: cfg.erroPlanos } } : { data: cfg.planos, error: null }
        }
        if (tabela === 'payment_plan_items') return { data: cfg.itens || [], error: null }
        if (tabela === 'invoices' && q.op === 'select') {
          const achou = (cfg.faturasDoPeriodo || []).find(x => x.plan_id === f('plan_id') && x.competencia === f('competencia'))
          return { data: achou ? { id: 'ja', number: 'INV-OLD' } : null, error: null }
        }
        if (tabela === 'invoices' && q.op === 'insert') {
          if (cfg.insertFatura === '23505') return { data: null, error: { code: '23505', message: 'duplicate key' } }
          if (cfg.insertFatura === 'erro') return { data: null, error: { code: 'XX', message: 'falhou' } }
          return { data: { id: `inv-${numero}`, number: q.dados.number, client_id: q.dados.client_id, total: q.dados.total, paid_total: 0, due_date: q.dados.due_date, doc_type: 'invoice', payment_plan: 'full' }, error: null }
        }
        if (tabela === 'invoice_items' && q.op === 'insert') {
          return cfg.insertItens === 'erro' ? { error: { message: 'itens recusados' } } : { error: null }
        }
        if (tabela === 'plan_audit' && q.op === 'select') {
          return { count: (cfg.trilhaDeHoje || []).includes(f('plan_id')) ? 1 : 0, error: null }
        }
        if (tabela === 'plan_audit' && q.op === 'insert') {
          return cfg.insertTrilha === 'erro' ? { error: { message: 'trilha recusada' } } : { error: null }
        }
        return { data: null, error: null }
      }
      q.maybeSingle = () => Promise.resolve(resolver())
      q.single = () => Promise.resolve(resolver())
      q.then = (ok: any, err?: any) => Promise.resolve(resolver()).then(ok, err)
      return q
    },
  }
  return db
}

const avisos: any[] = []
const avisar = async (_db: any, inv: any) => { avisos.push(inv.number); return { email: true } }
const semEmail = async () => ({ email: false, motivo: 'cadastro sem e-mail' })

const contrato = (x: any = {}) => ({
  id: 'p1', client_id: 'c1', kind: 'monthly', status: 'active', description: 'Bookkeeping + Payroll',
  monthly_amount: 420, discount: 50, due_days: 15, billing_interval: 'monthly', collection_method: 'fatura',
  due_day: 10, start_date: '2026-01-10', end_date: null, next_charge_date: '2026-10-10', created_by: 'u1',
  clients: { name: 'Ana', business_name: 'Padaria Boa' }, ...x,
})
const linhas = [
  { plan_id: 'p1', service_id: 's1', description: 'Bookkeeping', quantity: 1, unit_price: 350, sort_order: 0 },
  { plan_id: 'p1', service_id: null, description: 'Payroll', quantity: 1, unit_price: 120, sort_order: 1 },
]
const de = (db: any, tabela: string, op: string) => db.ops.filter((o: Op) => o.tabela === tabela && o.op === op)

// ── 1. O dia chegou: emite, detalha, anda a régua UM passo, avisa ──
{
  const db = bancoFalso({ planos: [contrato()], itens: linhas })
  const r = await emitirFaturasDosContratos(db, { hoje: '2026-10-10', avisar })
  eq('emitiu uma', r.emitidas.map(e => [e.numero, e.total, e.competencia]), [['INV-2026-0001', 420, '2026-10-01']])
  const fat = de(db, 'invoices', 'insert')[0].dados
  eq('fatura: enviada, emissão hoje, vence em 15 dias', [fat.status, fat.issue_date, fat.due_date], ['sent', '2026-10-10', '2026-10-25'])
  eq('fatura: bruto, desconto e total', [fat.subtotal, fat.discount, fat.total], [470, 50, 420])
  eq('fatura: ligada ao contrato e ao período', [fat.plan_id, fat.competencia, fat.created_by], ['p1', '2026-10-01', 'u1'])
  eq('fatura: diz o período', fat.notes, 'Contrato recorrente — outubro de 2026.')
  eq('itens: as duas linhas, com o serviço do catálogo', de(db, 'invoice_items', 'insert')[0].dados.map((i: any) => [i.description, i.amount, i.service_id]),
     [['Bookkeeping', 350, 's1'], ['Payroll', 120, null]])
  const regua = de(db, 'payment_plans', 'update')[0]
  eq('régua: novembro', regua.dados.next_charge_date, '2026-11-10')
  eq('régua: só se ninguém andou antes', regua.filtros.filter((f: any) => f[0] === 'eq').map((f: any) => [f[1], f[2]]),
     [['id', 'p1'], ['next_charge_date', '2026-10-10']])
  eq('avisou o cliente', avisos.includes('INV-2026-0001'), true)
  eq('trilha da fatura com o resultado do e-mail', de(db, 'invoice_audit', 'insert')[0].dados.next.email, true)
  eq('numerou DEPOIS de conferir o período', db.ops.findIndex((o: Op) => o.tabela === 'invoices' && o.op === 'select')
     < db.ops.findIndex((o: Op) => o.tabela === 'rpc'), true)
}

// ── 2. O período já tem fatura (a rodada de ontem não andou a régua) ──
{
  const db = bancoFalso({ planos: [contrato()], itens: linhas, faturasDoPeriodo: [{ plan_id: 'p1', competencia: '2026-10-01' }] })
  const r = await emitirFaturasDosContratos(db, { hoje: '2026-10-11', avisar })
  eq('não emite de novo', [r.emitidas.length, r.jaEmitidas.length], [0, 1])
  eq('não gasta número', de(db, 'rpc', 'next_invoice_number').length, 0)
  eq('mas anda a régua', de(db, 'payment_plans', 'update')[0]?.dados.next_charge_date, '2026-11-10')
}

// ── 3. Duas rodadas juntas: o índice único segura (23505) ──
{
  const db = bancoFalso({ planos: [contrato()], itens: linhas, insertFatura: '23505' })
  const r = await emitirFaturasDosContratos(db, { hoje: '2026-10-10', avisar })
  eq('23505 conta como já emitida', [r.emitidas.length, r.jaEmitidas.length, r.falhas.length], [0, 1, 0])
  eq('sem itens soltos', de(db, 'invoice_items', 'insert').length, 0)
}

// ── 4. Itens recusados: a fatura NÃO fica sem itens, e a régua NÃO anda ──
{
  const db = bancoFalso({ planos: [contrato()], itens: linhas, insertItens: 'erro' })
  const r = await emitirFaturasDosContratos(db, { hoje: '2026-10-10', avisar })
  eq('falha registrada', r.falhas.map(f => f.motivo), ['itens: itens recusados'])
  eq('a fatura recém-nascida é desfeita', de(db, 'invoices', 'delete').length, 1)
  eq('a régua fica (amanhã tenta de novo)', de(db, 'payment_plans', 'update').length, 0)
  eq('ninguém é avisado de fatura que não existe', r.emitidas.length, 0)
}

// ── 5. Chegou ao fim: encerra, com a trilha ANTES ──
{
  const db = bancoFalso({ planos: [contrato({ end_date: '2026-10-05', next_charge_date: '2026-11-10' })], itens: linhas })
  const r = await emitirFaturasDosContratos(db, { hoje: '2026-10-05', avisar })
  eq('encerrado', r.encerrados.length, 1)
  const iTrilha = db.ops.findIndex((o: Op) => o.tabela === 'plan_audit' && o.op === 'insert')
  const iUpd = db.ops.findIndex((o: Op) => o.tabela === 'payment_plans' && o.op === 'update')
  eq('trilha antes de mudar o status', iTrilha >= 0 && iUpd > iTrilha, true)
  eq('vira concluído, só se ainda ativo', [de(db, 'payment_plans', 'update')[0].dados.status,
     de(db, 'payment_plans', 'update')[0].filtros.some((f: any) => f[1] === 'status' && f[2] === 'active')], ['completed', true])
  eq('não emite nada', de(db, 'invoices', 'insert').length, 0)

  const db2 = bancoFalso({ planos: [contrato({ end_date: '2026-10-05' })], itens: linhas, insertTrilha: 'erro' })
  const r2 = await emitirFaturasDosContratos(db2, { hoje: '2026-10-06', avisar })
  eq('trilha recusada: NÃO encerra', [r2.encerrados.length, de(db2, 'payment_plans', 'update').length, r2.falhas.length], [0, 0, 1])
}

// ── 6. Defeito do contrato: não emite, alerta a equipe UMA vez por dia ──
{
  const db = bancoFalso({ planos: [contrato({ monthly_amount: 400 })], itens: linhas })
  const r = await emitirFaturasDosContratos(db, { hoje: '2026-10-10', avisar })
  eq('recusado com o motivo', r.recusados.map(x => /não bate/.test(x.motivo)), [true])
  eq('alerta à equipe', de(db, 'plan_alerts', 'insert').map((o: Op) => o.dados.type), ['contrato_nao_emitido'])
  const db2 = bancoFalso({ planos: [contrato({ monthly_amount: 400 })], itens: linhas, trilhaDeHoje: ['p1'] })
  await emitirFaturasDosContratos(db2, { hoje: '2026-10-10', avisar })
  eq('já alertado hoje: não repete', de(db2, 'plan_alerts', 'insert').length, 0)

  const db3 = bancoFalso({ planos: [contrato({ next_charge_date: null })], itens: linhas })
  const r3 = await emitirFaturasDosContratos(db3, { hoje: '2026-10-10', avisar })
  eq('ativo sem data também alerta', r3.recusados.length, 1)
}

// ── 7. Simulação: diz o que faria e não grava NADA ──
{
  const db = bancoFalso({ planos: [contrato(), contrato({ id: 'p2', end_date: '2026-10-01' }), contrato({ id: 'p3', monthly_amount: 1 })],
    itens: [...linhas, ...linhas.map(l => ({ ...l, plan_id: 'p2' })), ...linhas.map(l => ({ ...l, plan_id: 'p3' }))] })
  const r = await emitirFaturasDosContratos(db, { hoje: '2026-10-10', dry: true, avisar })
  eq('simulação lista os três casos', [r.emitidas.length, r.encerrados.length, r.recusados.length], [1, 1, 1])
  eq('simulação não grava', db.ops.filter((o: Op) => o.op !== 'select').length, 0)
}

// ── 8. Ainda não é o dia: silêncio (não é defeito) ──
{
  const db = bancoFalso({ planos: [contrato({ next_charge_date: '2026-10-20' })], itens: linhas })
  const r = await emitirFaturasDosContratos(db, { hoje: '2026-10-10', avisar })
  eq('nada a fazer, nada gravado, nenhum alerta', [r.emitidas.length, r.recusados.length, db.ops.filter((o: Op) => o.op !== 'select').length], [0, 0, 0])
}

// ── 9. E-mail que não sai vai para a trilha e para a resposta ──
{
  const db = bancoFalso({ planos: [contrato()], itens: linhas })
  const r = await emitirFaturasDosContratos(db, { hoje: '2026-10-10', avisar: semEmail })
  eq('a resposta diz por quê', [r.emitidas[0].email, r.emitidas[0].motivoEmail], [false, 'cadastro sem e-mail'])
  eq('a trilha também', de(db, 'invoice_audit', 'insert')[0].dados.next.motivo, 'cadastro sem e-mail')
  const db2 = bancoFalso({ planos: [contrato()], itens: linhas })
  const r2 = await emitirFaturasDosContratos(db2, { hoje: '2026-10-10', avisar: async () => { throw new Error('rede caiu') } })
  eq('aviso que explode não derruba a rotina (a fatura já existe)', [r2.emitidas.length, /rede caiu/.test(String(r2.emitidas[0].motivoEmail))], [1, true])
}

// ── 10. Consulta que falha não vira "nenhum contrato" ──
{
  const db = bancoFalso({ planos: [], erroPlanos: 'timeout' })
  let erro = ''
  try { await emitirFaturasDosContratos(db, { hoje: '2026-10-10', avisar }) } catch (e) { erro = (e as Error).message }
  eq('a rotina falha alto', erro, 'Contratos: timeout')
}

// ── 11. Trimestral: o período na fatura e o passo de três meses ──
{
  const db = bancoFalso({ planos: [contrato({ billing_interval: 'quarterly' })], itens: linhas })
  await emitirFaturasDosContratos(db, { hoje: '2026-10-10', avisar })
  eq('nota do trimestre', de(db, 'invoices', 'insert')[0].dados.notes, 'Contrato recorrente — out a dez de 2026.')
  eq('próxima em janeiro', de(db, 'payment_plans', 'update')[0].dados.next_charge_date, '2027-01-10')
}

console.log(`emissao-contratos: ${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
