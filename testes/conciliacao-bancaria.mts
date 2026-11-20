// testes/conciliacao-bancaria.mts — a diferença da conciliação bancária
//
// A conciliação do ano fecha o livro do cliente com o extrato do banco. A
// tela dizia "diferença 0.00" e a rota recusava com $3635.15: cada uma somava
// de um jeito, e a da rota virava zero quando a consulta falhava. Aqui a conta
// é uma só, em centavos, e marcado que não está no registro não passa calado.

import {
  apurarConciliacao, emLotes, LOTE_DA_MARCACAO, dataISO, normalizarConciliacao, juntarElegiveis,
  linhaParaATela, DESCRICAO_NA_TELA, mensagemDeExcesso, gravarSemColunasAusentes, avisoDeColunas,
  CAMPOS_ESSENCIAIS, TETO_DA_RESPOSTA, TETO_DE_LANCAMENTOS,
} from '../lib/conciliacao-bancaria.ts'
import { colunaAusente } from '../lib/caixa-firma.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

const tx = (id: string, amount: number | string | null) => ({ id, amount })

// ── O caso da tela: 4294.57 + 275445.85 − 279081.00 = 659.42 ───────────
{
  const elegiveis = [tx('a', 275445.85), tx('b', -279081.00), tx('c', -50)]
  const r = apurarConciliacao({ saldoInicial: '4294.57', saldoFinal: '659.42', elegiveis, marcados: ['a', 'b'] })
  eq('o caso da tela fecha', [r.diferenca, r.fecha], [0, true])
  eq('entradas e saídas marcadas', [r.entradas, r.qtdEntradas, r.saidas, r.qtdSaidas], [275445.85, 1, -279081, 1])
  eq('saldo calculado', r.saldoCalculado, 659.42)
  eq('o que não foi marcado não entra', r.total, -3635.15)
  const nenhum = apurarConciliacao({ saldoInicial: '4294.57', saldoFinal: '659.42', elegiveis, marcados: [] })
  eq('sem nada marcado a diferença é saldo inicial − final (o número da mensagem falsa)', nenhum.diferenca, 3635.15)
}

// ── Muitos lançamentos, em centavos ──────────────────────────────────────
{
  const elegiveis = Array.from({ length: 965 }, (_, i) => tx(`t${i}`, i % 7 === 0 ? 0.1 : -0.1))
  const marcados = elegiveis.map(t => t.id)
  const r = apurarConciliacao({ saldoInicial: 0, saldoFinal: 0, elegiveis, marcados })
  const esperado = Math.round((138 * 0.1 - 827 * 0.1) * 100) / 100
  eq('965 lançamentos de 10 centavos somam certo', r.total, esperado)
  eq('…e a contagem bate', [r.qtdEntradas, r.qtdSaidas], [138, 827])
  eq('valor em texto, como vem do banco', apurarConciliacao({ saldoInicial: '10.00', saldoFinal: '7.66', elegiveis: [tx('x', '-2.34')], marcados: ['x'] }).fecha, true)
  eq('um centavo de diferença não fecha', apurarConciliacao({ saldoInicial: 10, saldoFinal: 7.65, elegiveis: [tx('x', -2.34)], marcados: ['x'] }).diferenca, 0.01)
  eq('…e diz o sinal', apurarConciliacao({ saldoInicial: 10, saldoFinal: 7.67, elegiveis: [tx('x', -2.34)], marcados: ['x'] }).diferenca, -0.01)
}

