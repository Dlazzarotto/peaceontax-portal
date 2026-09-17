#!/usr/bin/env node
// scripts/migrar.mjs — aplica migrações de sql/ no Supabase e anota o que foi aplicado.
//
//   npm run migrar -- sql/painel-v1.sql sql/payees-escopo-v1.sql   aplica estes arquivos
//   npm run migrar -- --pendentes                                   lista o que ainda não foi anotado
//   npm run migrar -- --so-ver sql/painel-v1.sql                    mostra o SQL, não executa
//   npm run migrar -- --registrar sql/x.sql                         anota como aplicado sem rodar
//                                                                    (para o que já foi rodado à mão)
//
// Credencial SÓ por variável de ambiente (nunca no código nem no Git):
//   SUPABASE_DB_URL        cadeia de conexão do Postgres → usa o psql (mostra os
//                          'raise notice' da conferência)
//   SUPABASE_ACCESS_TOKEN  token pessoal do Supabase + NEXT_PUBLIC_SUPABASE_URL
//                          (ou SUPABASE_PROJECT_REF) → usa a API de gestão, por
//                          HTTPS. Serve onde a porta do Postgres é bloqueada.
//
//   NÃO existe modo "só SUPABASE_PROJECT_REF". Já esteve escrito aqui que o
//   proxy do Claude Code anexaria o Bearer na saída, deixando o token fora da
//   sessão. Não anexa: o proxy daquele ambiente é só de TLS e roteamento, e o
//   pedido saía SEM cabeçalho de autorização — a Supabase respondia 401 e a
//   mensagem não dizia o motivo, então parecia token revogado. Sem
//   SUPABASE_ACCESS_TOKEN ou SUPABASE_DB_URL no ambiente, não há como aplicar
//   daqui: a migração vai à mão no SQL Editor e depois --registrar anota.
//
// Cada arquivo roda inteiro, na ordem em que foi passado. Os arquivos de sql/
// são idempotentes por regra do projeto, então repetir não estraga — mas o
// livro (tabela public.schema_migrations) evita repetir sem querer e diz
// quando e com que conteúdo cada um foi aplicado.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, basename } from 'node:path'

const RAIZ = new URL('..', import.meta.url).pathname

// O fetch do Node ignora HTTPS_PROXY. No Claude Code na nuvem é o proxy que
// anexa a credencial, então sem isto a chamada sai sem token e morre em 403.
// Node 22.21+ liga o proxy com NODE_USE_ENV_PROXY=1, mas só na partida do
// processo — por isso o script se relança uma vez com a variável, e pronto.
if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) {
  const filho = spawnSync(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
  })
  process.exit(filho.status ?? 1)
}
const LIVRO = `
create table if not exists public.schema_migrations (
  arquivo     text primary key,
  sha256      text not null,
  aplicado_em timestamptz not null default now(),
  aplicado_por text
);
revoke all on public.schema_migrations from anon, authenticated;`

const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const arquivos = args.filter(a => !a.startsWith('--'))

