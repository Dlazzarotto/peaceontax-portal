// testes/credencial-postgres.mts — ler a SUPABASE_DB_URL como ela é colada
//
// A primeira execução no GitHub falhou com erro de SOCKET LOCAL tendo o
// secret gravado. O psql aceita, no primeiro argumento, URI ou NOME DE
// BANCO: texto que não começa com postgresql:// vira nome de banco e ele
// procura um Postgres na própria máquina. O erro fala de socket e o defeito
// é o formato do texto — ninguém liga uma coisa à outra sozinho.

import { credencialDoPostgres } from '../scripts/credencial-postgres.mjs'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const URI = 'postgresql://postgres.abc:s3nh4@aws-0-us-east-1.pooler.supabase.com:5432/postgres'

// ── O que passa ─────────────────────────────────────────────────────────
eq('a URI do pooler passa', credencialDoPostgres(URI).url, URI)
eq('postgres:// também é válido',
  credencialDoPostgres('postgres://a:b@c:5432/d').url, 'postgres://a:b@c:5432/d')
eq('quebra de linha do campo de secret não atrapalha',
  credencialDoPostgres(`  ${URI}\n`).url, URI)

// O botão do Supabase copia a LINHA DE COMANDO, não só a cadeia.
eq('psql + aspas: limpa', credencialDoPostgres(`psql "${URI}"`).url, URI)
eq('PSQL maiúsculo também', credencialDoPostgres(`PSQL '${URI}'`).url, URI)
eq('aspas curvas do teclado do celular',
  credencialDoPostgres(`psql “${URI}”`).url, URI)
eq('e avisa que mexeu', credencialDoPostgres(`psql "${URI}"`).avisos?.length, 1)
eq('cadeia limpa não gera aviso', credencialDoPostgres(URI).avisos, [])

// ── O que é RECUSADO, com o motivo certo ────────────────────────────────
{
  const r = credencialDoPostgres('postgres.abc:s3nh4@aws-0.pooler.supabase.com:5432/postgres')
  eq('sem o esquema é recusado', !!r.erro, true)
  eq('e o erro EXPLICA o socket', r.erro!.includes('socket'), true)
  eq('e diz que parece uma cadeia sem o prefixo', r.erro!.includes('sem o "postgresql://" na frente'), true)
  // O erro vai para log de CI. O GitHub só mascara o secret INTEIRO: um
  // trecho passa limpo, e num texto sem esquema a senha está no comeco.
  eq('NUNCA vaza o valor no erro', r.erro!.includes('s3nh4'), false)
  eq('nem um pedaço dele', r.erro!.includes('postgres.abc'), false)
  eq('mas diz o tamanho, que ajuda e não vaza', r.erro!.includes('caracteres'), true)
  eq('e não devolve url', r.url, undefined)
}
eq('vazia é recusada', !!credencialDoPostgres('').erro, true)
eq('só espaços é recusada', !!credencialDoPostgres('   ').erro, true)
eq('indefinida não estoura', !!credencialDoPostgres(undefined).erro, true)
eq('a senha de exemplo do painel é recusada',
  credencialDoPostgres('postgresql://postgres.abc:[YOUR-PASSWORD]@x.pooler.supabase.com:5432/postgres')
    .erro!.includes('[YOUR-PASSWORD]'), true)
{
  const r = credencialDoPostgres('minha-senha-secreta-colada-sem-querer')
  eq('texto qualquer também não vaza', r.erro!.includes('minha-senha'), false)
}
eq('e o texto diz onde redefinir a senha',
  credencialDoPostgres('postgresql://postgres.abc:[YOUR-PASSWORD]@x:5432/d')
    .erro!.includes('Database password'), true)

// ── Conexão direta: avisa, não recusa ───────────────────────────────────
{
  const direta = 'postgresql://postgres:s3nh4@db.abcdefgh.supabase.co:5432/postgres'
  const r = credencialDoPostgres(direta)
  eq('a direta NÃO é recusada -- na máquina do sócio funciona', r.url, direta)
  eq('mas avisa do IPv4 do runner', r.avisos?.[0]?.includes('IPv4'), true)
}
eq('a do pooler não leva esse aviso',
  credencialDoPostgres(URI).avisos?.some((a: string) => a.includes('IPv4')), false)

console.log(`credencial-postgres: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