// ── Marcado fora do registro não passa calado ─────────────────────────────
{
  const elegiveis = [tx('a', 100), tx('b', -40)]
  const r = apurarConciliacao({ saldoInicial: 0, saldoFinal: 60, elegiveis, marcados: ['a', 'b', 'apagado', 'outra-conta'] })
  eq('ids fora dos elegíveis são listados', r.naoElegiveis, ['apagado', 'outra-conta'])
  eq('…e não entram na soma', r.total, 60)
  eq('id repetido conta uma vez', apurarConciliacao({ saldoInicial: 0, saldoFinal: 100, elegiveis, marcados: ['a', 'a'] }).total, 100)
  eq('lançamento de valor zero não é entrada nem saída', (() => {
    const z = apurarConciliacao({ saldoInicial: 0, saldoFinal: 0, elegiveis: [tx('z', 0), tx('n', null)], marcados: ['z', 'n'] })
    return [z.qtdEntradas, z.qtdSaidas, z.fecha, z.naoElegiveis.length]
  })(), [0, 0, true, 0])
  eq('saldo vazio ou inválido conta como zero', apurarConciliacao({ saldoInicial: '', saldoFinal: 'abc', elegiveis, marcados: [] }).diferenca, 0)
}

// ── Lotes da marcação: a URL do update não pode crescer sem limite ───────
eq('o lote é de 100', LOTE_DA_MARCACAO, 100)
eq('965 ids viram 10 lotes', emLotes(Array.from({ length: 965 }, (_, i) => i)).map(l => l.length), [100, 100, 100, 100, 100, 100, 100, 100, 100, 65])
eq('nenhum id, nenhum lote', emLotes([]).length, 0)
eq('nenhum lote passa do tamanho', emLotes(Array.from({ length: 1000 }, (_, i) => i)).every(l => l.length <= LOTE_DA_MARCACAO), true)

// ── A tela tem de CARREGAR: o histórico não depende de coluna do painel ─────
eq('data do tipo date passa como está', dataISO('2026-10-31'), '2026-10-31')
eq('timestamptz vira só a data (o campo de data da tela não aceita o resto)', dataISO('2026-10-31T00:00:00+00:00'), '2026-10-31')
eq('data no formato dos EUA não é ISO', dataISO('10/31/2026'), null)
eq('vazio e nulo viram nulo', [dataISO(''), dataISO(null), dataISO(undefined)], [null, null, null])
{
  const completa = normalizarConciliacao({ id: 'r1', statement_date: '2026-10-31', beginning_balance: '4294.57', ending_balance: 659.42,
    cleared_count: 965, status: 'completed', completed_at: '2026-11-03T20:00:00Z', cleared_total: -3635.15, created_by: 'u' })
  eq('linha completa', completa, { id: 'r1', statement_date: '2026-10-31', beginning_balance: 4294.57, ending_balance: 659.42,
    cleared_count: 965, status: 'completed', completed_at: '2026-11-03T20:00:00Z' })
  // O caso que derrubava a tela: o painel não criou `completed_at` nem `cleared_count`.
  const doPainel = normalizarConciliacao({ id: 'r2', statement_date: '2026-10-31T00:00:00+00:00', beginning_balance: 0, ending_balance: '10.5', status: 'in_progress' })
  eq('coluna que o painel não criou vira nulo, sem derrubar nada', [doPainel.cleared_count, doPainel.completed_at], [null, null])
  eq('…e a data do painel em timestamptz é cortada', doPainel.statement_date, '2026-10-31')
  eq('…e o valor em texto vira número', doPainel.ending_balance, 10.5)
  eq('saldo ilegível vira nulo, não NaN', normalizarConciliacao({ id: 'x', ending_balance: 'abc', status: 'x' }).ending_balance, null)
  eq('linha nula não estoura', normalizarConciliacao(null).id, '')
}

// ── Os elegíveis: livres + os da conciliação em andamento, numa lista só ────
{
  const l = (id: string, tx_date: string, extra: any = {}) => ({ id, tx_date, amount: 1, ...extra })
  const livres = [l('b', '2026-10-02'), l('a', '2026-10-02'), l('c', '2026-10-01')]
  const daAberta = [l('m', '2026-09-30', { reconciliation_id: 'r' }), l('a', '2026-10-02')]
  eq('junta, sem repetir, na ordem data → id', juntarElegiveis(livres, daAberta).map(t => t.id), ['m', 'c', 'a', 'b'])
  eq('sem conciliação em andamento, só os livres em ordem', juntarElegiveis(livres).map(t => t.id), ['c', 'a', 'b'])
  eq('lista nula não estoura', juntarElegiveis(null, undefined, []).length, 0)
  eq('a primeira ocorrência vale (a dos livres)', juntarElegiveis([l('x', '2026-01-01', { amount: 5 })], [l('x', '2026-01-01', { amount: 9 })])[0].amount, 5)
}

