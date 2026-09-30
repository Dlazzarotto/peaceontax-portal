// Ler a SUPABASE_DB_URL do jeito que ela é colada de verdade.
//
// POR QUE ISTO EXISTE
// A primeira execução no GitHub falhou com:
//   psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432"
//   failed: No such file or directory
// O secret ESTAVA lá. O que aconteceu é que o `psql` aceita, no lugar do
// primeiro argumento, ou uma URI ou um NOME DE BANCO — e qualquer coisa que
// não comece com `postgresql://` ele entende como nome de banco e vai
// procurar um Postgres LOCAL. O erro fala de socket, o problema é o formato
// do texto, e ninguém liga uma coisa à outra.
//
// E o texto errado é fácil de colar: o botão do Supabase copia a LINHA DE
// COMANDO inteira (`psql "postgresql://…"`), o teclado do celular acrescenta
// aspas curvas, e o campo de secret guarda a quebra de linha do fim.
// Por isso aqui se limpa o que dá para limpar e se RECUSA com explicação o
// que não dá — em vez de deixar o psql falhar falando de outra coisa.

/** O marcador que o Supabase mostra no lugar da senha. */
const MARCADOR = /\[(YOUR-PASSWORD|SUA-SENHA|PASSWORD|YOUR_PASSWORD)\]/i

/**
 * Como escrever uma senha com caractere especial DENTRO da URI.
 *
 * Conferido no PostgreSQL 16: o libpq corta no PRIMEIRO `@`, não no último
 * (o `new URL` do Node faz o contrário — os dois discordam, então não dá
 * para confiar no parser do Node para decidir). Uma senha `ab@cd` sem
 * codificar vira `could not translate host name "cd@..."`, que não fala de
 * senha nenhuma.
 */
export const CODIFICACAO = [
  ['@', '%40'], [':', '%3A'], ['/', '%2F'], ['?', '%3F'],
  ['#', '%23'], ['%', '%25'], ['[', '%5B'], [']', '%5D'],
]

/** Codifica a senha para caber na URI. O `%` vai primeiro, senão dobra. */
export function senhaParaUri(senha) {
  return encodeURIComponent(String(senha ?? ''))
}

/**
 * @param cru            o que está em SUPABASE_DB_URL
 * @param senhaSeparada  o que está em SUPABASE_DB_PASSWORD (opcional)
 *
 * Com a senha SEPARADA, a URI pode vir exatamente como o painel mostra
 * (inclusive com `[YOUR-PASSWORD]`): a senha sai da URI e vai por
 * PGPASSWORD, que não passa por parser nenhum — nada para codificar.
 */
