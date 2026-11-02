// testes/ordem-das-migracoes.mts — a ordem em que as migrações são aplicadas
//
// Ordem errada em migração não tem desfazer: a função é criada antes da
// tabela, ou a trava roda antes da definição que ela depende. Alfabética
// parecia inofensiva e está INVERTIDA em dois casos reais deste repositório.

import { ordenarPorDependencia, DEPENDE_DE } from '../scripts/ordem-das-migracoes.mjs'
import { lerLivro, aplicadasParaDependencia } from '../scripts/livro-de-migracoes.mjs'

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

// ── O livro de VERDADE: o que o migrar.mjs lê e passa adiante ──────────
// O defeito: o livro é um Map (lerLivro) e a ordenação aceitava "Set ou
// objeto". Com o Map, `aplicados[x]` dava sempre undefined e TODA dependência
// de migração já aplicada parecia faltar — o --pendentes do GitHub recusou a
// equipe-unica-v1 dizendo que papel-no-app-metadata-v1 "não está aplicada nem
// na lista", com ela listada como ok três linhas acima. Os testes passavam
// porque usavam Set: o que falhou foi a LIGAÇÃO entre os dois módulos, e é
// ela que se testa aqui.
{
  const h = (c: string) => c.repeat(64)
  const papel = 'sql/papel-no-app-metadata-v1.sql', equipe = 'sql/equipe-unica-v1.sql'
  const livroDe = (linhas: any[]) => lerLivro(JSON.stringify(linhas))
  const disco = [{ nome: papel, hash: h('a') }, { nome: equipe, hash: h('b') }]

  const livro = livroDe([{ arquivo: papel, sha256: h('a') }])
  const ok = aplicadasParaDependencia(livro, disco)
  eq('do livro: a aplicada com o mesmo conteúdo conta', [...ok], [papel])
  const r = ordenarPorDependencia([equipe], ok)
  eq('dependência aplicada (pelo livro de verdade) não é cobrada', r.faltando, [])
  eq('...e a pendente sai na ordem', r.ordem, [equipe])

  let erro = ''
  try { ordenarPorDependencia([equipe], livro as any) } catch (e) { erro = (e as Error).message }
  eq('o livro CRU (Map) é recusado em voz alta, nunca vira "falta" calada', /tem de ser um Set/.test(erro), true)
  erro = ''
  try { ordenarPorDependencia([equipe], { [papel]: true } as any) } catch (e) { erro = (e as Error).message }
  eq('objeto comum também é recusado (a outra forma que se aceitava)', /tem de ser um Set/.test(erro), true)

  // Fora do conjunto, de propósito: depender de arquivo que não é o que rodou
  // é decisão de gente — a recusa diz qual é.
  const mudou = aplicadasParaDependencia(livroDe([{ arquivo: papel, sha256: h('c') }]), disco)
  eq('MUDOU DEPOIS DE APLICADO não conta como aplicada', mudou.has(papel), false)
  eq('...e a dependente é recusada, dizendo qual',
    ordenarPorDependencia([equipe], mudou).faltando, [{ arquivo: equipe, dep: papel }])
  eq('registro SEM SHA não conta', aplicadasParaDependencia(livroDe([{ arquivo: papel, sha256: '' }]), disco).has(papel), false)
  eq('registro com NOME CURTO não conta',
    aplicadasParaDependencia(livroDe([{ arquivo: 'papel-no-app-metadata-v1.sql', sha256: h('a') }]), disco).has(papel), false)
  eq('livro vazio: nada conta', aplicadasParaDependencia(livroDe([]), disco).size, 0)
  eq('sem arquivos no disco: nada conta', aplicadasParaDependencia(livro, null as any).size, 0)
  // O caso real inteiro: a cadeia do #60 e do #62, com a base aplicada.
  const cadeia = ['sql/contrato-unico-funcao-v1.sql', 'sql/contrato-unico-v1.sql', equipe]
  const real = ordenarPorDependencia(cadeia, ok, {
    [equipe]: [papel], 'sql/contrato-unico-v1.sql': [equipe], 'sql/contrato-unico-funcao-v1.sql': ['sql/contrato-unico-v1.sql'],
  })
  eq('a cadeia equipe → contrato → função sai em ordem, sem falta', [real.ordem, real.faltando],
    [[equipe, 'sql/contrato-unico-v1.sql', 'sql/contrato-unico-funcao-v1.sql'], []])
}

// ── O mapa declarado aponta para caminhos, não para nomes curtos ────────
// A chave do livro é o CAMINHO (`sql/x.sql`). Nome curto vira linha que
// ninguém encontra — já aconteceu duas vezes neste repositório.
for (const [arq, deps] of Object.entries(DEPENDE_DE)) {
  eq(`${arq} é caminho`, arq.startsWith('sql/'), true)
  for (const d of deps as string[]) eq(`${d} é caminho`, d.startsWith('sql/'), true)
}

console.log(`ordem-das-migracoes: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
