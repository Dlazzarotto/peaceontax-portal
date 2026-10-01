// O LIVRO (`public.schema_migrations`): ler e classificar.
//
// Puro, e com teste, porque o leitor já deixou passar duas coisas — e as
// duas na direção perigosa: fizeram migração APLICADA parecer NUNCA
// APLICADA, que é o lado que leva a rodar de novo.
//
// 1. LINHA COM SHA VAZIO SUMIA. O padrão exigia os 64 dígitos
//    (`[0-9a-f]{64}`), então `sql/permissoes-por-pessoa-v3.sql` — gravada
//    com sha em branco — não casava, ficava fora do mapa e era anunciada
//    como PENDENTE. É a regra da casa outra vez: **linha malformada não
//    pode virar "não existe"**, do mesmo jeito que consulta que falha não
//    pode virar lista vazia.
//
// 2. NOME CURTO FICAVA INVISÍVEL. A chave do livro é o CAMINHO
//    (`sql/x.sql`). Quatro linhas foram gravadas como `x.sql`: o leitor as
//    guardava sob essa chave, ninguém consultava por ela, e as quatro eram
//    anunciadas como PENDENTE. O CLAUDE.md já avisava do risco; nada o
//    impedia.
//
// Nos dois casos o arquivo sai do automático e vira RELATO, com o conserto
// escrito: quem decide é gente. Reaplicar o que já está no banco é pior que
// esperar.

/**
 * Lê a saída do `select arquivo, sha256 from public.schema_migrations`.
 * Aceita o JSON da API de gestão e a tabela em texto do psql.
 *
 * Sha ausente, vazio ou fora do formato entra como `null` — a linha EXISTE,
 * e é isso que importa; o que falta é o sha.
 */
export function lerLivro(bruto) {
  const mapa = new Map()
  const por = (arquivo, sha) => {
    if (!arquivo) return
    const s = String(sha ?? '').trim().toLowerCase()
    mapa.set(String(arquivo).trim(), /^[0-9a-f]{64}$/.test(s) ? s : null)
  }
  try {
    for (const l of JSON.parse(bruto)) por(l.arquivo, l.sha256)
    return mapa
  } catch {
    for (const l of String(bruto || '').split('\n')) {
      // A coluna do sha pode vir vazia: `| ` seguido de nada.
      const m = l.match(/^\s*(\S+\.sql)\s*\|\s*([0-9a-zA-Z]*)\s*$/)
      if (m) por(m[1], m[2])
    }
    return mapa
  }
}

export const ESTADOS = {
  OK: 'ok',
  PENDENTE: 'PENDENTE',
  MUDOU: 'MUDOU DEPOIS DE APLICADO',
  SEM_SHA: 'REGISTRO SEM SHA',
  NOME_CURTO: 'REGISTRADA COM NOME CURTO',
}

/**
 * Em que estado está `caminho` (sempre `sql/x.sql`), dado o `hash` do
 * arquivo em disco e o livro lido.
 *
 * Só `PENDENTE` entra no automático. Os outros três não-ok são RELATO: o
 * arquivo pode já estar no banco, e aplicar de novo é o risco.
 */
export function estadoDaMigracao(caminho, hash, livro) {
  if (livro.has(caminho)) {
    const sha = livro.get(caminho)
    if (!sha) return ESTADOS.SEM_SHA
    return sha === hash ? ESTADOS.OK : ESTADOS.MUDOU
  }
  // Gravada com o nome curto? A linha existe, só está sob a chave errada.
  const curto = caminho.startsWith('sql/') ? caminho.slice(4) : caminho
  if (curto !== caminho && livro.has(curto)) return ESTADOS.NOME_CURTO
  return ESTADOS.PENDENTE
}

/**
 * O SQL que conserta uma linha gravada com o nome curto.
 *
 * RENOMEIA E SO. A primeira versao tambem gravava `sha256 = <hash atual>`, e
 * isso APAGA um sinal verdadeiro: `sql/permissoes-por-pessoa-v1.sql` esta no
 * livro com 90a85f0af77f e no disco com 0bfe8dd357b4 -- o arquivo foi
 * editado seis dias DEPOIS de aplicado (a conferencia foi reescrita, caso
 * que o CLAUDE.md ja registra). Sobrescrever o sha transformaria esse
 * "MUDOU DEPOIS DE APLICADO" legitimo num "ok" falso.
 *
 * Mantendo o sha gravado, o proximo `--pendentes` diz a verdade: ou `ok`,
 * ou `MUDOU DEPOIS DE APLICADO` -- e aí quem decide e gente.
 */
export function consertoDoNomeCurto(caminho) {
  const curto = caminho.slice(4)
  return `update public.schema_migrations set arquivo = '${caminho}'`
    + ` where arquivo = '${curto}';`
}

/**
 * O SQL que preenche um sha que ficou em branco.
 *
 * Aqui NAO ha sha gravado para preservar, entao o unico valor possivel e o
 * do arquivo de hoje -- e isso e uma AFIRMACAO: "o que esta no repositorio
 * agora e o que rodou". Confira a data do arquivo contra a de aplicacao
 * antes de colar. No caso real (permissoes-por-pessoa-v3) o arquivo mudou
 * pela ultima vez tres minutos ANTES de ser aplicado, entao a afirmacao e
 * verdadeira; nao e assim por sorte, e por conferencia.
 */
export function consertoDoShaVazio(caminho, hash) {
  return `update public.schema_migrations set sha256 = '${hash}' where arquivo = '${caminho}';`
}
