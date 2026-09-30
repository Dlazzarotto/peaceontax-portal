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

export function credencialDoPostgres(cru) {
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

  if (MARCADOR.test(limpo)) {
    return {
      erro: 'SUPABASE_DB_URL ainda tem o marcador da senha ([YOUR-PASSWORD]). '
          + 'Troque pela senha do BANCO (Supabase → Project Settings → Database → '
          + 'Database password; dá para redefinir ali).',
    }
  }

  const avisos = []
  // Conexão DIRETA: só IPv6 na maioria dos projetos, e o runner do GitHub é
  // IPv4. Não é motivo para recusar (na máquina do sócio funciona), mas se
  // falhar por rede é isto.
  if (/@db\.[a-z0-9]+\.supabase\.co/i.test(limpo)) {
    avisos.push(
      'Esta é a conexão DIRETA do Supabase. No GitHub ela costuma falhar com '
      + '"network unreachable": o runner só tem IPv4 e ela é só IPv6. Use a do Session pooler.')
  }
  if (limpo !== original.trim()) {
    avisos.push('A cadeia tinha "psql", aspas ou espaços em volta — foram removidos.')
  }
  return { url: limpo, avisos }
}