const sha = (s) => createHash('sha256').update(s).digest('hex')
const escapar = (s) => s.replace(/'/g, "''")

// ── Executores ───────────────────────────────────────────────────────────
function viaPsql(sql) {
  // -1: o arquivo inteiro numa transação — se a conferência do fim falhar, nada fica pela metade
  const r = spawnSync('psql', [process.env.SUPABASE_DB_URL, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-1'], {
    input: sql, encoding: 'utf-8',
  })
  if (r.error) throw new Error(`psql não pôde ser executado: ${r.error.message}`)
  const saida = (r.stdout + r.stderr).trim()
  if (r.status !== 0) throw new Error(saida || `psql saiu com ${r.status}`)
  return saida
}

async function viaApi(sql) {
  const ref = process.env.SUPABASE_PROJECT_REF
    || (process.env.NEXT_PUBLIC_SUPABASE_URL || '').match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1]
  if (!ref) throw new Error('Defina SUPABASE_PROJECT_REF ou NEXT_PUBLIC_SUPABASE_URL')
  const headers = { 'content-type': 'application/json' }
  if (process.env.SUPABASE_ACCESS_TOKEN) headers.authorization = `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST', headers, body: JSON.stringify({ query: sql, read_only: false }),
  })
  const texto = await r.text()
  if (r.status === 401) {
    throw new Error(
      'API 401: o Supabase recusou a credencial. O token pode estar revogado, expirado, '
      + 'ou sem permissao neste projeto. Confira em Supabase -> Account -> Access Tokens '
      + '(um token que nunca funcionou aparece como "Never used").')
  }
  if (!r.ok) throw new Error(`API ${r.status}: ${texto.slice(0, 600)}`)
  return texto
}

function escolherExecutor() {
  if (process.env.SUPABASE_DB_URL) return { nome: 'psql', run: viaPsql }
  if (process.env.SUPABASE_ACCESS_TOKEN) return { nome: 'API de gestão', run: viaApi }
  // PROJECT_REF sozinho NÃO autentica: ver o comentário do cabeçalho.
  // Tentar assim mesmo só produz um 401 sem explicação.
  return null
}

// ── Livro ────────────────────────────────────────────────────────────────
async function aplicados(exec) {
  await exec.run(LIVRO)
  const bruto = await exec.run(`select arquivo, sha256 from public.schema_migrations order by arquivo`)
  // psql -q devolve tabela em texto; a API devolve JSON. Aceita os dois.
  const mapa = new Map()
  try {
    for (const l of JSON.parse(bruto)) mapa.set(l.arquivo, l.sha256)
  } catch {
    for (const l of bruto.split('\n')) {
      const m = l.match(/^\s*(\S+\.sql)\s*\|\s*([0-9a-f]{64})/)
      if (m) mapa.set(m[1], m[2])
    }
  }
  return mapa
}

const anotar = (exec, nome, hash) => exec.run(
  `insert into public.schema_migrations (arquivo, sha256, aplicado_por)
   values ('${escapar(nome)}', '${hash}', '${escapar(process.env.USER || process.env.VERCEL_GIT_COMMIT_AUTHOR_LOGIN || 'migrar.mjs')}')
   on conflict (arquivo) do update set sha256 = excluded.sha256, aplicado_em = now(), aplicado_por = excluded.aplicado_por`)

// ── Programa ─────────────────────────────────────────────────────────────
async function main() {
  const dirSql = join(RAIZ, 'sql')
  const todos = readdirSync(dirSql).filter(f => f.endsWith('.sql')).sort()

  if (flag('--so-ver')) {
    for (const a of arquivos) { console.log(`── ${a} ──`); console.log(readFileSync(join(RAIZ, a), 'utf-8')) }
    return
  }

  const exec = escolherExecutor()
  if (!exec) {
    console.error('Sem credencial para falar com o Supabase.')
    console.error('')
    console.error('  Defina UMA destas no ambiente (nao no codigo, nao no Git):')
    console.error('    SUPABASE_DB_URL       cadeia de conexao do Postgres -> usa psql')
    console.error('    SUPABASE_ACCESS_TOKEN token pessoal do Supabase -> usa a API de gestao')
    console.error('')
    if (process.env.SUPABASE_PROJECT_REF) {
      console.error(`  SUPABASE_PROJECT_REF esta definido (${process.env.SUPABASE_PROJECT_REF}), mas ele sozinho`)
      console.error('  NAO autentica: diz em qual projeto mexer, nao quem esta mexendo.')
      console.error('')
    }
    console.error('  Sem isso, aplique no SQL Editor do Supabase e depois anote com:')
    console.error('    npm run migrar -- --registrar sql/<arquivo>.sql')
    process.exit(2)
  }
  console.log(`Conexão: ${exec.nome}`)
  const livro = await aplicados(exec)

  if (flag('--pendentes')) {
    let n = 0
    for (const f of todos) {
      const nome = `sql/${f}`
      const hash = sha(readFileSync(join(dirSql, f), 'utf-8'))
      const est = !livro.has(nome) ? 'PENDENTE' : livro.get(nome) !== hash ? 'MUDOU DEPOIS DE APLICADO' : 'ok'
      if (est !== 'ok') n++
      console.log(`  ${est.padEnd(26)} ${nome}`)
    }
    console.log(n === 0 ? 'Nada pendente.' : `${n} arquivo(s) a decidir.`)
    return
  }

  if (arquivos.length === 0) {
    console.error('Diga quais arquivos aplicar, ou use --pendentes.')
    process.exit(2)
  }

  for (const a of arquivos) {
    const caminho = join(RAIZ, a)
    if (!existsSync(caminho) || !a.endsWith('.sql')) { console.error(`Arquivo inválido: ${a}`); process.exit(2) }
    const nome = `sql/${basename(a)}`
    const sql = readFileSync(caminho, 'utf-8')
    if (sql.charCodeAt(0) === 0xFEFF) { console.error(`${nome} tem BOM — salve como UTF-8 sem BOM.`); process.exit(2) }
    const hash = sha(sql)

    if (flag('--registrar')) {
      await anotar(exec, nome, hash)
      console.log(`  anotado sem executar  ${nome}`)
      continue
    }
    if (livro.get(nome) === hash && !flag('--forcar')) {
      console.log(`  já aplicado (mesmo conteúdo)  ${nome}   — use --forcar para repetir`)
      continue
    }
    process.stdout.write(`  aplicando  ${nome} … `)
    try {
      const saida = await exec.run(sql)
      console.log('ok')
      if (saida && exec.nome === 'psql') console.log(saida.split('\n').map(l => '      ' + l).join('\n'))
    } catch (e) {
      console.log('FALHOU')
      console.error(String(e.message || e))
      process.exit(1)
    }
    await anotar(exec, nome, hash)
  }
  console.log('Concluído.')
}

main().catch(e => { console.error(e.message || e); process.exit(1) })
