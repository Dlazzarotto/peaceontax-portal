// testes/credencial-postgres.mts — ler a SUPABASE_DB_URL como ela é colada
//
// A primeira execução no GitHub falhou com erro de SOCKET LOCAL tendo o
// secret gravado. O psql aceita, no primeiro argumento, URI ou NOME DE
// BANCO: texto que não começa com postgresql:// vira nome de banco e ele
// procura um Postgres na própria máquina. O erro fala de socket e o defeito
// é o formato do texto — ninguém liga uma coisa à outra sozinho.

import { credencialDoPostgres, senhaParaUri, pistaDoErroDoPsql, refDaCadeia, conferirProjeto }
  from '../scripts/credencial-postgres.mjs'

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

// ── Senha com caractere especial ────────────────────────────────────────
// Conferido no PostgreSQL 16 (psql de verdade, senha 'ab@cd'): o libpq
// corta no PRIMEIRO "@" e o erro sai como
//   could not translate host name "cd@127.0.0.1"
// que não fala de senha nenhuma. O `new URL` do Node faz o CONTRÁRIO (corta
// no último), então não dá para usar o parser dele como juiz.
{
  const r = credencialDoPostgres('postgresql://u:ab@cd@host:5432/postgres')
  eq('dois @ é recusado', !!r.erro, true)
  eq('e o erro ensina o %40', r.erro!.includes('%40'), true)
  eq('e oferece a saída pelo segundo secret', r.erro!.includes('SUPABASE_DB_PASSWORD'), true)
  eq('e não vaza a senha', r.erro!.includes('ab@cd'), false)
}
{
  const r = credencialDoPostgres('postgresql://u:p#s@host:5432/postgres')
  eq('# na senha é recusado', !!r.erro, true)
  eq('com a mesma tabela de codificação', r.erro!.includes('%23'), true)
}
eq('senha já codificada passa',
  credencialDoPostgres('postgresql://u:ab%40cd@host:5432/postgres').url,
  'postgresql://u:ab%40cd@host:5432/postgres')

// ── A senha em secret próprio: nada para codificar ──────────────────────
{
  const r = credencialDoPostgres('postgresql://postgres.abc:[YOUR-PASSWORD]@h.pooler.supabase.com:5432/postgres', 'ab@cd')
  eq('a senha sai da URI', r.url, 'postgresql://postgres.abc@h.pooler.supabase.com:5432/postgres')
  eq('e vem crua, sem codificar', r.senha, 'ab@cd')
  eq('o marcador deixa de ser erro', r.erro, undefined)
}
{
  const r = credencialDoPostgres('postgresql://u:senhaVelha@h:5432/d', 'nova@x')
  eq('senha antiga na URI é descartada', r.url, 'postgresql://u@h:5432/d')
  eq('vale a do secret', r.senha, 'nova@x')
}
{
  const r = credencialDoPostgres('postgresql://u@h:5432/d', 'ab@cd')
  eq('URI já sem senha também serve', r.url, 'postgresql://u@h:5432/d')
}
eq('URI sem "@" nenhum é recusada mesmo com senha separada',
  !!credencialDoPostgres('postgresql://host:5432/d', 'x').erro, true)
eq('senha separada em branco não conta',
  credencialDoPostgres('postgresql://u:p@h:5432/d', '   ').url, 'postgresql://u:p@h:5432/d')

// senhaParaUri, para quem preferir codificar à mão
eq('codifica o arroba', senhaParaUri('ab@cd'), 'ab%40cd')
eq('codifica o porcento sem dobrar', senhaParaUri('a%b'), 'a%25b')
eq('codifica barra, cerquilha e interrogação', senhaParaUri('a/b#c?d'), 'a%2Fb%23c%3Fd')

// ── Texto de EXEMPLO colado no lugar do valor ───────────────────────────
// Aconteceu de verdade: a instrução trazia `postgres.SEUREF` como modelo e
// o modelo foi colado. O pooler respondeu
//   FATAL: (ENOTFOUND) tenant/user postgres.SEUREF not found
// depois de uma viagem ao servidor. Exemplo que parece colável é colado.
{
  const r = credencialDoPostgres('postgresql://postgres.SEUREF:[YOUR-PASSWORD]@aws-0.pooler.supabase.com:5432/postgres', 'senha-real')
  eq('SEUREF é recusado MESMO com a senha em secret próprio', !!r.erro, true)
  eq('e o erro manda copiar do painel', r.erro!.includes('Session pooler'), true)
}
eq('SEUREF sem senha separada também',
  !!credencialDoPostgres('postgresql://postgres.SEUREF:abc@h:5432/postgres').erro, true)
