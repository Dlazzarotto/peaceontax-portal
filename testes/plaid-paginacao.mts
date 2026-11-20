// testes/plaid-paginacao.mts — o núcleo da sincronização com o Plaid
//
// As conexões tinham `last_synced_at` um segundo depois de criadas e nenhum
// outro: o botão morria no meio (uma gravação por transação, cursor só no fim)
// e recomeçava sempre do mesmo lugar. Aqui, com um Plaid de mentira: o cursor
// salvo a cada página, o prazo que para e diz que falta, a continuação de onde
// parou, o recomeço no erro de mutação e a linha recusada que não some.

import {
  percorrerSync, linhaDoPlaid, linhasNovasDaPagina, mensagemDaSincronizacao, mensagemDaConexao, ehErroDeMutacao,
  ERRO_DE_MUTACAO, POR_PAGINA, type PaginaDoSync,
  chaveDeDuplicidade, ehTravaDeDuplicidade, separarSuspeitas, gemeaDeOutraOrigem, exemploDaLinha,
} from '../lib/plaid-paginacao.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

/** Um Plaid de mentira: `total` transações em páginas de `porPagina`, cursor = "c<n>". */
function plaidDeMentira(total: number, porPagina: number, falhas: Record<string, any[]> = {}) {
  const pedidos: (string | undefined)[] = []
  const pedir = async (cursor: string | undefined): Promise<PaginaDoSync> => {
    pedidos.push(cursor)
    const fila = falhas[String(cursor)]
    if (fila && fila.length) throw fila.shift()
    const de = cursor ? Number(cursor.slice(1)) : 0
    const ate = Math.min(total, de + porPagina)
    return {
      added: Array.from({ length: ate - de }, (_, i) => ({ transaction_id: `t${de + i}`, date: '2025-01-01', amount: 1, account_id: 'p1' })),
      modified: [], removed: [], next_cursor: `c${ate}`, has_more: ate < total,
    }
  }
  return { pedir, pedidos }
}

const mutacao = () => Object.assign(new Error('Underlying transaction data changed'), { codigo: ERRO_DE_MUTACAO })

// ── Vai até o fim, salvando o cursor a cada página ───────────────────────────
{
  const p = plaidDeMentira(1200, 500)
  const vistos: string[] = [], salvos: (string | undefined)[] = []
  const r = await percorrerSync({
    cursorInicial: undefined, pedir: p.pedir, prazoMs: 60_000,
    aplicar: async pg => { for (const t of pg.added || []) vistos.push(t.transaction_id) },
    salvarCursor: async c => { salvos.push(c) },
  })
  eq('três páginas, completo', [r.completo, r.paginas, r.cursor], [true, 3, 'c1200'])
  eq('todas as transações aplicadas', vistos.length, 1200)
  eq('cursor salvo depois de CADA página', salvos, ['c500', 'c1000', 'c1200'])
  eq('a primeira página vai sem cursor', p.pedidos[0], undefined)
}

// ── O prazo: para, diz que falta, e a rodada seguinte continua de onde parou ─
{
  const p = plaidDeMentira(2000, 500)
  let relogio = 0
  const vistos = new Set<string>()
  const aplicar = async (pg: PaginaDoSync) => { relogio += 15_000; for (const t of pg.added || []) vistos.add(t.transaction_id) }
  const r1 = await percorrerSync({ cursorInicial: undefined, pedir: p.pedir, aplicar, prazoMs: 25_000, agora: () => relogio })
  eq('o prazo acaba: para incompleto, com o cursor de onde parou', [r1.completo, r1.paginas, r1.cursor], [false, 2, 'c1000'])
  const r2 = await percorrerSync({ cursorInicial: r1.cursor, pedir: p.pedir, aplicar, prazoMs: 25_000, agora: () => relogio })
  eq('a rodada seguinte continua de onde a anterior parou', [r2.completo, r2.cursor, p.pedidos[2]], [true, 'c2000', 'c1000'])
  eq('nada se perdeu entre as rodadas', vistos.size, 2000)
}

