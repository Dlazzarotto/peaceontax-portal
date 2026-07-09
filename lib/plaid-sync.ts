// lib/plaid-sync.ts — sincroniza transações de um plaid_item para bank_transactions
// Convenção de sinal: Plaid usa positivo = saída; nosso padrão é negativo = saída → inverte.

import { plaidPost } from '@/lib/plaid'

export async function syncPlaidItem(db: any, plaidItemRowId: string) {
  const { data: item } = await db.from('plaid_items').select('*').eq('id', plaidItemRowId).single()
  if (!item) throw new Error('Conexão não encontrada')
  if (item.status === 'disconnected') throw new Error('Conexão desativada')

  // Contas do item → upsert em bank_accounts
  const accountsRes = await plaidPost('/accounts/get', { access_token: item.access_token })
  const accountMap: Record<string, string> = {}   // plaid account_id → bank_accounts.id
  for (const acc of accountsRes.accounts || []) {
    const name = `${item.institution_name || 'Bank'} ${acc.name}${acc.mask ? ` ...${acc.mask}` : ''}`.slice(0, 120)
    const isCC = acc.type === 'credit'
    const { data: row } = await db.from('bank_accounts')
      .upsert(
        { client_id: item.client_id, name, account_hint: name, type: isCC ? 'credit_card' : (acc.subtype === 'savings' ? 'savings' : 'checking') },
        { onConflict: 'client_id,name' }
      ).select('id').single()
    if (row) accountMap[acc.account_id] = row.id
  }

  // transactions/sync com cursor (pagina até acabar)
  let cursor = item.sync_cursor || undefined
  let added = 0, modified = 0, removed = 0
  let hasMore = true
  let guard = 0

  while (hasMore && guard < 20) {
    guard++
    const res = await plaidPost('/transactions/sync', {
      access_token: item.access_token,
      ...(cursor ? { cursor } : {}),
      count: 250,
    })

    for (const tx of res.added || []) {
      if (tx.pending) continue
      const { error } = await db.from('bank_transactions').upsert({
        client_id: item.client_id,
        source: 'plaid',
        plaid_tx_id: tx.transaction_id,
        account_id: accountMap[tx.account_id] || null,
        account_hint: item.institution_name || null,
        tx_date: tx.date,
        description: (tx.merchant_name || tx.name || 'Transaction').slice(0, 500),
        amount: -Math.round(tx.amount * 100) / 100,   // inverte o sinal do Plaid
        payee: tx.merchant_name ? tx.merchant_name.slice(0, 120) : null,
        status: 'pending',
      }, { onConflict: 'plaid_tx_id', ignoreDuplicates: true })
      if (!error) added++
    }

    for (const tx of res.modified || []) {
      if (tx.pending) continue
      await db.from('bank_transactions').update({
        tx_date: tx.date,
        description: (tx.merchant_name || tx.name || 'Transaction').slice(0, 500),
        amount: -Math.round(tx.amount * 100) / 100,
        updated_at: new Date().toISOString(),
      }).eq('plaid_tx_id', tx.transaction_id).neq('status', 'reviewed').neq('status', 'approved')
      modified++
    }

    for (const tx of res.removed || []) {
      await db.from('bank_transactions').delete()
        .eq('plaid_tx_id', tx.transaction_id)
        .in('status', ['pending', 'auto'])   // preserva registro aprovado
      removed++
    }

    cursor = res.next_cursor
    hasMore = res.has_more
  }

  await db.from('plaid_items').update({
    sync_cursor: cursor,
    last_synced_at: new Date().toISOString(),
    status: 'active',
  }).eq('id', plaidItemRowId)

  return { added, modified, removed }
}
