// lib/planos-parados.ts — planos que pararam esperando o cliente.
//
// Um plano fica em `awaiting_entry` ou `awaiting_setup` até o cliente pagar a
// entrada ou cadastrar o débito automático. Se ele nunca faz, o plano fica ali
// para sempre: a fatura não é cobrada, o contrato não anda e ninguém percebe —
// não existe tela que liste "parados", e o painel conta esses planos junto com
// os que acabaram de ser criados.
//
// Aqui só se CONTA e se ALERTA. Nada é cancelado sozinho: um parcelamento não
// se cancela em andamento (regra do sócio), e quem decide desistir é a firma.

export const DIAS_PARADO = 7

/** Dias inteiros entre a data (ISO) e hoje, por data civil. */
export function diasParados(desde: string | null | undefined, hoje = new Date()): number {
  if (!desde) return 0
  const d = new Date(String(desde).slice(0, 10) + 'T12:00:00Z')
  if (Number.isNaN(d.getTime())) return 0
  const h = new Date(hoje.toISOString().slice(0, 10) + 'T12:00:00Z')
  return Math.max(0, Math.round((h.getTime() - d.getTime()) / 86400000))
}

/** O texto do alerta, que diz o que falta e o que a equipe pode fazer. */
export function avisoDePlanoParado(plano: any, dias: number): string {
  const quem = plano.clients?.business_name || plano.clients?.name || 'O cliente'
  const servico = plano.description
    || (plano.kind === 'installment' ? `parcelamento em ${plano.installments}×` : 'serviço mensal')
  // Entrada PAGA e plano parado não é cliente enrolando: é o agendamento das
  // parcelas que travou. Dizer "nada foi cobrado" aqui era falso — e fazia a
  // equipe ligar cobrando quem já tinha pago.
  if (plano.kind === 'installment' && plano.entry_paid_at) {
    return `🛑 ${quem} PAGOU a entrada de ${servico} e as parcelas não foram agendadas no Stripe — há ${dias} dias nada é cobrado.`
      + ' Abra Financeiro → Parcelamentos → "Conferir pagamento e agendar".'
  }
  const oque = plano.status === 'awaiting_entry' ? 'pagar a entrada' : 'cadastrar o débito automático'
  return `⏳ ${quem} não concluiu "${oque}" de ${servico} há ${dias} dias.`
    + ' Pelo que está registrado, nada foi cobrado.'
    + (plano.aguardandoContrato ? ' Ele ainda nem assinou o contrato.' : '')
    + (plano.kind === 'installment'
      ? ' Se ele diz que já pagou, use "Conferir pagamento e agendar" em Financeiro → Parcelamentos — o sistema confere no Stripe.'
      : '')
    + ' Ligue, reenvie o aviso, ou desista do plano no Financeiro.'
}

/**
 * Planos parados há DIAS_PARADO dias ou mais, sem alerta ainda nesta rodada.
 * Um alerta por plano por dia: a chave é o dia civil, então rodar o cron duas
 * vezes no mesmo dia não enche a tela da equipe.
 */
export async function alertarPlanosParados(db: any, opts: { dry?: boolean; hoje?: Date } = {}) {
  const hoje = opts.hoje || new Date()
  const dia = hoje.toISOString().slice(0, 10)

  const { data: planos } = await db.from('payment_plans')
    .select('id, client_id, kind, status, description, installments, entry_paid_at, updated_at, created_at, clients(name, business_name)')
    .in('status', ['awaiting_entry', 'awaiting_setup'])
  if (!planos?.length) return { alvo: 0, alertados: [] as string[] }

  const alertados: string[] = []
  for (const p of planos) {
    const dias = diasParados(p.updated_at || p.created_at, hoje)
    if (dias < DIAS_PARADO) continue

    // Já alertado hoje? A trilha é a memória — não há coluna para isso.
    const { count } = await db.from('plan_audit')
      .select('id', { count: 'exact', head: true })
      .eq('plan_id', p.id).eq('action', 'stalled_alert')
      .gte('created_at', `${dia}T00:00:00Z`)
    if ((count ?? 0) > 0) continue

    alertados.push(p.id)
    if (opts.dry) continue

    await db.from('plan_alerts').insert({
      plan_id: p.id, client_id: p.client_id, type: 'plano_parado',
      message: avisoDePlanoParado(p, dias),
    }).then(() => null, () => null)
    await db.from('plan_audit').insert({
      plan_id: p.id, action: 'stalled_alert', snapshot: { dias, status: p.status },
    }).then(() => null, () => null)
  }
  return { alvo: planos.length, alertados }
}
