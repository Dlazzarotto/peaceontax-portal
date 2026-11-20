// lib/plaid-sync.ts — sincroniza transações de um plaid_item para bank_transactions
// Convenção de sinal: Plaid usa positivo = saída; nosso padrão é negativo = saída → inverte.

import { plaidPost } from '@/lib/plaid'
import { applyRulesToClient } from '@/lib/apply-rules'
import { colunaAusente } from '@/lib/caixa-firma'
import { percorrerSync, linhasNovasDaPagina, POR_PAGINA } from '@/lib/plaid-paginacao'

/** Prazo de UMA conexão por rodada, se quem chama não disser outro. */
export const PRAZO_PADRAO_MS = 40_000

export async function syncPlaidItem(db: any, plaidItemRowId: string, opcoes: { prazoMs?: number } = {}) {
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
  let added = 0, modified = 0, removed = 0, falhas = 0
  let primeiraFalha: string | null = null
  const recusa = (e: any) => { falhas++; primeiraFalha ||= String(e?.message || e) }
  const ctx = {
    clientId: item.client_id, instituicao: item.institution_name || null,
    contaDe: (plaidAccountId: string) => accountMap[plaidAccountId] || null,
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
        const lote = await db.from('bank_transactions')
          .upsert(novas, { onConflict: 'plaid_tx_id', ignoreDuplicates: true }).select('id')
        if (!lote.error) added += (lote.data || []).length
        else {
          // Uma linha ruim derruba o lote: grava uma a uma para isolar e CONTAR
          // a recusa — o cursor vai passar por ela, e ela não pode sumir calada.
          for (const linha of novas) {
            const um = await db.from('bank_transactions')
              .upsert(linha, { onConflict: 'plaid_tx_id', ignoreDuplicates: true }).select('id')
            if (um.error) recusa(um.error)
            else added += (um.data || []).length
          }
        }
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
  const ruled = added > 0 ? await applyRulesToClient(db, item.client_id).catch(() => 0) : 0

  return { added, modified, removed, ruled, completo: rodada.completo, falhas, primeiraFalha }
}
