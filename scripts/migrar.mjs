#!/usr/bin/env node
// scripts/migrar.mjs — aplica migrações de sql/ no Supabase e anota o que foi aplicado.
//
//   npm run migrar -- sql/painel-v1.sql sql/payees-escopo-v1.sql   aplica estes arquivos
//   npm run migrar -- --pendentes                                   lista o que ainda não foi anotado
//   npm run migrar -- --pendentes --so-nomes                        só os caminhos, para outro
//                                                                    programa consumir (workflow)
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
//   NÃO existe modo "só SUPABASE_PROJECT_REF": ele diz em qual projeto mexer,
//   não quem está mexendo.
//
//   DE DENTRO DO CLAUDE CODE NA NUVEM, NADA DISSO FUNCIONA — está medido:
//     - o proxy de saída daquele ambiente MEXE no cabeçalho Authorization.
//       Para api.github.com ele substitui pela credencial dele (um pedido sem
//       cabeçalho e um com token errado voltam os dois autenticados). Para
//       api.supabase.com o cabeçalho não chega: um token COMPROVADAMENTE
//       válido — que lista os projetos da máquina do sócio — responde 401 ali.
//     - psql também não: a porta 5432 é inalcançável, o proxy só faz
//       HTTP CONNECT.
//   Ou seja: pôr o token no ambiente não adianta, e criar outro token menos
//   ainda. De lá, a migração vai à mão no SQL Editor; --registrar anota depois
//   (de uma máquina que alcance o banco).
//
//   O sintoma engana: a Supabase responde o mesmo `401 {"message":
//   "Unauthorized"}` para token ausente, inválido e revogado. Foi isso que
//   fez procurar no token o que era do ambiente.
//
// Cada arquivo roda inteiro, na ordem em que foi passado. Os arquivos de sql/
// são idempotentes por regra do projeto, então repetir não estraga — mas o
// livro (tabela public.schema_migrations) evita repetir sem querer e diz
// quando e com que conteúdo cada um foi aplicado.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { credencialDoPostgres, pistaDoErroDoPsql, conferirProjeto } from './credencial-postgres.mjs'
import { ordenarPorDependencia } from './ordem-das-migracoes.mjs'
import { lerLivro, estadoDaMigracao, ESTADOS,
         consertoDoNomeCurto, consertoDoShaVazio } from './livro-de-migracoes.mjs'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// `new URL(...).pathname` NAO serve para virar caminho de arquivo: no
// Windows ele devolve `/C:/Users/...` (com a barra na frente), e o `join`
// monta `C:\C:\Users\...`. Foi o que aconteceu de verdade:
//   ENOENT: no such file or directory, scandir 'C:\C:\Users\...\sql'
// Nunca apareceu antes porque o script so tinha rodado em Linux (container
// e runner do GitHub). `fileURLToPath` e o conversor correto nos dois.
const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)))

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
/**
 * Qual projeto Supabase este repositório espera. Vem de `.env.example`, que
 * está versionado e não guarda segredo nenhum — só diz QUAL projeto é o
 * desta aplicação.
 */
function refEsperadoDoRepo() {
  try {
    const t = readFileSync(join(RAIZ, '.env.example'), 'utf-8')
    return (/NEXT_PUBLIC_SUPABASE_URL\s*=\s*https:\/\/([a-z0-9]{16,})\.supabase\.co/i.exec(t) || [])[1] || null
  } catch { return null }
}

/** Recusa a cadeia que aponta para OUTRO projeto. */
function exigirProjetoCerto(url) {
  if (liberouOutroProjeto()) return
  const r = conferirProjeto(url, refEsperadoDoRepo())
  if (!r.ok) throw new Error(r.erro)
}

/**
 * O mesmo, para o caminho da API de gestao -- que nao tem cadeia, tem REF.
 *
 * A primeira versao da trava so cobria o psql: pela API, um
 * SUPABASE_PROJECT_REF de outro projeto passava direto. Meia trava e pior
 * que nenhuma, porque quem confia nela para de conferir.
 */
function exigirRefCerto(ref) {
  if (liberouOutroProjeto()) return
  const esperado = refEsperadoDoRepo()
  if (!esperado || !ref || ref === esperado) return
  throw new Error(
    `A API aponta para o projeto "${ref}", e este repositório é do projeto "${esperado}" `
    + '(NEXT_PUBLIC_SUPABASE_URL em .env.example).\n'
    + '      Migração no banco errado não tem desfazer. Confira SUPABASE_PROJECT_REF.\n'
    + '      Se a intenção É outro banco (uma cópia de teste), rode com MIGRAR_OUTRO_PROJETO=1.')
}

