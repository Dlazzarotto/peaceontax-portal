// lib/paginar.ts — ler TODAS as linhas de uma consulta, em páginas de 1000.
//
// O PostgREST corta a resposta em 1000 linhas por padrão, e `.limit(5000)` ou
// `.limit(20000)` NÃO passam disso: a consulta devolve mil e não avisa. Foi
// assim que o P&L, o Balanço e o relatório de fornecedores saíam ERRADOS para
// cliente com mais de mil lançamentos aprovados no período — número de
// imposto, truncado em silêncio —, e que o fluxo de caixa perdia os meses
// recentes (o extrato vinha em ordem crescente).
//
// `monta` devolve um builder NOVO a cada página: o builder do supabase-js é
// mutável, e reaproveitar um empilharia `range` sobre `range`. A ordem é por
// `id`, que toda tabela tem — sem `order`, a paginação não é estável e uma
// linha pode vir duas vezes ou nenhuma.
//
// Devolve `{ data, error }` como o supabase, para o laço de erros de cada rota
// tratar tudo do mesmo jeito (consulta que falha não vira lista vazia).

export async function todasAsLinhas<T = any>(
  monta: () => any, pagina = 1000,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const linhas: T[] = []
  for (let de = 0; ; de += pagina) {
    const { data, error } = await monta().order('id').range(de, de + pagina - 1)
    if (error) return { data: linhas, error }
    linhas.push(...(data || []))
    if (!data || data.length < pagina) break
  }
  return { data: linhas, error: null }
}
