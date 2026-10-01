#!/usr/bin/env node
// Juntar migracoes num arquivo so, para colar no SQL Editor do Supabase.
//
// POR QUE ISTO EXISTE
// Nem sempre da para rodar `migrar.mjs`: a maquina pode nao ter psql, e nem
// todo mundo quer gerar um token de acesso. O que sempre existe e o SQL
// Editor no navegador. Colar tres arquivos em sequencia convida a errar a
// ORDEM e a esquecer de anotar no livro -- e migracao nao anotada aparece
// como PENDENTE para sempre, ate alguem rodar de novo.
//
// Este gerador junta na ordem, liga a RLS do livro ele mesmo (o detector do
// SQL Editor reescreve script que cria tabela sem RLS) e fecha com o INSERT
// no livro usando o MESMO sha256 que migrar.mjs calcula.
//
// O arquivo gerado fica FORA de sql/, de proposito: la dentro ele seria
// listado como mais uma migracao pendente, para sempre.
//
//   node scripts/juntar-para-colar.mjs <saida.sql> <sql/a.sql> <sql/b.sql> ...
//   node scripts/juntar-para-colar.mjs --conferir <saida.sql> <sql/a.sql> ...
//        (nao escreve; sai 1 se o arquivo estiver desatualizado)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

const LIVRO = `create table if not exists public.schema_migrations (
  arquivo     text primary key,
  sha256      text not null,
  aplicado_em timestamptz not null default now(),
  aplicado_por text
);
-- A RLS vai LIGADA pelo proprio arquivo, de proposito: o SQL Editor tem um
-- detector de "tabela criada sem RLS" que, quando acha uma, REESCREVE o
-- script e corta blocos no meio (o erro que sai e \`unterminated
-- dollar-quoted string\`, numa linha sem defeito). Sem o que acrescentar,
-- ele nao mexe. Quem trabalha nesta tabela e o servidor, com a service role.
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from anon, authenticated;`

export function montar(arquivos, ler = (a) => readFileSync(a, 'utf-8')) {
  let out = `-- COLE ESTE ARQUIVO INTEIRO NO SQL EDITOR DO SUPABASE E APERTE RUN.
--
-- GERADO por scripts/juntar-para-colar.mjs -- nao edite a mao.
-- Junta, NA ORDEM, as migracoes abaixo e anota as tres no livro
-- (public.schema_migrations) com o MESMO sha256 que scripts/migrar.mjs
-- calcula: depois disso \`--pendentes\` diz APLICADO e ninguem roda de novo.
--
-- Cada parte e idempotente: rodar duas vezes nao faz mal.
--
-- Origem: ${arquivos.join(', ')}

${LIVRO}
`
  const linhas = []
  for (const a of arquivos) {
    const sql = ler(a)
    linhas.push(`('${a}', '${createHash('sha256').update(sql).digest('hex')}', 'sql-editor')`)
    out += `\n\n-- ===================================================================\n`
        +  `-- ${a}\n`
        +  `-- ===================================================================\n\n${sql}`
  }
  out += `\n\n-- ===================================================================
-- Anotar no livro de migracoes
-- ===================================================================

insert into public.schema_migrations (arquivo, sha256, aplicado_por)
values
  ${linhas.join(',\n  ')}
on conflict (arquivo) do update
  set sha256 = excluded.sha256, aplicado_em = now(), aplicado_por = excluded.aplicado_por;

select arquivo, left(sha256, 12) as sha, aplicado_em
  from public.schema_migrations
 where arquivo in (${arquivos.map(a => `'${a}'`).join(', ')})
 order by arquivo;
`
  return out
}

// Rodando como programa (e nao sendo importado pelo teste/auditoria)
if (process.argv[1] && process.argv[1].endsWith('juntar-para-colar.mjs')) {
  const args = process.argv.slice(2)
  const conferir = args[0] === '--conferir'
  const [saida, ...fontes] = conferir ? args.slice(1) : args
  if (!saida || fontes.length === 0) {
    console.error('uso: node scripts/juntar-para-colar.mjs [--conferir] <saida.sql> <sql/a.sql> ...')
    process.exitCode = 2
  } else {
    const texto = montar(fontes)
    if (conferir) {
      const atual = (() => { try { return readFileSync(saida, 'utf-8') } catch { return null } })()
      if (atual === texto) console.log(`em dia: ${saida}`)
      else { console.error(`DESATUALIZADO: ${saida} — regere com node scripts/juntar-para-colar.mjs ${saida} ${fontes.join(' ')}`); process.exitCode = 1 }
    } else {
      mkdirSync(dirname(saida), { recursive: true })
      writeFileSync(saida, texto)
      console.log(`gerado: ${saida} (${texto.split('\n').length} linhas)`)
    }
  }
}