// ── O defeito antigo: sem cursor salvo, cada clique recomeçava do mesmo lugar ─
{
  // A função cortada por tempo não chega ao fim: com o cursor salvo a cada
  // página, o que já andou fica — a próxima rodada não volta ao começo.
  const p = plaidDeMentira(3000, 500)
  let cursorNoBanco: string | undefined
  let cortes = 0
  for (let clique = 0; clique < 10 && cursorNoBanco !== 'c3000'; clique++) {
    let paginasNesteClique = 0
    try {
      await percorrerSync({
        cursorInicial: cursorNoBanco, pedir: p.pedir, prazoMs: 1e12,
        aplicar: async () => { if (++paginasNesteClique > 2) { cortes++; throw new Error('função cortada pela Vercel') } },
        salvarCursor: async c => { cursorNoBanco = c },
      })
    } catch { /* cortada: o que foi salvo fica */ }
  }
  eq('cortada a cada 2 páginas, ainda assim chega ao fim', cursorNoBanco, 'c3000')
  eq('…em cliques que avançam', cortes >= 2, true)
}

// ── Cursor vazio: o Plaid ainda não tem o histórico ──────────────────────────
{
  const r = await percorrerSync({
    cursorInicial: 'c9', prazoMs: 1000,
    pedir: async () => ({ added: [], next_cursor: '', has_more: false }),
    aplicar: async () => {},
  })
  eq('cursor vazio é guardado vazio (a próxima rodada pede do começo)', [r.completo, r.cursor], [true, ''])
}

// ── Erro de mutação: recomeça desta rodada, depois do zero, depois desiste ──
{
  const p = plaidDeMentira(1000, 500, { c500: [mutacao()] })
  const r = await percorrerSync({ cursorInicial: undefined, pedir: p.pedir, aplicar: async () => {}, prazoMs: 60_000 })
  eq('mutação no meio: recomeça da página em que a rodada começou', [r.completo, r.reinicios, p.pedidos], [true, 1, [undefined, 'c500', undefined, 'c500']])
}
{
  const p = plaidDeMentira(1000, 500, { c500: [mutacao(), mutacao()] })
  const r = await percorrerSync({ cursorInicial: 'c500', pedir: p.pedir, aplicar: async () => {}, prazoMs: 60_000 })
  eq('repetiu no cursor salvo: recomeça do zero', [r.completo, r.reinicios, p.pedidos], [true, 2, ['c500', 'c500', undefined, 'c500']])
}
{
  const p = plaidDeMentira(1000, 500, { c500: [mutacao(), mutacao(), mutacao(), mutacao()] })
  let erro = ''
  try { await percorrerSync({ cursorInicial: 'c500', pedir: p.pedir, aplicar: async () => {}, prazoMs: 60_000 }) }
  catch (e) { erro = (e as any).codigo }
  eq('três mutações seguidas: desiste em voz alta', erro, ERRO_DE_MUTACAO)
}
{
  let erro = ''
  try {
    await percorrerSync({ cursorInicial: undefined, prazoMs: 60_000, aplicar: async () => {},
      pedir: async () => { throw Object.assign(new Error('the login details of this item have changed'), { codigo: 'ITEM_LOGIN_REQUIRED' }) } })
  } catch (e) { erro = (e as any).codigo }
  eq('outro erro do Plaid sobe sem recomeçar', erro, 'ITEM_LOGIN_REQUIRED')
}
eq('mutação pelo código', ehErroDeMutacao({ codigo: ERRO_DE_MUTACAO }), true)
eq('mutação pela mensagem', ehErroDeMutacao(new Error(`x ${ERRO_DE_MUTACAO} y`)), true)
eq('outro erro não é mutação', ehErroDeMutacao(new Error('ITEM_LOGIN_REQUIRED')), false)
eq('nulo não é mutação', ehErroDeMutacao(null), false)