function liberouOutroProjeto() {
  if (process.env.MIGRAR_OUTRO_PROJETO !== '1') return false
  console.error('    aviso: MIGRAR_OUTRO_PROJETO=1 — a conferência de projeto está desligada.')
  return true
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
  // A cadeia é conferida ANTES: texto que não é URI faz o psql procurar um
  // Postgres local e falar de socket, que não tem nada a ver com o defeito.
  const cred = credencialDoPostgres(process.env.SUPABASE_DB_URL, process.env.SUPABASE_DB_PASSWORD)
  if (cred.erro) throw new Error(cred.erro)
  for (const a of cred.avisos || []) console.error(`    aviso: ${a}`)
  // A senha separada vai por PGPASSWORD: variável de ambiente não passa por
  // parser de URI, então `@`, `#` e `%` na senha deixam de ser problema.
  exigirProjetoCerto(cred.url)
  const ambiente = cred.senha ? { ...process.env, PGPASSWORD: cred.senha } : process.env
  // -1: o arquivo inteiro numa transação — se a conferência do fim falhar, nada fica pela metade
  const r = spawnSync('psql', [cred.url, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-1'], {
    input: sql, encoding: 'utf-8', env: ambiente,
  })
  if (r.error) throw new Error(`psql não pôde ser executado: ${r.error.message}`)
  const saida = (r.stdout + r.stderr).trim()
  if (r.status !== 0) {
    // O texto do psql é exato e inútil para quem não vive nisso.
    const pista = pistaDoErroDoPsql(saida)
    throw new Error((saida || `psql saiu com ${r.status}`) + (pista ? `\n\n  → ${pista}` : ''))
  }
  return saida
}

async function viaApi(sql) {
  const ref = process.env.SUPABASE_PROJECT_REF
    || (process.env.NEXT_PUBLIC_SUPABASE_URL || '').match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1]
  if (!ref) throw new Error('Defina SUPABASE_PROJECT_REF ou NEXT_PUBLIC_SUPABASE_URL')
  exigirRefCerto(ref)
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
  // O leitor mora em livro-de-migracoes.mjs, puro e com teste: ele ja
  // deixou sumir linha com sha vazio, e linha que some vira PENDENTE --
  // migracao aplicada parecendo nunca aplicada.
  return lerLivro(bruto)
}

const anotar = (exec, nome, hash) => exec.run(
  `insert into public.schema_migrations (arquivo, sha256, aplicado_por)
   values ('${escapar(nome)}', '${hash}', '${escapar(process.env.USER || process.env.VERCEL_GIT_COMMIT_AUTHOR_LOGIN || 'migrar.mjs')}')
   on conflict (arquivo) do update set sha256 = excluded.sha256, aplicado_em = now(), aplicado_por = excluded.aplicado_por`)

