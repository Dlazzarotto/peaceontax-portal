// lib/aplicar-na-fila.ts — aplicar uma regra aos lançamentos de um cliente:
// ler TUDO, gravar em LOTES, contar o que o banco recusou.
//
// "Clico na transação, crio a regra e ela não cria." Medido com 3.000
// lançamentos na fila (o que o histórico do Plaid passou a trazer) e 600 que
// casavam com a regra: a rota levou 6,3 s em 209 idas ao banco e reconheceu
// 200 das 600. Ela lia com `.limit(5000)`, que o PostgREST corta em MIL — e
// sem `order`, então nem dava para saber quais mil —, e gravava UMA linha por
// ida. Com mais casos, a função estoura o tempo e a tela não recebe resposta
// nenhuma; com a fila maior que mil, a regra "não pega" as que ficaram fora.
//
// Três regras, e as três valem para a fila (pending/auto) e para o registro:
//  1. Lê em páginas de mil, por `id`, até acabar. Leitura que falha LANÇA:
//     "nenhuma casou" seria uma afirmação falsa, com a tela dizendo ok.
//  2. Grava em lotes de 100 ids — o `in` vai na URL, e 100 uuids são ~3,8 KB,
//     onde 400 já passam do que o gateway aceita (a conciliação perdia o lote
//     assim) — e SÓ no que ainda está no estado lido: entre ler e gravar,
//     alguém pode ter aprovado a linha, e a regra não pode devolvê-la à fila.
//  3. Conta o que o banco GRAVOU (`count: 'exact'`), não o que se pediu; a
//     recusa viaja com o texto da primeira.
// A decisão "esta linha casa com a regra" fica com quem chama (`casa`): ela é
// do motor de classificação, que mora em três arquivos e precisa continuar
// idêntico — trazê-la para cá seria a quarta cópia.

export const POR_PAGINA = 1000
export const POR_LOTE = 100

export interface LinhaDaFila { id: string; description: string; amount: number | string; account_id?: string | null }

export interface ResultadoNaFila {
  /** Quantas casaram com a regra. */
  casaram: number
  /** Quantas o banco de fato gravou (as que mudaram de estado no meio ficam fora). */
  aplicadas: number
  /** Quantas o banco recusou. */
  falharam: number
  primeiraFalha: string | null
}

export async function aplicarNaFila(db: any, o: {
  clientId: string
  status: readonly string[]
  casa: (l: LinhaDaFila) => boolean
  alteracao: Record<string, unknown>
}): Promise<ResultadoNaFila> {
  const casam: string[] = []
  for (let de = 0; ; de += POR_PAGINA) {
    const { data, error } = await db.from('bank_transactions')
      .select('id, description, amount, account_id')
      .eq('client_id', o.clientId).in('status', [...o.status])
      .order('id').range(de, de + POR_PAGINA - 1)
    if (error) throw new Error(`não foi possível ler os lançamentos: ${error.message}`)
    for (const l of (data || []) as LinhaDaFila[]) if (o.casa(l)) casam.push(l.id)
    if (!data || data.length < POR_PAGINA) break
  }

  let aplicadas = 0, falharam = 0
  let primeiraFalha: string | null = null
  for (let i = 0; i < casam.length; i += POR_LOTE) {
    const lote = casam.slice(i, i + POR_LOTE)
    const { error, count } = await db.from('bank_transactions')
      .update(o.alteracao, { count: 'exact' })
      .eq('client_id', o.clientId).in('status', [...o.status]).in('id', lote)
    if (error) { falharam += lote.length; primeiraFalha ||= String(error.message || error) }
    else aplicadas += typeof count === 'number' ? count : lote.length
  }
  return { casaram: casam.length, aplicadas, falharam, primeiraFalha }
}