eq('<ref> entre sinais é recusado',
  !!credencialDoPostgres('postgresql://postgres.<ref>:abc@h:5432/postgres').erro, true)
eq('a palavra SENHA no lugar da senha é recusada',
  !!credencialDoPostgres('postgresql://postgres.abc:SENHA@h:5432/postgres').erro, true)
// O marcador do painel NÃO pode ser confundido com exemplo quando há senha
// separada: ele é o texto que o Supabase entrega, e o caminho existe para
// aceitar a cadeia exatamente como ela vem de lá.
eq('o [YOUR-PASSWORD] do painel passa, com senha separada',
  credencialDoPostgres('postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0.pooler.supabase.com:5432/postgres', 'x').url,
  'postgresql://postgres.abcdefgh@aws-0.pooler.supabase.com:5432/postgres')

// ── Traduzir a recusa do servidor ───────────────────────────────────────
eq('tenant/user aponta o USUÁRIO',
  pistaDoErroDoPsql('FATAL:  (ENOTFOUND) tenant/user postgres.SEUREF not found')!.includes('USUÁRIO'), true)
eq('senha recusada aponta a SENHA',
  pistaDoErroDoPsql('FATAL: password authentication failed for user "x"')!.includes('SENHA'), true)
eq('rede inalcançável aponta o IPv6',
  pistaDoErroDoPsql('could not connect: Network is unreachable')!.includes('IPv6'), true)
eq('host inexistente aponta o @ da senha',
  pistaDoErroDoPsql('could not translate host name "cd@x"')!.includes('primeiro "@"'), true)
eq('erro desconhecido não inventa pista',
  pistaDoErroDoPsql('algo completamente diferente'), null)
eq('vazio não estoura', pistaDoErroDoPsql(''), null)

// ── Projeto errado: o erro que não tem desfazer ─────────────────────────
// Duas cadeias, de dois projetos Supabase, na mesma semana. A errada só
// não passou porque o usuário ainda era texto de exemplo. Migração no
// banco errado cria as tabelas onde ninguém olha e deixa o certo sem elas.
eq('ref do pooler',
  refDaCadeia('postgresql://postgres.gaknnckgekvsgvxgvwvk@aws-1-us-east-1.pooler.supabase.com:5432/postgres'),
  'gaknnckgekvsgvxgvwvk')
eq('ref do pooler com senha na URI',
  refDaCadeia('postgresql://postgres.gaknnckgekvsgvxgvwvk:s3nh4@aws-1.pooler.supabase.com:5432/postgres'),
  'gaknnckgekvsgvxgvwvk')
eq('ref da conexão direta',
  refDaCadeia('postgresql://postgres:s3nh4@db.gaknnckgekvsgvxgvwvk.supabase.co:5432/postgres'),
  'gaknnckgekvsgvxgvwvk')
eq('host próprio não tem ref', refDaCadeia('postgresql://u:p@meubanco.exemplo.com:5432/d'), null)

eq('mesmo projeto passa',
  conferirProjeto('postgresql://postgres.abcdefghijklmnop@h:5432/d', 'abcdefghijklmnop').ok, true)
{
  const r = conferirProjeto('postgresql://postgres.wbljbyhdoffuyymxziqi@h:5432/d', 'gaknnckgekvsgvxgvwvk')
  eq('projeto diferente é RECUSADO', r.ok, false)
  eq('e o erro nomeia os dois', r.erro!.includes('wbljbyhdoffuyymxziqi') && r.erro!.includes('gaknnckgekvsgvxgvwvk'), true)
  eq('e diz que não tem desfazer', r.erro!.includes('não tem desfazer'), true)
}
// Sem o que comparar, não se inventa recusa: travar sem base pararia quem
// usa um banco próprio, e a trava existe para o engano, não para o uso.
eq('sem ref esperado, passa', conferirProjeto('postgresql://postgres.abc@h:5432/d', null).ok, true)
eq('cadeia sem ref, passa', conferirProjeto('postgresql://u:p@meubanco.com:5432/d', 'abcdefghijklmnop').ok, true)

console.log(`credencial-postgres: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
