// lib/plaid-sync.ts — sincroniza transações de um plaid_item para bank_transactions
// Convenção de sinal: Plaid usa positivo = saída; nosso padrão é negativo = saída → inverte.

import { plaidPost } from '@/lib/plaid'
import { applyRulesToClient } from '@/lib/apply-rules'
import { colunaAusente } from '@/lib/caixa-firma'
import { todasAsLinhas } from '@/lib/paginar'
import {
  percorrerSync, linhasNovasDaPagina, POR_PAGINA, ehTravaDeDuplicidade, separarSuspeitas, gemeaDeOutraOrigem, exemploDaLinha,
  type LinhaDoLivro,
} from '@/lib/plaid-paginacao'

/** Prazo de UMA conexão por rodada, se quem chama não disser outro. */
export const PRAZO_PADRAO_MS = 40_000

/** Quantos exemplos de "igual a outra do mesmo dia" vão para a tela. */
const EXEMPLOS = 3

/**
 * `aplicarRegras: false` — quem sincroniza VÁRIAS conexões aplica as regras
 * uma vez no fim. Aplicar por conexão reaplicava a fila inteira do cliente a
 * cada banco, e a contagem saía somada ("10574 reconhecidas" com 3.471 novas).
 */
export async function syncPlaidItem(db: any, plaidItemRowId: string, opcoes: { prazoMs?: number; aplicarRegras?: boolean } = {}) {
  const { data: item } = await db.from('plaid_items').select('*').eq('id', plaidItemRowId).single()
  if (!item) throw new Error('Conexão não encontrada')
  if (item.status === 'disconnected') throw new Error('Conexão desativada')

  // Contas do item → upsert em bank_accounts
  const accountsRes = await plaidPost('/accounts/get', { access_token: item.access_token })
  const accountMap: Record<string, string> = {}   // plaid account_id → bank_accounts.id
  const agora = new Date().toISOString()
  for (const acc of accountsRes.accounts || []) {
    const name = `${item.institution_name || 'Bank'} ${acc.name}${acc.mask ? ` ...${acc.mask}` : ''}`.slice(0, 120)
    const isCC = acc.type === 'credit'
    const base = {
      client_id: item.client_id, name, account_hint: name,
      type: isCC ? 'credit_card' : (acc.subtype === 'savings' ? 'savings' : 'checking'),
    }
    // O SALDO vem daqui e de nenhum outro lugar. O `/transactions/sync` traz
    // a transação, não o saldo depois dela — sem isto o fluxo projetado
    // nasce sem o número de que depende, e "saldo desconhecido" é o que
    // todo mundo que conectou o banco veria. Em cartão de crédito o valor é
    // DÍVIDA; quem soma caixa deixa cartão de fora (lib/fluxo-de-caixa.ts).
    const comSaldo = {
      ...base,
      current_balance: acc.balances?.current ?? null,
      available_balance: acc.balances?.available ?? null,
      balance_as_of: agora,
    }
    const grava = (campos: any) => db.from('bank_accounts')
      .upsert(campos, { onConflict: 'client_id,name' }).select('id').single()

    let { data: row, error } = await grava(comSaldo)
    // As colunas de saldo podem ainda não existir: o código sobe na Vercel
    // a cada push e a migração roda à mão. Perder o saldo é um incômodo;
    // derrubar a sincronização inteira do extrato por causa dele não é
    // aceitável — é o mesmo cuidado de `idDaFirma` com `is_firm`.
    if (error && colunaAusente(error)) ({ data: row } = await grava(base))
    if (row) accountMap[acc.account_id] = row.id
  }

  // transactions/sync com cursor — o núcleo (página em lote, cursor salvo a
  // cada página, prazo, recomeço no erro de mutação) é lib/plaid-paginacao.ts.
  let added = 0, modified = 0, removed = 0, falhas = 0, jaNoLivro = 0, iguais = 0
  let primeiraFalha: string | null = null
  const exemplos: string[] = []
  const recusa = (e: any) => { falhas++; primeiraFalha ||= String(e?.message || e) }
  const ctx = {
    clientId: item.client_id, instituicao: item.institution_name || null,
    contaDe: (plaidAccountId: string) => accountMap[plaidAccountId] || null,
  }

  type Linha = ReturnType<typeof linhasNovasDaPagina>[number]
  const gravar = (linhas: Linha | Linha[]) => db.from('bank_transactions')
    .upsert(linhas, { onConflict: 'plaid_tx_id', ignoreDuplicates: true }).select('id')

  /**
   * Uma a uma — o último recurso, para isolar e CONTAR quem o banco recusa (o
   * cursor vai passar por ela, e ela não pode sumir calada). A recusa da trava
   * de duplicidade não é "erro técnico": ou a transação já estava no livro
   * (veio de outra origem: extrato, QuickBooks, à mão), ou é igual a outra do
   * mesmo dia — e essa a pessoa precisa conferir no extrato, então vai com
   * exemplo. Sem saber a origem (a leitura do livro falhou), conta como igual:
   * pedir conferência é o lado seguro.
   */
  const umaAUma = async (linhas: Linha[], origemDaGemea: (l: Linha) => string | null) => {
    for (const linha of linhas) {
      const um = await gravar(linha)
      if (!um.error) { added += (um.data || []).length; continue }
      if (!ehTravaDeDuplicidade(um.error)) { recusa(um.error); continue }
      if (gemeaDeOutraOrigem(origemDaGemea(linha))) { jaNoLivro++; continue }
      iguais++
      if (exemplos.length < EXEMPLOS) exemplos.push(exemploDaLinha(linha))
    }
  }

  const rodada = await percorrerSync({
    cursorInicial: item.sync_cursor || undefined,
    prazoMs: opcoes.prazoMs ?? PRAZO_PADRAO_MS,
    pedir: cursor => plaidPost('/transactions/sync', {
      access_token: item.access_token,
      ...(cursor ? { cursor } : {}),
      count: POR_PAGINA,
    }),
    aplicar: async pagina => {
      // A página inteira numa gravação só. `ignoreDuplicates` + `select('id')`
      // devolve só as que ENTRARAM: a contagem é das novas, não das já vistas.
      const novas = linhasNovasDaPagina(pagina, ctx)
      if (novas.length) {
        const lote = await gravar(novas)
        if (!lote.error) added += (lote.data || []).length
        else if (ehTravaDeDuplicidade(lote.error)) {
          // A trava de duplicidade (mesma data, descrição e valor) derrubou o
          // lote. Uma a uma eram 500 idas — o que comia o prazo. Separa as
          // suspeitas pelo que já está no livro naquelas datas e grava o resto
          // de uma vez; as suspeitas, uma a uma: quem decide é o banco.
          const datas = novas.map(n => n.tx_date).sort()
          const doLivro = await todasAsLinhas<LinhaDoLivro>(() => db.from('bank_transactions')
            .select('tx_date, description, amount, source, plaid_tx_id')
            .eq('client_id', item.client_id).gte('tx_date', datas[0]).lte('tx_date', datas[datas.length - 1]))
          if (doLivro.error) await umaAUma(novas, () => null)
          else {
            const { livres, suspeitas, origemDaGemea } = separarSuspeitas(novas, doLivro.data)
            if (livres.length) {
              const resto = await gravar(livres)
              if (!resto.error) added += (resto.data || []).length
              else await umaAUma(livres, origemDaGemea)
            }
            await umaAUma(suspeitas, origemDaGemea)
          }
        } else await umaAUma(novas, () => null)
      }

      for (const tx of pagina.modified || []) {
        if (tx.pending) continue
        const { error } = await db.from('bank_transactions').update({
          tx_date: tx.date,
          description: (tx.merchant_name || tx.name || 'Transaction').slice(0, 500),
          amount: -Math.round(tx.amount * 100) / 100,
          updated_at: new Date().toISOString(),
        }).eq('plaid_tx_id', tx.transaction_id).neq('status', 'reviewed').neq('status', 'approved')
        if (error) recusa(error); else modified++
      }

      for (const tx of pagina.removed || []) {
        const { error } = await db.from('bank_transactions').delete()
          .eq('plaid_tx_id', tx.transaction_id)
          .in('status', ['pending', 'auto'])   // preserva registro aprovado
        if (error) recusa(error); else removed++
      }
    },
    // A cada página: a função cortada por tempo não perde o que já andou.
    salvarCursor: async cursor => {
      await db.from('plaid_items').update({ sync_cursor: cursor }).eq('id', plaidItemRowId)
    },
  })

  await db.from('plaid_items').update({
    sync_cursor: rodada.cursor,
    last_synced_at: new Date().toISOString(),
    status: 'active',
  }).eq('id', plaidItemRowId)

  // Regras aplicam AUTOMATICAMENTE às transações recém-chegadas (estilo QuickBooks)
  const ruled = added > 0 && opcoes.aplicarRegras !== false ? await applyRulesToClient(db, item.client_id).catch(() => 0) : 0

  return { added, modified, removed, ruled, completo: rodada.completo, falhas, primeiraFalha, jaNoLivro, iguais, exemplos }
}