// ── O tamanho do que vai para a tela ────────────────────────────────────────
{
  const longa = 'ORIG CO NAME:ADP WAGE PAY ORIG ID:9333006057 DESC DATE:251031 CO ENTRY DESCR:WAGE PAY SEC:CCD TRACE#:021000020000001 EED:251031 IND ID:'
  const t = { id: 'x', description: longa, amount: -1 }
  eq('descrição comprida vai cortada no que a tela usa', linhaParaATela(t).description.length, DESCRICAO_NA_TELA)
  eq('…sem mexer no objeto original', t.description.length, longa.length)
  eq('descrição curta vai inteira (o mesmo objeto)', linhaParaATela({ id: 'y', description: 'CHECK 1043' }).description, 'CHECK 1043')
  eq('descrição nula continua nula', linhaParaATela({ id: 'z', description: null }).description, null)
  eq('a tela mostra 70: o corte de 100 não esconde nada dela', DESCRICAO_NA_TELA >= 70, true)
  eq('o teto de bytes fica abaixo dos 4,5 MB da Vercel', TETO_DA_RESPOSTA < 4.5 * 1024 * 1024, true)
  // O teto pela CONTAGEM não basta sozinho, e é por isso que a rota confere os
  // BYTES antes de responder: 15 mil linhas típicas cabem com folga; 15 mil de
  // pior caso (descrição de banco no máximo, payee e id compridos) não cabem.
  const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  const bytes = (linhas: any[]) => Buffer.byteLength(JSON.stringify(linhas))
  const tipicas = Array.from({ length: TETO_DE_LANCAMENTOS }, (_, i) => linhaParaATela({
    id: id(i), tx_date: '2026-10-31', description: 'AMAZON MKTPLACE PMTS AMZN.COM/BILL WA', amount: -84.02, payee: 'Amazon', reconciliation_id: null }))
  const piores = Array.from({ length: TETO_DE_LANCAMENTOS }, (_, i) => linhaParaATela({
    id: id(i), tx_date: '2026-10-31', description: longa, amount: -123456.78,
    payee: 'Fornecedor com nome comprido de verdade LLC', reconciliation_id: id(i + 1) }))
  eq('15 mil linhas típicas cabem na resposta', bytes(tipicas) < TETO_DA_RESPOSTA, true)
  eq('15 mil de pior caso NÃO cabem: a rota tem de conferir os bytes, não só a contagem', bytes(piores) > TETO_DA_RESPOSTA, true)
  const m = mensagemDeExcesso(16000, '2026-10-31')
  eq('a recusa por volume diz quantos e a data (MM/DD/YYYY)', [m.includes('16.000'), m.includes('10/31/2026')], [true, true])
  eq('…e o que fazer', /data final[\s\S]*primeiro extrato/.test(m), true)
}