// ── Programa ─────────────────────────────────────────────────────────────
async function main() {
  const dirSql = join(RAIZ, 'sql')
  const todos = readdirSync(dirSql).filter(f => f.endsWith('.sql')).sort()

  // --credencial: só confere o formato da cadeia, sem tocar no banco. É o
  // que o job do GitHub roda primeiro, para o defeito aparecer no passo da
  // CREDENCIAL e não num erro de socket três passos adiante.
  if (flag('--credencial')) {
    if (!process.env.SUPABASE_DB_URL && process.env.SUPABASE_ACCESS_TOKEN) {
      console.log('Sem SUPABASE_DB_URL; vai pela API de gestão.')
      return
    }
    // AS DUAS definidas: o psql VENCE (escolherExecutor), e o token fica
    // sem uso. Isso precisa ser DITO: quem acabou de criar um token e vê o
    // job falhar na cadeia antiga não tem como adivinhar que o token nem
    // chegou a ser tentado.
    if (process.env.SUPABASE_DB_URL && process.env.SUPABASE_ACCESS_TOKEN) {
      console.log('aviso: SUPABASE_DB_URL e SUPABASE_ACCESS_TOKEN estao definidos.')
      console.log('       Vai pelo psql (SUPABASE_DB_URL vence); o token NAO sera usado.')
      console.log('       Para ir pela API, apague o secret SUPABASE_DB_URL.')
    }
    const cred = credencialDoPostgres(process.env.SUPABASE_DB_URL, process.env.SUPABASE_DB_PASSWORD)
    if (cred.erro) { console.error(`::error::${cred.erro}`); process.exit(1) }
    if (cred.senha) console.log('Senha vem de SUPABASE_DB_PASSWORD (fora da URI).')
    for (const a of cred.avisos || []) console.log(`aviso: ${a}`)
    // O valor nunca é impresso — só o que dá para conferir sem vazá-lo.
    const host = (cred.url.match(/@([^:/?]+)/) || [])[1] || '?'
    console.log(`Credencial no formato certo. Servidor: ${host}`)
    // Projeto errado é o erro que não tem desfazer: confere aqui também,
    // para aparecer no passo da CREDENCIAL e não na primeira consulta.
    try { exigirProjetoCerto(cred.url) } catch (e) {
      console.error(`::error::${e.message}`); process.exit(1)
    }
    console.log(`Projeto conferido: ${refEsperadoDoRepo() || '(o repositório não diz qual esperar)'}`)
    return
  }

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
  // Diagnostico vai para o STDERR, nunca para o stdout: o workflow faz
  // PENDENTES=$(... --pendentes --so-nomes) e passa CADA LINHA adiante
  // como nome de arquivo. Com `Conexão: psql` no stdout, o aplicar
  // automatico receberia "Conexão:" e "psql" como migracoes. Nunca tinha
  // aparecido porque o aplicar nunca chegou a rodar ate o fim.
  console.error(`Conexão: ${exec.nome}`)
  const livro = await aplicados(exec)

  if (flag('--pendentes')) {
    // --so-nomes: só os caminhos, um por linha, para outro programa consumir
    // (é o que o workflow do GitHub passa adiante). Sai NUA: sem cabeçalho,
    // sem contagem, sem cor.
    const soNomes = flag('--so-nomes')
    let n = 0
    const paraAplicar = []
    const consertos = []
    for (const f of todos) {
      const nome = `sql/${f}`
      const hash = sha(readFileSync(join(dirSql, f), 'utf-8'))
      const est = estadoDaMigracao(nome, hash, livro)
      if (est !== ESTADOS.OK) n++
      // Os tres estados-problema que NAO sao PENDENTE tem conserto de uma
      // linha. Dizer so "tem algo errado" obriga a pessoa a redescobrir o
      // que ja esta sabido aqui.
      if (!soNomes && est === ESTADOS.NOME_CURTO) consertos.push(consertoDoNomeCurto(nome, hash))
      if (!soNomes && est === ESTADOS.SEM_SHA)    consertos.push(consertoDoShaVazio(nome, hash))
      // Só PENDENTE entra na lista automática. "MUDOU DEPOIS DE APLICADO" é
      // arquivo editado depois de rodar (aconteceu: a conferência de
      // permissoes-por-pessoa-v1 foi reescrita). Pode ser inofensivo, pode
      // não ser — quem decide é gente, então ele aparece no relato e fica de
      // fora do automático.
      // SO PENDENTE entra no automatico. "MUDOU DEPOIS DE APLICADO",
      // "REGISTRO SEM SHA" e "REGISTRADA COM NOME CURTO" sao arquivos que
      // muito provavelmente JA ESTAO no banco -- reaplicar e o risco, nao
      // esperar. Viram relato, com o conserto escrito.
      if (est === ESTADOS.PENDENTE) paraAplicar.push(nome)
      if (!soNomes) console.log(`  ${est.padEnd(26)} ${nome}`)
    }
    // --so-nomes sai NUA: o workflow passa cada linha adiante como nome
    // de arquivo, entao qualquer cabecalho vira um "arquivo" inexistente.
    if (!soNomes) {
      console.log(n === 0 ? 'Nada pendente.' : `${n} arquivo(s) a decidir.`)
      if (n > paraAplicar.length) {
        console.log(`  (${n - paraAplicar.length} fora do automático — provavelmente já no banco; decida uma a uma)`)
      }
      if (consertos.length) {
        console.log('')
        console.log('Linhas do livro com o registro torto. O SQL que arruma cada uma:')
        for (const c of consertos) console.log(`  ${c}`)
      }
    }

    // A ordem vem DEPOIS do relato de proposito: a recusa abaixo sai do
    // programa com exit(3), e rodando de verdade se viu que ela engolia o
    // conserto de cada linha torta -- que e justamente o que falta para
    // decidir. Relato primeiro, recusa depois.
    // ORDEM DE DEPENDENCIA, nao alfabetica. `readdirSync().sort()` poe
    // `codigo-de-autorizacao-funcao-v1` ANTES de `codigo-de-autorizacao-v1`
    // ('f' < 'v') e `recebimento-seguro-v1` antes de `status-da-fatura-v2`
    // ('r' < 's') -- as duas invertidas, as duas em arquivo que o proprio
    // cabecalho diz a ordem. Enquanto estavam aplicadas ninguem viu.
    const { ordem, faltando, ciclos } = ordenarPorDependencia(paraAplicar, livro)
    if (faltando.length) {
      // Recusa em vez de aplicar e torcer: a dependencia pode estar em
      // "MUDOU DEPOIS DE APLICADO", que fica fora do automatico de proposito.
      for (const f of faltando)
        console.error(`::error::${f.arquivo} depende de ${f.dep}, que nao esta aplicada nem na lista. Decida ela primeiro.`)
      process.exit(3)
    }
    for (const c of ciclos) console.error(`::error::dependencia circular em ${c} (DEPENDE_DE esta errado)`)
    if (ciclos.length) process.exit(3)

    if (soNomes) { for (const nome of ordem) console.log(nome); return }
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
      // `process.exit` aqui derruba o Node no Windows quando a conexao HTTP
      // da API ainda esta aberta:
      //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
      // `exitCode` + `return` deixa o Node fechar o que abriu e sair sozinho.
      process.exitCode = 1
      return
    }
    await anotar(exec, nome, hash)
  }
  console.log('Concluído.')
}

// Nada de `process.exit` aqui: com a conexao da API ainda aberta, o Windows
// aborta com `Assertion failed ... UV_HANDLE_CLOSING` DEPOIS da mensagem --
// o diagnostico aparece e o usuario ainda leva um crash. Marcar o codigo de
// saida faz o Node encerrar limpo assim que fechar o que abriu.
main().catch(e => { console.error(e.message || e); process.exitCode = 1 })
