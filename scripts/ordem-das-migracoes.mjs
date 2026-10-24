// A ORDEM em que as migrações pendentes são aplicadas.
//
// O DEFEITO QUE ISTO CONSERTA
// `migrar.mjs` listava as pendentes em ordem ALFABÉTICA (`readdirSync().sort()`)
// e o workflow aplicava nessa ordem. Alfabética não é ordem de dependência, e
// em pelo menos dois casos reais ela está INVERTIDA:
//
//   · `codigo-de-autorizacao-funcao-v1.sql` vem antes de
//     `codigo-de-autorizacao-v1.sql` ('f' < 'v') — a FUNÇÃO seria criada
//     antes da TABELA que ela consome. O CLAUDE.md já dizia "nessa ordem":
//     a tabela, depois a função. Nada garantia.
//   · `recebimento-seguro-v1.sql` vem antes de `status-da-fatura-v2.sql`
//     ('r' < 's') — e o próprio arquivo diz que roda DEPOIS dela.
//
// Enquanto as duas estavam aplicadas, ninguém viu. Elas voltaram a aparecer
// como PENDENTE juntas, e aí `aplicar` rodaria na ordem errada, num banco com
// dado de imposto de quase mil pessoas.
//
// O que NÃO se faz aqui: adivinhar dependência lendo o SQL. Dependência é
// DECLARADA, porque errar para o lado de "achei que não dependia" é
// exatamente o defeito que isto conserta.

/** `arquivo` só entra depois de todos os caminhos listados. */
export const DEPENDE_DE = {
  // A tabela antes da função que a consome (o SQL Editor obriga a separar:
  // arquivo que cria tabela não pode definir função).
  'sql/codigo-de-autorizacao-funcao-v1.sql': ['sql/codigo-de-autorizacao-v1.sql'],
  'sql/caixa-conciliacao-funcao-v1.sql':     ['sql/caixa-conciliacao-v1.sql'],
  'sql/contrato-recorrente-itens-funcao-v1.sql': ['sql/contrato-recorrente-itens-v1.sql'],
  // A v2 troca um índice que a v1 criou.
  'sql/caixa-conciliacao-v2.sql':            ['sql/caixa-conciliacao-v1.sql'],
  // A v4 substitui o CHECK da tabela que a v1 cria.
  'sql/permissoes-por-pessoa-v4.sql':        ['sql/permissoes-por-pessoa-v1.sql'],
  // Escrito no cabeçalho do próprio arquivo: roda depois de status-da-fatura-v2.
  'sql/recebimento-seguro-v1.sql':           ['sql/status-da-fatura-v2.sql'],
  // Liga cada login da FIRMA à equipe, e "da firma" é o papel em app_metadata
  // -- antes da migração do papel, ninguém seria da firma e ninguém entraria.
  'sql/equipe-unica-v1.sql':                 ['sql/papel-no-app-metadata-v1.sql'],
  // O contrato trazido sem autor recebe um socio, e o socio sai de team_members.
  'sql/contrato-unico-v1.sql':               ['sql/equipe-unica-v1.sql'],
  'sql/contrato-unico-funcao-v1.sql':        ['sql/contrato-unico-v1.sql'],
  // As funcoes do plano de contas gravam na trilha e leem a marca do 1099.
  'sql/plano-de-contas-edicao-funcao-v1.sql': ['sql/plano-de-contas-edicao-v1.sql', 'sql/plano-de-contas-1099-v1.sql'],
}

/**
 * Ordena as pendentes respeitando `DEPENDE_DE`.
 *
 * Estável: quem não tem dependência entre si fica na ordem em que chegou (a
 * alfabética), para a lista não embaralhar sem motivo a cada execução.
 *
 * Devolve `{ ordem, faltando }`. `faltando` são as dependências que não estão
 * aplicadas NEM na lista — nesse caso a rotina que chama **recusa**, em vez
 * de aplicar e torcer: a dependência pode estar em "MUDOU DEPOIS DE
 * APLICADO", que de propósito fica fora do automático.
 */
export function ordenarPorDependencia(pendentes, aplicados = new Set(), mapa = DEPENDE_DE) {
  // `aplicados` e um Set de caminhos com estado ok (aplicadasParaDependencia,
  // de livro-de-migracoes.mjs). O livro cru e um Map, e esta funcao aceitava
  // "Set ou objeto": com o Map, `aplicados[x]` dava sempre undefined e TODA
  // dependencia de migracao ja aplicada parecia faltar. Ficou assim de 01/10
  // ate a primeira dependencia desse tipo (equipe-unica-v1 ->
  // papel-no-app-metadata-v1) travar o --pendentes. Entrada errada recusa em
  // voz alta; nunca vira "falta" calada.
  if (!(aplicados instanceof Set)) {
    throw new TypeError('ordenarPorDependencia: `aplicados` tem de ser um Set de caminhos com estado ok '
      + '(aplicadasParaDependencia do livro), nao o livro cru')
  }
  const lista = Array.from(pendentes || [])
  const naLista = new Set(lista)
  const temAplicado = (x) => aplicados.has(x)

  const faltando = []
  for (const a of lista) {
    for (const dep of mapa[a] || []) {
      if (!naLista.has(dep) && !temAplicado(dep)) faltando.push({ arquivo: a, dep })
    }
  }

  const ordem = []
  const pronto = new Set()
  const emCurso = new Set()
  const ciclos = []

  const visitar = (a) => {
    if (pronto.has(a)) return
    if (emCurso.has(a)) { ciclos.push(a); return }   // ciclo: não trava, acusa
    emCurso.add(a)
    for (const dep of mapa[a] || []) if (naLista.has(dep)) visitar(dep)
    emCurso.delete(a)
    pronto.add(a)
    ordem.push(a)
  }
  for (const a of lista) visitar(a)

  return { ordem, faltando, ciclos }
}