// ── Gravar sem a coluna opcional que o painel não criou ──────────────────────
{
  const falta = (col: string) => ({ code: 'PGRST204', message: `Could not find the '${col}' column of 'bank_reconciliations' in the schema cache` })
  const banco = (faltando: string[], outroErro: any = null) => {
    const chamadas: Record<string, unknown>[] = []
    const grava = async (c: Record<string, unknown>) => {
      chamadas.push(c)
      if (outroErro) return { data: null, error: outroErro }
      const f = Object.keys(c).find(k => faltando.includes(k))
      return f ? { data: null, error: falta(f) } : { data: { id: 'novo' }, error: null }
    }
    return { chamadas, grava }
  }
  const campos = { client_id: 'c', account_id: 'a', statement_date: '2026-10-31', beginning_balance: 0, ending_balance: 1,
    status: 'completed', completed_at: 'agora', updated_at: 'agora' }
  {
    const b = banco([])
    const r = await gravarSemColunasAusentes(campos, b.grava, colunaAusente)
    eq('tudo existe: uma gravação, nada de fora', [b.chamadas.length, r.semColuna, r.error], [1, [], null])
  }
  {
    const b = banco(['completed_at'])
    const r = await gravarSemColunasAusentes(campos, b.grava, colunaAusente)
    eq('falta completed_at: grava sem ela', [r.error, r.data, r.semColuna], [null, { id: 'novo' }, ['completed_at']])
    eq('…a segunda tentativa não leva a coluna', 'completed_at' in b.chamadas[1], false)
    eq('…e leva todo o resto', Object.keys(b.chamadas[1]).length, Object.keys(campos).length - 1)
    eq('…sem mexer nos campos de quem chamou', 'completed_at' in campos, true)
  }
  {
    const b = banco(['completed_at', 'updated_at'])
    const r = await gravarSemColunasAusentes(campos, b.grava, colunaAusente)
    eq('faltam duas: tira uma por vez', [r.error, r.semColuna, b.chamadas.length], [null, ['completed_at', 'updated_at'], 3])
  }
  {
    const b = banco(['status'])
    const r = await gravarSemColunasAusentes(campos, b.grava, colunaAusente)
    eq('falta coluna ESSENCIAL: é erro, sem gravar pela metade', [!!r.error, r.semColuna, b.chamadas.length], [true, [], 1])
    eq('as essenciais são as que dizem o que a conciliação é', CAMPOS_ESSENCIAIS.includes('status') && CAMPOS_ESSENCIAIS.includes('ending_balance'), true)
  }
  {
    const b = banco([], { code: '23505', message: 'duplicate key value' })
    const r = await gravarSemColunasAusentes(campos, b.grava, colunaAusente)
    eq('outro erro não vira "coluna ausente": volta como veio', [r.error?.code, b.chamadas.length], ['23505', 1])
  }
  {
    const b = banco([], { code: 'PGRST204', message: 'algo que não diz a coluna' })
    const r = await gravarSemColunasAusentes(campos, b.grava, colunaAusente)
    eq('coluna ausente sem nome não tira nada no chute', [!!r.error, b.chamadas.length], [true, 1])
  }
  {
    const b = banco(['reconciled_at'])
    const r = await gravarSemColunasAusentes({ reconciled_at: 'agora' }, b.grava, colunaAusente, ['reconciliation_id'])
    eq('o único campo era opcional e falta: nada a gravar, sem mandar {}', [r.error, r.semColuna, b.chamadas.length], [null, ['reconciled_at'], 1])
  }
  {
    const b = banco(['reconciled_at'])
    const r = await gravarSemColunasAusentes({ reconciliation_id: 'r', reconciled_at: null }, b.grava, colunaAusente, ['reconciliation_id'])
    eq('a marca do lançamento grava sem a data', [r.error, b.chamadas[1]], [null, { reconciliation_id: 'r' }])
  }
  {
    const b = banco(['reconciliation_id'])
    const r = await gravarSemColunasAusentes({ reconciliation_id: 'r', reconciled_at: null }, b.grava, colunaAusente, ['reconciliation_id'])
    eq('sem reconciliation_id não há marca: erro', !!r.error, true)
  }
  eq('sem coluna de fora, sem aviso', avisoDeColunas([]), null)
  eq('o aviso manda rodar a migração', /sql\/conciliacao-bancaria-v1\.sql/.test(avisoDeColunas(['completed_at']) || ''), true)
  eq('…no singular e no plural', [/essa coluna/.test(avisoDeColunas(['a']) || ''), /essas colunas/.test(avisoDeColunas(['a', 'b']) || '')], [true, true])
}

console.log(`conciliacao-bancaria: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
