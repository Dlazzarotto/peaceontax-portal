// lib/ach-transito.ts — débito em conta a caminho.
//
// O ACH leva dias. O Stripe manda `checkout.session.completed` assim que o
// cliente conclui, mas o dinheiro só chega depois — ou não chega. Entre um
// momento e outro a fatura ficava IDÊNTICA a uma fatura não paga: entrava no
// contas a receber, recebia lembrete de cobrança, e aceitava baixa manual.
// Quem registrasse o Zelle nesse meio-tempo criava recebimento EM DOBRO
// quando o ACH caísse.
//
// Nada de dinheiro entra por aqui: o recebimento continua nascendo só quando
// o banco confirma. Isto é só o estado do intervalo.

/** Depois de quantos dias um débito em trânsito deixa de ser normal e vira alerta. */
export const DIAS_ACH_PARADO = 7

/** Marca que há dinheiro a caminho nesta fatura. */
export async function marcarAchEmTransito(
  db: any, invoiceId: string, sessao: string, valor: number,
): Promise<void> {
  const { error } = await db.from('invoices').update({
    ach_desde: new Date().toISOString(), ach_sessao: sessao, ach_valor: valor,
    updated_at: new Date().toISOString(),
  }).eq('id', invoiceId)
  if (error) console.error('marcarAchEmTransito:', invoiceId, error.message)
}

/**
 * Tira a marca — o dinheiro chegou, foi devolvido, ou a sessão expirou.
 * Sempre que o assunto se encerra, venha o encerramento de onde vier.
 */
export async function limparAchEmTransito(db: any, invoiceId: string): Promise<void> {
  const { error } = await db.from('invoices').update({
    ach_desde: null, ach_sessao: null, ach_valor: null,
    updated_at: new Date().toISOString(),
  }).eq('id', invoiceId)
  if (error) console.error('limparAchEmTransito:', invoiceId, error.message)
}

/** A fatura desta sessão do Stripe que está esperando ACH. */
export async function faturaDaSessaoAch(db: any, sessao: string) {
  const { data } = await db.from('invoices')
    .select('id, number, client_id, ach_desde, ach_valor')
    .eq('ach_sessao', sessao).limit(1)
  return data?.[0] || null
}

/**
 * Débito em trânsito nesta fatura, se houver. Quem for registrar recebimento
 * manual precisa saber: é o que evita a baixa em dobro.
 */
export function achEmTransito(inv: any): { desde: string; valor: number } | null {
  if (!inv?.ach_desde) return null
  return { desde: String(inv.ach_desde), valor: Number(inv.ach_valor || 0) }
}

/** Dias inteiros desde o início do trânsito, por data civil. */
export function diasEmTransito(desde: string | null | undefined, hoje = new Date()): number {
  if (!desde) return 0
  const d = new Date(String(desde).slice(0, 10) + 'T12:00:00Z')
  if (Number.isNaN(d.getTime())) return 0
  const h = new Date(hoje.toISOString().slice(0, 10) + 'T12:00:00Z')
  return Math.max(0, Math.round((h.getTime() - d.getTime()) / 86400000))
}

/** O aviso que a equipe vê quando alguém tenta receber por fora. */
export function avisoDeBaixaComAchEmTransito(numero: string, t: { desde: string; valor: number }, dias: number): string {
  return `A fatura ${numero} tem um débito em conta de $${t.valor.toFixed(2)} a caminho há ${dias} dia(s).`
    + ' Registrar recebimento agora cria baixa EM DOBRO quando o banco confirmar.'
    + ' Confirme só se souber que esse débito não vai entrar (o cliente cancelou, o banco devolveu).'
}

/**
 * Débitos parados no caminho há tempo demais. O ACH normal leva até quatro
 * dias úteis; passou disso, ou a confirmação se perdeu, ou o cliente não
 * concluiu a verificação da conta — e ninguém ficava sabendo.
 * Um alerta por fatura por dia.
 */
export async function alertarAchParado(db: any, opts: { dry?: boolean; hoje?: Date } = {}) {
  const hoje = opts.hoje || new Date()
  const dia = hoje.toISOString().slice(0, 10)

  const { data: faturas } = await db.from('invoices')
    .select('id, number, client_id, ach_desde, ach_valor')
    .not('ach_desde', 'is', null)
  if (!faturas?.length) return { alvo: 0, alertados: [] as string[] }

  const alertados: string[] = []
  for (const f of faturas) {
    const dias = diasEmTransito(f.ach_desde, hoje)
    if (dias < DIAS_ACH_PARADO) continue

    const { count } = await db.from('invoice_audit')
      .select('id', { count: 'exact', head: true })
      .eq('invoice_id', f.id).eq('action', 'ach_parado')
      .gte('created_at', `${dia}T00:00:00Z`)
    if ((count ?? 0) > 0) continue

    alertados.push(f.id)
    if (opts.dry) continue

    await db.from('invoice_audit').insert({
      invoice_id: f.id, action: 'ach_parado',
      reason: `Débito em conta de $${Number(f.ach_valor || 0).toFixed(2)} sem confirmação há ${dias} dias.`,
      next: { dias, valor: Number(f.ach_valor || 0) },
    }).then(() => null, () => null)
    await db.from('plan_alerts').insert({
      plan_id: null, client_id: f.client_id, type: 'ach_parado',
      message: `🏦 O débito em conta da fatura ${f.number} ($${Number(f.ach_valor || 0).toFixed(2)}) está sem confirmação há ${dias} dias.`
        + ' O ACH normal leva até quatro dias úteis. Confira no painel do Stripe se o cliente concluiu a verificação da conta'
        + ' — ou cobre por outra forma.',
    }).then(() => null, () => null)
  }
  return { alvo: faturas.length, alertados }
}
