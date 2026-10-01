// testes/ordem-das-migracoes.mts — a ordem em que as migrações são aplicadas
//
// Ordem errada em migração não tem desfazer: a função é criada antes da
// tabela, ou a trava roda antes da definição que ela depende. Alfabética
// parecia inofensiva e está INVERTIDA em dois casos reais deste repositório.

import { ordenarPorDependencia, DEPENDE_DE } from '../scripts/ordem-das-migracoes.mjs'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// ── Os dois casos reais, que a ordem alfabética inverte ─────────────────
{
  // 'f' < 'v': a FUNÇÃO viria antes da TABELA que ela consome.
  const alfabetica = ['sql/codigo-de-autorizacao-funcao-v1.sql', 'sql/codigo-de-autorizacao-v1.sql']
  eq('a tabela do código de autorização vem antes da função',
    ordenarPorDependencia(alfabetica).ordem,
    ['sql/codigo-de-autorizacao-v1.sql', 'sql/codigo-de-autorizacao-funcao-v1.sql'])
}
{
  // 'r' < 's': a trava viria antes da definição de status que ela usa.
  const alfabetica = ['sql/recebimento-seguro-v1.sql', 'sql/status-da-fatura-v2.sql']
  eq('status-da-fatura-v2 vem antes de recebimento-seguro-v1',
    ordenarPorDependencia(alfabetica).ordem,
    ['sql/status-da-fatura-v2.sql', 'sql/recebimento-seguro-v1.sql'])
}
{
  const alfabetica = ['sql/caixa-conciliacao-funcao-v1.sql', 'sql/caixa-conciliacao-v1.sql',
                      'sql/caixa-conciliacao-v2.sql']
  eq('a conciliação: tabela, depois função e v2',
    ordenarPorDependencia(alfabetica).ordem[0], 'sql/caixa-conciliacao-v1.sql')
}

// ── Estabilidade: quem não depende de ninguém não embaralha ─────────────
{
  const soltos = ['sql/a.sql', 'sql/b.sql', 'sql/c.sql']
  eq('sem dependência, a ordem de entrada é mantida',
    ordenarPorDependencia(soltos).ordem, soltos)
}
{
  // Um par dependente no meio de soltos não arrasta o resto de lugar.
  const mapa = { 'sql/b.sql': ['sql/z.sql'] }
  eq('só o necessário se move',
    ordenarPorDependencia(['sql/a.sql', 'sql/b.sql', 'sql/z.sql'], new Set(), mapa).ordem,
    ['sql/a.sql', 'sql/z.sql', 'sql/b.sql'])
}

// ── Dependência JÁ APLICADA não precisa estar na lista ──────────────────
{
  const r = ordenarPorDependencia(['sql/recebimento-seguro-v1.sql'],
    new Set(['sql/status-da-fatura-v2.sql']))
  eq('dependência já aplicada não é cobrada', r.faltando, [])
  eq('e a lista sai como veio', r.ordem, ['sql/recebimento-seguro-v1.sql'])
}

// ── Dependência que NÃO está nem aplicada nem na lista é recusa ─────────
// Este é o caso que importa: "MUDOU DEPOIS DE APLICADO" fica FORA do
// automático de propósito. Se a dependência estiver nesse estado, aplicar
// a dependente e torcer é exatamente o erro que isto existe para impedir.
{
  const r = ordenarPorDependencia(['sql/recebimento-seguro-v1.sql'], new Set())
  eq('falta é apontada, com quem depende de quem',
    r.faltando, [{ arquivo: 'sql/recebimento-seguro-v1.sql', dep: 'sql/status-da-fatura-v2.sql' }])
}

// ── Transitividade ──────────────────────────────────────────────────────
{
  const mapa = { 'sql/c.sql': ['sql/b.sql'], 'sql/b.sql': ['sql/a.sql'] }
  eq('cadeia de três',
    ordenarPorDependencia(['sql/c.sql', 'sql/b.sql', 'sql/a.sql'], new Set(), mapa).ordem,
    ['sql/a.sql', 'sql/b.sql', 'sql/c.sql'])
}

// ── Ciclo não trava o programa: acusa ───────────────────────────────────
// Declaração errada é erro humano; travar num laço infinito seria pior que
// o defeito original.
{
  const mapa = { 'sql/a.sql': ['sql/b.sql'], 'sql/b.sql': ['sql/a.sql'] }
  const r = ordenarPorDependencia(['sql/a.sql', 'sql/b.sql'], new Set(), mapa)
  eq('o ciclo é acusado', r.ciclos.length > 0, true)
  eq('e todos os arquivos continuam na saída', r.ordem.length, 2)
}

// ── Lista vazia e entradas degeneradas ──────────────────────────────────
eq('lista vazia', ordenarPorDependencia([]).ordem, [])
eq('nulo não quebra', ordenarPorDependencia(null as any).ordem, [])
eq('nenhum arquivo sai nem entra',
  ordenarPorDependencia(['sql/x.sql', 'sql/y.sql']).ordem.length, 2)

// ── O mapa declarado aponta para caminhos, não para nomes curtos ────────
// A chave do livro é o CAMINHO (`sql/x.sql`). Nome curto vira linha que
// ninguém encontra — já aconteceu duas vezes neste repositório.
for (const [arq, deps] of Object.entries(DEPENDE_DE)) {
  eq(`${arq} é caminho`, arq.startsWith('sql/'), true)
  for (const d of deps as string[]) eq(`${d} é caminho`, d.startsWith('sql/'), true)
}

console.log(`ordem-das-migracoes: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