// ── Trava de páginas ─────────────────────────────────────────────────────────
{
  const p = plaidDeMentira(100_000, 500)
  const r = await percorrerSync({ cursorInicial: undefined, pedir: p.pedir, aplicar: async () => {}, prazoMs: 1e12, maxPaginas: 5 })
  eq('a trava de páginas para incompleto', [r.completo, r.paginas], [false, 5])
}
eq('o maior count que o /transactions/sync aceita', POR_PAGINA, 500)

// ── A linha gravada é a de sempre ────────────────────────────────────────────
{
  const tx = { transaction_id: 'abc', date: '2025-03-10', amount: 12.345, merchant_name: 'Shell', name: 'SHELL OIL 123', account_id: 'p1', pending: false }
  eq('a convenção de sempre (saída negativa, fiscal_year da data, pendente na fila)',
    linhaDoPlaid(tx, { clientId: 'c1', instituicao: 'Bank of America', contaId: 'a1' }),
    { client_id: 'c1', source: 'plaid', plaid_tx_id: 'abc', account_id: 'a1', account_hint: 'Bank of America', tx_date: '2025-03-10',
      fiscal_year: 2025, description: 'Shell', amount: -12.35, payee: 'Shell', status: 'pending' })
  eq('entrada fica positiva', linhaDoPlaid({ ...tx, amount: -50 }, { clientId: 'c1', instituicao: null, contaId: null }).amount, 50)
  eq('sem merchant, a descrição é o nome e não há payee',
    [linhaDoPlaid({ ...tx, merchant_name: null }, { clientId: 'c1', instituicao: null, contaId: null }).description,
     linhaDoPlaid({ ...tx, merchant_name: null }, { clientId: 'c1', instituicao: null, contaId: null }).payee], ['SHELL OIL 123', null])
  const pagina: PaginaDoSync = { added: [tx, { ...tx, transaction_id: 'p', pending: true }, { ...tx }, { ...tx, transaction_id: 'def', account_id: 'desconhecida' }] }
  const linhas = linhasNovasDaPagina(pagina, { clientId: 'c1', instituicao: 'BofA', contaDe: id => (id === 'p1' ? 'a1' : null) })
  eq('pendente fica de fora; id repetido no mesmo lote vai uma vez', linhas.map(x => x.plaid_tx_id), ['abc', 'def'])
  eq('conta do Plaid desconhecida fica sem conta (não inventa)', linhas.map(x => x.account_id), ['a1', null])
}

// ── A frase da tela ──────────────────────────────────────────────────────────
eq('erro', mensagemDaSincronizacao({ ok: false, error: 'Cliente sem bancos conectados via Plaid' }), 'Erro: Cliente sem bancos conectados via Plaid')
eq('sem resposta', mensagemDaSincronizacao(null as any), 'Erro: a sincronização não respondeu')
{
  const m = mensagemDaSincronizacao({ ok: true, added: 1200, ruled: 30, incompleto: true, falhas: 2, details: ['Bank of America: +1200 (continua na próxima rodada)'] })
  eq('diz o que entrou e o que as regras reconheceram', [m.includes('1200 transações novas'), m.includes('30 reconhecidas')], [true, true])
  eq('diz que falta baixar e o que fazer', /Ainda há transações para baixar: clique em Sincronizar de novo/.test(m), true)
  eq('diz que o banco recusou', /2 transação\(ões\) o banco recusou/.test(m), true)
}
eq('tudo certo: sem alarme', /⚠️|⏳/.test(mensagemDaSincronizacao({ ok: true, added: 3, details: ['BofA: +3'] })), false)

