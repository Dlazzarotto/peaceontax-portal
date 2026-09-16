// lib/estorno-stripe.ts — dinheiro que VOLTA ao cliente por fora da equipe.
//
// Três situações em que o Stripe tira o dinheiro do caixa da firma sem que
// ninguém aqui tenha pedido:
//   - reembolso feito no painel do Stripe (o próprio sistema manda fazer lá)
//   - disputa (chargeback de cartão, ou ACH marcado como não autorizado) perdida
//   - débito ACH devolvido DEPOIS de ter sido dado como recebido
//
// Em todas, a receita ficava registrada aqui enquanto já tinha saído de lá.
// O tratamento é o mesmo do estorno manual — payment_reversals antes de
// remover o recebimento, como manda a especificação ("nada se apaga sem
// rastro") — mas a autoria é do Stripe, não de uma pessoa.

/** Recebimento lançado a partir deste objeto do Stripe (sessão, intent ou invoice). */
export async function recebimentoDoObjeto(db: any, ...objetos: (string | null | undefined)[]) {
  for (const o of objetos.filter(Boolean)) {
    // Sem maybeSingle: dois recebimentos do mesmo objeto (pagamento dividido)
    // fariam o PostgREST devolver erro e o estorno passaria batido.
    const { data } = await db.from('invoice_payments')
      .select('id, invoice_id, client_id, amount, method, reference, stripe_object')
      .or(`stripe_object.eq.${o},reference.eq.${o}`)
      .order('received_at', { ascending: false }).limit(2)
    if (data?.length) {
      if (data.length > 1) console.error('estorno: mais de um recebimento para', o, '— desfazendo o mais recente')
      return data[0]
    }
  }
  return null
}

/**
 * Desfaz um recebimento porque o dinheiro voltou ao cliente. Grava o rastro,
 * remove o lançamento (o gatilho do banco reabre a fatura), registra na
 * trilha e alerta a equipe. Idempotente: se o recebimento já saiu, não faz
 * nada — o Stripe reenvia eventos.
 *
 * Se o rastro não puder ser gravado, o recebimento NÃO é apagado: a regra da
 * firma é que nada se apaga sem rastro, e aqui não há humano conferindo.
 */
export async function desfazerRecebimento(
  db: any, pagamento: any,
  opts: { motivo: string; origem: 'refund' | 'dispute' | 'ach_returned'; detalhe?: any },
): Promise<boolean> {
  if (!pagamento?.id) return false

  const rastro = {
    invoice_id: pagamento.invoice_id, amount: pagamento.amount, method: pagamento.method,
    reference: pagamento.reference, stripe_object: pagamento.stripe_object,
    reason: opts.motivo,
  }
  // 'stripe' não é nível de equipe; se a coluna recusar o valor, grava sem ele
  // — o rastro é o que não pode faltar.
  let { error: errRastro } = await db.from('payment_reversals')
    .insert({ ...rastro, performed_by: null, staff_level: 'stripe' })
  if (errRastro) {
    console.error('estorno: payment_reversals recusou staff_level=stripe:', errRastro.message)
    ;({ error: errRastro } = await db.from('payment_reversals').insert(rastro))
  }
  if (errRastro) {
    console.error('estorno: sem rastro, recebimento preservado:', errRastro.message)
    return false
  }

  const { error } = await db.from('invoice_payments').delete().eq('id', pagamento.id)
  if (error) { console.error('desfazerRecebimento:', error.message); return false }

  await db.from('invoice_audit').insert({
    invoice_id: pagamento.invoice_id, action: `stripe_${opts.origem}`,
    reason: opts.motivo.slice(0, 400), next: { valor: Number(pagamento.amount), ...(opts.detalhe || {}) },
  }).then(() => null, () => null)

  // A fatura pode ter ficado quitada; sem saldo o gatilho não reabre sozinho
  // em todo banco. Confere e corrige.
  const { data: inv } = await db.from('invoices')
    .select('id, number, total, paid_total, status').eq('id', pagamento.invoice_id).maybeSingle()
  if (inv && Number(inv.paid_total || 0) < Number(inv.total) && inv.status === 'paid') {
    await db.from('invoices').update({
      status: Number(inv.paid_total || 0) > 0 ? 'partial' : 'sent',
      updated_at: new Date().toISOString(),
    }).eq('id', inv.id)
  }
  return true
}

/** Texto do alerta à equipe, por origem. */
export function avisoDeEstorno(origem: 'refund' | 'dispute' | 'ach_returned', numero: string, valor: number, motivo: string) {
  const v = `$${Number(valor).toFixed(2)}`
  if (origem === 'dispute') {
    return `🛑 Contestação PERDIDA na fatura ${numero}: ${v} voltaram ao cliente e saíram do caixa. O recebimento foi desfeito e a fatura reabriu. Motivo do banco: ${motivo}.`
  }
  if (origem === 'ach_returned') {
    return `⚠️ O débito em conta da fatura ${numero} (${v}) foi DEVOLVIDO pelo banco depois de ter sido dado como recebido. O recebimento foi desfeito e a fatura reabriu. Motivo: ${motivo}.`
  }
  return `↩️ Reembolso de ${v} na fatura ${numero} feito no painel do Stripe. O recebimento foi desfeito aqui e a fatura reabriu.`
}
