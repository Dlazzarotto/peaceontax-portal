// lib/plaid-paginacao.ts — o núcleo da sincronização com o Plaid, sem rede nem banco.
//
// As três conexões do cliente que "não carregava antes de 20/05/2025" tinham o
// `last_synced_at` UM segundo depois de criadas, e nenhum outro: só a
// sincronização automática da conexão — quando o Plaid ainda não tinha o
// histórico pronto — terminou. As do botão morriam no meio, e morriam sempre
// no mesmo lugar, por três defeitos que se somavam:
//
// 1. Cada transação era gravada numa ida ao banco própria: 250 idas por página
//    do Plaid. Os 24 meses que a conexão pede são milhares de linhas — o tempo
//    da função (120 s) acabava no meio.
// 2. O cursor só era gravado no FIM. A função cortada por tempo não chega ao
//    fim: as linhas já gravadas ficavam, o cursor não, e o clique seguinte
//    recomeçava do MESMO lugar e morria no MESMO ponto. As mais antigas nunca
//    chegavam.
// 3. Linha que o banco recusava era só "não contada", e o cursor passava por
//    cima dela: perdida em silêncio.
//
// Agora a página inteira vai numa gravação só (e, se uma linha ruim derruba o
// lote, grava-se uma a uma para isolar e CONTAR a recusa); o cursor é salvo a
// cada página; e a rodada tem PRAZO — acabou o prazo, para, salva onde parou e
// diz que falta, em vez de ser cortada sem dizer nada.
//
// O erro de mutação (o Plaid mudou os dados no meio da paginação) recomeça da
// página em que ESTA rodada começou, como o Plaid manda; se repetir, recomeça
// do zero — as gravações são idempotentes (chave `plaid_tx_id`), então baixar
// de novo não duplica nada.
//
// Módulo puro, sem import de '@/': o teste o roda com um Plaid e um banco de
// mentira (testes/plaid-paginacao.mts).

export interface PaginaDoSync {
  added?: any[]
  modified?: any[]
  removed?: any[]
  next_cursor?: string
  has_more?: boolean
}

export const ERRO_DE_MUTACAO = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'

/** O Plaid pediu para recomeçar a paginação? (o código vem em `codigo`; a frase, na mensagem). */
export function ehErroDeMutacao(e: any): boolean {
  return e?.codigo === ERRO_DE_MUTACAO || String(e?.message || '').includes(ERRO_DE_MUTACAO)
}

/** O maior `count` que o /transactions/sync aceita: metade das idas ao Plaid. */
export const POR_PAGINA = 500

/** Trava de segurança: 400 páginas de 500 são 200 mil transações numa rodada. */
export const MAX_PAGINAS = 400

export interface ResultadoDaPaginacao {
  cursor: string | undefined
  /** O Plaid disse que não há mais nada (`has_more` falso). */
  completo: boolean
  paginas: number
  reinicios: number
}

/**
 * Percorre o /transactions/sync a partir de `cursorInicial`, aplicando cada
 * página e salvando o cursor depois dela. Para quando o Plaid diz que acabou,
 * ou quando o prazo acaba (`completo: false` — a próxima rodada continua de
 * onde esta parou). Erro que não é de mutação sobe.
 */
export async function percorrerSync(p: {
  cursorInicial: string | undefined
  pedir: (cursor: string | undefined) => Promise<PaginaDoSync>
  aplicar: (pagina: PaginaDoSync) => Promise<void>
  salvarCursor?: (cursor: string | undefined) => Promise<void>
  prazoMs: number
  agora?: () => number
  maxPaginas?: number
}): Promise<ResultadoDaPaginacao> {
  const agora = p.agora ?? Date.now
  const inicio = agora()
  const maxPaginas = p.maxPaginas ?? MAX_PAGINAS
  let cursor = p.cursorInicial
  let paginas = 0, reinicios = 0
  for (;;) {
    let pagina: PaginaDoSync
    try {
      pagina = await p.pedir(cursor || undefined)
    } catch (e) {
      if (ehErroDeMutacao(e) && reinicios < 2) {
        reinicios++
        // 1º: da página em que esta rodada começou (o que o Plaid manda).
        // 2º: do zero — o cursor salvo pode ser ele mesmo do meio de uma paginação.
        cursor = reinicios === 1 ? p.cursorInicial : undefined
        continue
      }
      throw e
    }
    await p.aplicar(pagina)
    paginas++
    // Cursor vazio = "o Plaid ainda não tem transações": vale guardar assim,
    // a próxima rodada pede do começo.
    cursor = pagina.next_cursor ?? cursor
    if (p.salvarCursor) await p.salvarCursor(cursor)
    if (!pagina.has_more) return { cursor, completo: true, paginas, reinicios }
    if (agora() - inicio >= p.prazoMs || paginas >= maxPaginas) return { cursor, completo: false, paginas, reinicios }
  }
}

