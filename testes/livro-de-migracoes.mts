// testes/livro-de-migracoes.mts — ler o livro de migrações
//
// Os dois defeitos que isto conserta empurravam para o MESMO lado: migração
// aplicada parecendo nunca aplicada. Esse é o lado que faz alguém rodar de
// novo, num banco de produção. Por isso tem teste.

import { lerLivro, estadoDaMigracao, ESTADOS,
         consertoDoNomeCurto, consertoDoShaVazio } from '../scripts/livro-de-migracoes.mjs'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const SHA = 'a'.repeat(64)
const OUTRO = 'b'.repeat(64)

// ── O leitor: texto do psql ─────────────────────────────────────────────
{
  const texto = [
    ' sql/painel-v1.sql | ' + SHA,
    ' sql/outro-v1.sql  | ' + OUTRO,
  ].join('\n')
  const l = lerLivro(texto)
  eq('lê duas linhas', l.size, 2)
  eq('com o sha', l.get('sql/painel-v1.sql'), SHA)
}
// O caso real: sha EM BRANCO. O padrão antigo exigia 64 dígitos, a linha
// sumia do mapa e a migração era anunciada como PENDENTE.
{
  const l = lerLivro(' sql/permissoes-por-pessoa-v3.sql | ')
  eq('a linha com sha vazio EXISTE', l.has('sql/permissoes-por-pessoa-v3.sql'), true)
  eq('e o sha vem nulo', l.get('sql/permissoes-por-pessoa-v3.sql'), null)
}
{
  const l = lerLivro(' sql/x.sql | naoehumsha')
  eq('sha fora do formato também vira nulo, não some', l.get('sql/x.sql'), null)
}
// Nome curto: a linha é lida, sob a chave curta.
{
  const l = lerLivro(' ach-em-transito-v1.sql | ' + SHA)
  eq('nome curto é lido como veio', l.has('ach-em-transito-v1.sql'), true)
}
// ── O leitor: JSON da API de gestão ─────────────────────────────────────
{
  const l = lerLivro(JSON.stringify([
    { arquivo: 'sql/a.sql', sha256: SHA },
    { arquivo: 'sql/b.sql', sha256: null },
    { arquivo: 'sql/c.sql', sha256: '' },
  ]))
  eq('JSON: três linhas', l.size, 3)
  eq('JSON: sha nulo', l.get('sql/b.sql'), null)
  eq('JSON: sha vazio', l.get('sql/c.sql'), null)
}
eq('entrada vazia não quebra', lerLivro('').size, 0)
eq('nulo não quebra', lerLivro(null as any).size, 0)
{
  // Maiúscula no sha não deveria impedir o reconhecimento.
  const l = lerLivro(' sql/x.sql | ' + SHA.toUpperCase())
  eq('sha em maiúscula é normalizado', l.get('sql/x.sql'), SHA)
}

// ── Os estados ──────────────────────────────────────────────────────────
{
  const livro = new Map<string, string | null>([
    ['sql/ok.sql', SHA],
    ['sql/mudou.sql', OUTRO],
    ['sql/sem-sha.sql', null],
    ['curto.sql', SHA],
  ])
  eq('ok', estadoDaMigracao('sql/ok.sql', SHA, livro), ESTADOS.OK)
  eq('mudou depois de aplicado', estadoDaMigracao('sql/mudou.sql', SHA, livro), ESTADOS.MUDOU)
  eq('registro sem sha', estadoDaMigracao('sql/sem-sha.sql', SHA, livro), ESTADOS.SEM_SHA)
  eq('nome curto é reconhecido', estadoDaMigracao('sql/curto.sql', SHA, livro), ESTADOS.NOME_CURTO)
  eq('ausente de verdade é PENDENTE', estadoDaMigracao('sql/novo.sql', SHA, livro), ESTADOS.PENDENTE)
}
// A distinção que importa: NENHUM dos três estados-problema pode ser
// confundido com PENDENTE, porque só PENDENTE entra no automático.
{
  const livro = new Map<string, string | null>([['sql/a.sql', null], ['b.sql', SHA]])
  for (const [caminho, esperado] of [
    ['sql/a.sql', ESTADOS.SEM_SHA],
    ['sql/b.sql', ESTADOS.NOME_CURTO],
  ] as const) {
    eq(`${caminho} não é PENDENTE`, estadoDaMigracao(caminho, SHA, livro) === ESTADOS.PENDENTE, false)
    eq(`${caminho} é ${esperado}`, estadoDaMigracao(caminho, SHA, livro), esperado)
  }
}
// Arquivo fora de sql/ não inventa nome curto.
{
  const livro = new Map<string, string | null>([['x.sql', SHA]])
  eq('sem prefixo sql/, não há nome curto a procurar',
    estadoDaMigracao('x.sql', OUTRO, livro), ESTADOS.MUDOU)
}

// ── Os consertos ────────────────────────────────────────────────────────
// RENOMEIA E SO. Gravar o sha atual junto apagaria um sinal verdadeiro:
// permissoes-por-pessoa-v1 esta no livro com um sha e no disco com outro
// (editada seis dias depois de aplicada). Sobrescrever viraria "ok" falso.
eq('conserto do nome curto apenas renomeia',
  consertoDoNomeCurto('sql/ach-em-transito-v1.sql'),
  `update public.schema_migrations set arquivo = 'sql/ach-em-transito-v1.sql' where arquivo = 'ach-em-transito-v1.sql';`)
eq('e NAO toca no sha gravado',
  /sha256/.test(consertoDoNomeCurto('sql/ach-em-transito-v1.sql')), false)
eq('conserto do sha vazio',
  consertoDoShaVazio('sql/permissoes-por-pessoa-v3.sql', SHA),
  `update public.schema_migrations set sha256 = '${SHA}' where arquivo = 'sql/permissoes-por-pessoa-v3.sql';`)

console.log(`livro-de-migracoes: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
