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