// ── A frase de logo depois de conectar ───────────────────────────────────────
// O histórico quase nunca está pronto nesse momento: "0 importados" soava como
// "não há nada", e a primeira leitura que falhava sumia atrás do ✓.
eq('conexão recusada', mensagemDaConexao({ ok: false, error: 'INVALID_PUBLIC_TOKEN' }, true), 'Erro: INVALID_PUBLIC_TOKEN')
{
  const m = mensagemDaConexao({ ok: true, sync: { added: 0, completo: true } }, true)
  eq('zero logo ao conectar: diz que o histórico vem depois e o que fazer', [/libera em alguns minutos/.test(m), /clique em Sincronizar/.test(m)], [true, true])
  const f = mensagemDaConexao({ ok: true, sync: { error: 'PRODUCT_NOT_READY' } }, true)
  eq('a primeira leitura que falhou aparece', [/primeira leitura falhou \(PRODUCT_NOT_READY\)/.test(f), f.startsWith('✓ Banco conectado')], [true, true])
  eq('parou no prazo: diz quantas vieram e que falta',
    /120 transações já vieram[\s\S]*Sincronizar/.test(mensagemDaConexao({ ok: true, sync: { added: 120, completo: false } }, true)), true)
  eq('tudo de uma vez: só o número', mensagemDaConexao({ ok: true, sync: { added: 300, completo: true } }, true), '✓ Banco conectado — 300 transações importadas.')
  const c = mensagemDaConexao({ ok: true, sync: { added: 0, completo: true } }, false)
  eq('no portal do cliente não manda clicar em botão que ele não tem', /clique em Sincronizar/.test(c), false)
  eq('…e não promete o que não existe (não há sincronização automática)', [/automaticamente/.test(c), /próxima sincronização/.test(c)], [false, true])
}

// ── A trava de duplicidade do livro (mesma data, descrição e valor) ─────────
// A sincronização real trouxe 3.471 transações e 29 recusas por
// "bank_tx_dedupe_idx"; cada recusa derrubava o lote de 500, que caía na
// gravação uma a uma e comia o prazo da rodada.
eq('a chave é data, descrição exata e valor em centavos',
  chaveDeDuplicidade({ tx_date: '2025-03-10T00:00:00Z', description: 'Shell', amount: '-45.5' }), '2025-03-10|Shell|-4550')
eq('descrição com maiúscula diferente é outra chave (o índice compara o texto exato)',
  chaveDeDuplicidade({ tx_date: '2025-03-10', description: 'SHELL', amount: -45.5 }) === chaveDeDuplicidade({ tx_date: '2025-03-10', description: 'Shell', amount: -45.5 }), false)
eq('a trava de duplicidade é reconhecida',
  ehTravaDeDuplicidade({ code: '23505', message: 'duplicate key value violates unique constraint "bank_tx_dedupe_idx"' }), true)
eq('a do id do Plaid não é ela (o onConflict já trata)',
  ehTravaDeDuplicidade({ code: '23505', message: 'duplicate key value violates unique constraint "bank_transactions_plaid_tx_id_key"' }), false)