/** Uma transação do Plaid como linha de `bank_transactions` — a convenção de sempre. */
export function linhaDoPlaid(tx: any, ctx: { clientId: string; instituicao: string | null; contaId: string | null }) {
  const data = String(tx.date)
  return {
    client_id: ctx.clientId,
    source: 'plaid',
    plaid_tx_id: tx.transaction_id,
    account_id: ctx.contaId,
    account_hint: ctx.instituicao || null,
    tx_date: data,
    fiscal_year: parseInt(data.slice(0, 4), 10),
    description: String(tx.merchant_name || tx.name || 'Transaction').slice(0, 500),
    // Plaid: positivo = saída; aqui: negativo = saída.
    amount: -Math.round(Number(tx.amount) * 100) / 100,
    payee: tx.merchant_name ? String(tx.merchant_name).slice(0, 120) : null,
    status: 'pending',
  }
}

/**
 * As transações novas de uma página, prontas para gravar: sem as pendentes
 * (o Plaid troca a pendente pela definitiva depois) e sem repetir id dentro
 * do lote — o mesmo id duas vezes num insert só derruba o lote inteiro.
 */
export function linhasNovasDaPagina(pagina: PaginaDoSync, ctx: { clientId: string; instituicao: string | null; contaDe: (plaidAccountId: string) => string | null }) {
  const vistos = new Set<string>()
  const linhas: ReturnType<typeof linhaDoPlaid>[] = []
  for (const tx of pagina.added || []) {
    if (tx?.pending) continue
    const id = String(tx?.transaction_id || '')
    if (!id || vistos.has(id)) continue
    vistos.add(id)
    linhas.push(linhaDoPlaid(tx, { clientId: ctx.clientId, instituicao: ctx.instituicao, contaId: ctx.contaDe(String(tx.account_id)) }))
  }
  return linhas
}

/**
 * A frase da sincronização para a tela (Banking e Caixa da firma usam a
 * mesma). Diz o que entrou, o que ainda falta baixar e o que o banco recusou —
 * "✓ 0 lançamentos novos" sozinho escondia as três coisas.
 */
export function mensagemDaSincronizacao(r: {
  ok?: boolean; error?: string; added?: number; ruled?: number; incompleto?: boolean; falhas?: number; details?: string[]
}): string {
  if (!r?.ok) return `Erro: ${r?.error || 'a sincronização não respondeu'}`
  const partes = [`✓ Plaid: ${r.added ?? 0} transações novas`]
  if (r.ruled) partes.push(`${r.ruled} reconhecidas pelas regras`)
  let texto = partes.join(' · ')
  if (r.details?.length) texto += ` (${r.details.join(' · ')})`
  if (r.falhas) texto += ` ⚠️ ${r.falhas} transação(ões) o banco recusou — veja o motivo acima e avise a equipe técnica.`
  if (r.incompleto) texto += ' ⏳ Ainda há transações para baixar: clique em Sincronizar de novo (cada rodada continua de onde a anterior parou).'
  return texto
}

/**
 * A frase de logo depois de CONECTAR o banco. Nesse momento o Plaid quase
 * sempre ainda não tem o histórico pronto, e "✓ 0 lançamentos importados"
 * soava como "não há nada"; e a primeira leitura que falhava sumia atrás do ✓.
 * `podeSincronizar`: a equipe tem o botão; no portal do cliente, quem traz o
 * resto é a firma.
 */
export function mensagemDaConexao(ex: any, podeSincronizar: boolean): string {
  if (!ex?.ok) return `Erro: ${ex?.error || 'a conexão não respondeu'}`
  const depois = podeSincronizar
    ? 'clique em Sincronizar daqui a alguns minutos para trazer o resto'
    // Não há sincronização automática: quem traz o resto é a equipe, no botão.
    : 'a equipe da Peace on Tax traz o restante na próxima sincronização'
  if (ex.sync?.error) return `✓ Banco conectado, mas a primeira leitura falhou (${ex.sync.error}) — ${depois}.`
  const n = Number(ex.sync?.added ?? 0)
  if (n === 0 || ex.sync?.completo === false) {
    return `✓ Banco conectado${n ? ` — ${n} transações já vieram` : ''}. O histórico (até 24 meses) o banco libera em alguns minutos: ${depois}.`
  }
  return `✓ Banco conectado — ${n} transações importadas.`
}