export function credencialDoPostgres(cru, senhaSeparada) {
  const original = String(cru ?? '')
  // Aspas curvas do teclado do celular viram retas antes de tudo.
  const limpo = original
    .replace(/[“”‘’]/g, '"')
    .trim()
    .replace(/^psql\s+/i, '')      // o botão copia a linha de comando inteira
    .replace(/^["']|["']$/g, '')   // aspas em volta
    .trim()

  if (!limpo) {
    return { erro: 'SUPABASE_DB_URL está vazia.' }
  }

  if (!/^postgres(ql)?:\/\//i.test(limpo)) {
    // O valor NUNCA aparece na mensagem, nem em pedaço: isto é impresso em
    // log de CI, e `usuario:senha@host` põe a senha nos primeiros caracteres.
    // O GitHub só mascara o secret INTEIRO — um trecho passa limpo.
    const pista = /@/.test(limpo) && /:/.test(limpo)
      ? 'O que está gravado PARECE uma cadeia de conexão sem o "postgresql://" na frente: '
        + 'acrescente esse prefixo, ou copie de novo do painel.'
      : 'O que está gravado não parece uma cadeia de conexão.'
    return {
      erro:
        'SUPABASE_DB_URL não é uma cadeia de conexão: ela precisa começar com "postgresql://".\n'
        + '      O psql trata qualquer outro texto como NOME DE BANCO e procura um Postgres '
        + 'LOCAL — é daí que vem o erro de socket "/var/run/postgresql/.s.PGSQL.5432".\n'
        + '      Pegue o URI em Supabase → Connect → Session pooler. Ele é assim:\n'
        + '      postgresql://postgres.<ref>:SENHA@aws-0-<regiao>.pooler.supabase.com:5432/postgres\n'
        + `      ${pista} (${limpo.length} caracteres)`,
    }
  }

  const senha = String(senhaSeparada ?? '').trim()
  if (senha) {
    // A senha vai por PGPASSWORD; a URI fica só com o usuário. Tudo o que
    // estiver entre o `:` do usuário e o último `@` é descartado — inclusive
    // o marcador do painel e uma senha antiga colada ali.
    const semEsquema = limpo.replace(/^postgres(ql)?:\/\//i, '')
    const esquema = limpo.slice(0, limpo.length - semEsquema.length)
    const corte = semEsquema.lastIndexOf('@')
    if (corte < 0) {
      return { erro: 'SUPABASE_DB_URL não tem usuário nem servidor (falta o "@"). Copie o URI inteiro do painel.' }
    }
    const usuario = semEsquema.slice(0, corte).split(':')[0]
    const resto = semEsquema.slice(corte + 1)
    if (!usuario) return { erro: 'SUPABASE_DB_URL não traz o usuário antes do "@".' }
    return {
      url: `${esquema}${usuario}@${resto}`,
      senha,
      avisos: avisosDe(limpo, original),
    }
  }

  // Senha dentro da URI: aqui o caractere especial importa.
  const autoridade = limpo.replace(/^postgres(ql)?:\/\//i, '').split('/')[0]
  if ((autoridade.match(/@/g) || []).length > 1) {
    return {
      erro:
        'SUPABASE_DB_URL tem mais de um "@" antes do servidor — a senha deve ter um "@" '
        + 'e ele precisa ser escrito como %40.\n'
        + '      Conferido no PostgreSQL 16: o psql corta no PRIMEIRO "@", então a senha crua '
        + 'faz o servidor virar outra coisa e o erro fala de "host name", não de senha.\n'
        + '      Troque na senha:  @ → %40   : → %3A   / → %2F   ? → %3F   # → %23   % → %25\n'
        + '      Ou, mais simples: crie o secret SUPABASE_DB_PASSWORD com a senha CRUA e '
        + 'deixe a URI sem senha — aí não há nada para codificar.',
    }
  }
  try { new URL(limpo) } catch {
    return {
      erro:
        'SUPABASE_DB_URL não é uma URL válida — quase sempre é caractere especial na senha '
        + '(#, ?, /, %).\n'
        + '      Troque na senha:  @ → %40   : → %3A   / → %2F   ? → %3F   # → %23   % → %25\n'
        + '      Ou crie o secret SUPABASE_DB_PASSWORD com a senha CRUA e deixe a URI sem '
        + 'senha — aí não há nada para codificar.',
    }
  }

  if (MARCADOR.test(limpo)) {
    return {
      erro: 'SUPABASE_DB_URL ainda tem o marcador da senha ([YOUR-PASSWORD]). '
          + 'Troque pela senha do BANCO (Supabase → Project Settings → Database → '
          + 'Database password; dá para redefinir ali).',
    }
  }

  return { url: limpo, avisos: avisosDe(limpo, original) }
}

function avisosDe(limpo, original) {
  const avisos = []
  // Conexão DIRETA: só IPv6 na maioria dos projetos, e o runner do GitHub é
  // IPv4. Não é motivo para recusar (na máquina do sócio funciona), mas se
  // falhar por rede é isto.
  if (/@db\.[a-z0-9]+\.supabase\.co/i.test(limpo)) {
    avisos.push(
      'Esta é a conexão DIRETA do Supabase. No GitHub ela costuma falhar com '
      + '"network unreachable": o runner só tem IPv4 e ela é só IPv6. Use a do Session pooler.')
  }
  if (limpo !== String(original).trim()) {
    avisos.push('A cadeia tinha "psql", aspas ou espaços em volta — foram removidos.')
  }
  return avisos
}