eq('outro erro não é trava', [ehTravaDeDuplicidade({ code: '22008', message: 'date out of range' }), ehTravaDeDuplicidade(null)], [false, false])
{
  const l = (id: string, tx_date: string, description: string, amount: number) => ({ plaid_tx_id: id, tx_date, description, amount })
  const pagina = [
    l('p1', '2025-03-10', 'Shell', -45.5),       // gêmea no livro, vinda de extrato
    l('p2', '2025-03-10', 'Tolls', -3.5),        // primeira do dia
    l('p3', '2025-03-10', 'Tolls', -3.5),        // a segunda igual, na mesma página
    l('p4', '2025-03-11', 'Uber', -12.3),        // gêmea no livro vinda do próprio Plaid
    l('p5', '2025-03-12', 'Amazon', -20),        // livre
  ]
  const doLivro = [
    { tx_date: '2025-03-10', description: 'Shell', amount: '-45.50', source: 'pdf' },
    { tx_date: '2025-03-11', description: 'Uber', amount: -12.3, source: 'plaid' },
    { tx_date: '2025-03-12', description: 'Amazon', amount: -20.01, source: 'csv' },   // um centavo diferente: não é gêmea
  ]
  const r = separarSuspeitas(pagina, doLivro)
  eq('livres vão em lote: a primeira de cada dia e as sem gêmea', r.livres.map(x => x.plaid_tx_id), ['p2', 'p5'])
  eq('suspeitas: gêmea no livro ou repetida na página', r.suspeitas.map(x => x.plaid_tx_id), ['p1', 'p3', 'p4'])
  eq('de onde veio a gêmea', r.suspeitas.map(x => r.origemDaGemea(x)), ['pdf', 'plaid', 'plaid'])
  eq('gêmea de extrato: já estava no livro; do Plaid: igual no mesmo dia',
    r.suspeitas.map(x => gemeaDeOutraOrigem(r.origemDaGemea(x))), [true, false, false])
  eq('gêmea de origem desconhecida não vira "já no livro"', gemeaDeOutraOrigem(null), false)
  eq('sem nada no livro, só as repetidas da página são suspeitas', separarSuspeitas(pagina, null).suspeitas.map(x => x.plaid_tx_id), ['p3'])
  eq('o exemplo é o que se confere no extrato', exemploDaLinha(l('x', '2025-03-10', 'Tolls', -3.5)), '03/10/2025 · Tolls · −$3.50')
  eq('entrada sem sinal', exemploDaLinha(l('x', '2025-03-10', 'Zelle', 200)), '03/10/2025 · Zelle · $200.00')
}
{
  // Sincronizar do começo de novo: tudo o que o Plaid manda já está no livro,
  // com o mesmo id. Marcar essas como suspeitas voltava às gravações uma a uma.
  const l = (id: string, tx_date: string, description: string, amount: number) => ({ plaid_tx_id: id, tx_date, description, amount })
  const pagina = [
    l('p1', '2025-03-10', 'Tolls', -3.5),     // ela mesma, já gravada
    l('p2', '2025-03-10', 'Tolls', -3.5),     // a segunda igual do dia, nova
    l('p3', '2025-03-11', 'Uber', -12.3),     // ela mesma, já gravada
    l('p4', '2025-03-12', 'Shell', -40),      // nova, com gêmea de extrato
  ]
  const doLivro = [
    { tx_date: '2025-03-10', description: 'Tolls', amount: -3.5, source: 'plaid', plaid_tx_id: 'p1' },
    { tx_date: '2025-03-11', description: 'Uber', amount: '-12.30', source: 'plaid', plaid_tx_id: 'p3' },
    { tx_date: '2025-03-12', description: 'Shell', amount: -40, source: 'csv', plaid_tx_id: null },
  ]
  const r = separarSuspeitas(pagina, doLivro)
  eq('a mesma transação já gravada vai no lote (o onConflict a pula sem inserir)', r.livres.map(x => x.plaid_tx_id), ['p1', 'p3'])
  eq('a outra igual do mesmo dia e a com gêmea de extrato seguem suspeitas', r.suspeitas.map(x => x.plaid_tx_id), ['p2', 'p4'])
  eq('a gêmea da igual do dia é do Plaid; a da outra, de extrato',
    r.suspeitas.map(x => gemeaDeOutraOrigem(r.origemDaGemea(x))), [false, true])
  eq('lançamento à mão também é "já no livro"', gemeaDeOutraOrigem('manual'), true)
}
{
  const m = mensagemDaSincronizacao({ ok: true, added: 3471, ruled: 120, jaNoLivro: 11, iguais: 18,
    exemplos: ['03/10/2025 · Tolls · −$3.50'], details: ['Bank of America: +2489'] })
  eq('já no livro é informação, não alarme', [/11 já estavam no livro/.test(m), /11[^⚠]*⚠️/.test(m.split('(')[0])], [true, false])
  eq('igual a outra do mesmo dia vira alerta com o que conferir', [/⚠️ 18 transação\(ões\) igual\(is\) a outra do mesmo dia/.test(m), /Confira no extrato/.test(m)], [true, true])
  eq('…com o exemplo', m.includes('Ex.: 03/10/2025 · Tolls · −$3.50.'), true)
  eq('sem recusa técnica, não manda avisar a equipe técnica', /equipe técnica/.test(m), false)
  eq('reconhecidas é a contagem de agora', /120 reconhecidas pelas regras/.test(m), true)
}

console.log(`plaid-paginacao: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
