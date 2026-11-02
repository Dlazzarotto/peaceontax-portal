// Cobrança no balcão: as duas regras que decidem se a fatura pode ser
// cobrada, e por quanto.
//
// Puro e com teste porque são DINHEIRO e porque já erraram antes em outro
// lugar do sistema: rascunho não é cobrável (nunca chegou ao cliente) e o
// valor é o SALDO, não o total — cobrar o total de uma fatura com entrada
// paga cobra duas vezes a entrada.

/** Status em que a fatura já saiu para o cliente e ainda tem o que receber. */
export const PAGAVEL = ['sent', 'partial', 'overdue'] as const

export interface FaturaParaCobrar {
  total: number | string | null
  paid_total?: number | string | null
}

/** Quanto falta receber. Nunca o total. */
export function saldoDaFatura(inv: FaturaParaCobrar): number {
  const total = Number(inv?.total || 0)
  const pago = Number(inv?.paid_total || 0)
  return Math.round((total - pago) * 100) / 100
}

/**
 * A fatura já saiu para o cliente e ainda tem o que receber?
 *
 * RASCUNHO NÃO É COBRÁVEL, e não é detalhe: rascunho nunca chegou ao
 * cliente (de propósito — não aparece no portal, não sai e-mail). Cobrar um
 * rascunho no balcão receberia dinheiro de um documento que o cliente nunca
 * viu, e a fatura seguiria rascunho depois de paga.
 */
export function ehPagavel(status: string | null | undefined): boolean {
  return (PAGAVEL as readonly string[]).includes(String(status || ''))
}

/** Piso do Stripe para uma cobrança em dólar: abaixo disso a sessão nem nasce. */
export const MINIMO_STRIPE = 0.5

export type DecisaoDeValor =
  | { ok: true; valor: number; parcial: boolean }
  | { ok: false; motivo: string }

/**
 * Quanto o Stripe vai cobrar, a partir do que a equipe digitou no Receber.
 *
 * O botão "Cobrar no cartão" MOSTRAVA o valor digitado e a rota cobrava o
 * saldo inteiro — o valor não viajava, e o cliente que ia pagar uma parte
 * via o total na página do Stripe. Agora a tela e a rota passam por esta
 * função: vazio é o saldo; o resto tem de ser um número, em centavos, acima
 * do piso do Stripe e dentro do saldo — e a recusa diz o saldo.
 *
 * Parcial só em cartão e ACH. Klarna financia a fatura inteira e a marca
 * como financiada, então é sempre o saldo. Fatura PARCELADA cobrada em parte
 * deixaria o débito automático correndo em dobro: nela só a quitação, ou a
 * parcela por fora (rota de recebimentos).
 */
export function decidirValorDaCobranca(p: {
  saldo: number | string | null | undefined
  pedido: unknown
  forma: string
  parcelado: boolean
}): DecisaoDeValor {
  const saldo = Math.round(Number(p.saldo || 0) * 100) / 100
  if (saldo <= 0) return { ok: false, motivo: 'Esta fatura já está quitada.' }
  const vazio = p.pedido == null || String(p.pedido).trim() === ''
  const bruto = vazio ? saldo : Number(p.pedido)
  if (!Number.isFinite(bruto) || bruto <= 0) return { ok: false, motivo: 'Valor inválido.' }
  const valor = Math.round(bruto * 100) / 100
  if (valor > saldo) {
    return { ok: false, motivo: `O valor ($${valor.toFixed(2)}) passa do saldo da fatura ($${saldo.toFixed(2)}).` }
  }
  if (valor < MINIMO_STRIPE) return { ok: false, motivo: `O Stripe não cobra menos de $${MINIMO_STRIPE.toFixed(2)}.` }
  const parcial = valor < saldo
  if (parcial && p.forma === 'klarna') {
    return { ok: false, motivo: 'Klarna só pelo saldo inteiro: ela financia a fatura toda e a marca como financiada.' }
  }
  if (parcial && p.parcelado) {
    return { ok: false, motivo: 'Fatura parcelada: cobrar parte aqui deixaria o débito automático correndo em dobro. Cobre o saldo inteiro (quitação) ou receba a parcela por fora.' }
  }
  return { ok: true, valor, parcial }
}
