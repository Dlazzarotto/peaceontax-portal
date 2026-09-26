// O REPASSE do Stripe (payout) — o que exatamente veio dentro daquele
// depósito no banco.
//
// O PROBLEMA QUE ISTO RESOLVE
// Na mesma conta caem o depósito de cheque (um a um, valor redondo) e o
// repasse do Stripe, que junta N cobranças e chega LÍQUIDO da taxa. Olhando
// o extrato, "TRANSFER 970.00" não diz de quem é. Escolher à mão quais
// recebimentos formam esse valor é adivinhação — e adivinhar errado lança a
// receita no cliente errado.
//
// O Stripe sabe: cada repasse tem a lista de lançamentos do saldo
// (balance transactions) que o compõem, com a cobrança de origem, o bruto e
// a taxa de cada um. É essa lista que vira a sugestão de conciliação.
//
// REEMBOLSO DENTRO DO REPASSE é tratado à parte, de propósito: ele também
// faz o depósito ficar menor que o bruto, e sem separá-lo a devolução ao
// cliente entraria no livro como "taxa de processamento" — despesa que não
// existiu, e uma receita que continua lançada.

import Stripe from 'stripe'

export const STRIPE_API_VERSION = '2026-06-24.dahlia' as Stripe.LatestApiVersion

const cents = (n: number | null | undefined) => Math.round(Number(n || 0)) / 100

export interface Repasse {
  id: string
  valor: number          // o que cai no banco
  chegadaEm: string      // YYYY-MM-DD (arrival_date)
  status: string
  descricao: string | null
}

export interface DetalheDoRepasse {
  bruto: number              // soma das cobranças, sem descontar nada
  taxa: number               // soma das taxas do Stripe
  reembolsos: number         // devoluções a cliente dentro deste repasse
  outros: number             // ajustes, disputas, o que não é cobrança nem reembolso
  liquido: number            // o que o Stripe diz que caiu
  chaves: string[]           // ch_… e pi_… de cada cobrança, para casar com os recebimentos
  itens: { tipo: string; descricao: string; bruto: number; taxa: number; chaves: string[] }[]
}

export function stripeDaFirma(): Stripe {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: STRIPE_API_VERSION })
}

/** Os repasses recentes, do mais novo para o mais antigo. */
export async function repassesRecentes(stripe: Stripe, limite = 25): Promise<Repasse[]> {
  const lista = await stripe.payouts.list({ limit: Math.min(limite, 100) })
  return (lista.data || []).map((p: any) => ({
    id: p.id,
    valor: cents(p.amount),
    chegadaEm: new Date((p.arrival_date || p.created) * 1000).toISOString().slice(0, 10),
    status: p.status,
    descricao: p.description || p.statement_descriptor || null,
  }))
}

/**
 * Qual repasse é ESTE depósito do extrato. Casa por VALOR (exato, em
 * centavos) e por data próxima — o banco credita um ou dois dias depois do
 * `arrival_date`, e nunca antes.
 *
 * Valor repetido em dois repasses perto um do outro devolve null em vez de
 * chutar: conciliar o repasse errado embaralha a receita de dois dias.
 */
export function repasseDoDeposito(
  repasses: Repasse[], valor: number, dataDoBanco: string, janelaDias = 4
): { repasse: Repasse | null; motivo: string | null } {
  const alvo = Math.round(Number(valor) * 100)
  const dia = (s: string) => Date.parse(`${s}T12:00:00Z`)
  const candidatos = (repasses || []).filter(r => {
    if (Math.round(r.valor * 100) !== alvo) return false
    const dif = (dia(dataDoBanco) - dia(r.chegadaEm)) / 86400000
    return dif >= -1 && dif <= janelaDias
  })
  if (candidatos.length === 0) return { repasse: null, motivo: null }
  if (candidatos.length > 1) {
    return { repasse: null, motivo: 'Há mais de um repasse do Stripe com este valor e esta data — escolha qual é.' }
  }
  return { repasse: candidatos[0], motivo: null }
}

/** O que veio dentro do repasse. Pagina até o fim: repasse de temporada tem centenas. */
export async function detalharRepasse(stripe: Stripe, payoutId: string): Promise<DetalheDoRepasse> {
  const det: DetalheDoRepasse = {
    bruto: 0, taxa: 0, reembolsos: 0, outros: 0, liquido: 0, chaves: [], itens: [],
  }
  let cursor: string | undefined
  for (let pagina = 0; pagina < 20; pagina++) {
    const lote: any = await stripe.balanceTransactions.list({
      payout: payoutId, limit: 100, expand: ['data.source'],
      ...(cursor ? { starting_after: cursor } : {}),
    })
    for (const bt of lote.data || []) {
      // O lançamento do próprio repasse aparece na lista com o valor negativo
      // total. Ele não é item: é a saída para o banco.
      if (bt.type === 'payout') continue
      const bruto = cents(bt.amount)
      const taxa  = cents(bt.fee)
      const src: any = bt.source
      const chaves: string[] = []
      if (src && typeof src === 'object') {
        if (src.id) chaves.push(String(src.id))
        if (src.payment_intent) chaves.push(String(src.payment_intent))
        if (src.charge) chaves.push(String(src.charge))
      } else if (typeof src === 'string') chaves.push(src)

      if (bt.type === 'charge' || bt.type === 'payment') {
        det.bruto += bruto
        det.taxa  += taxa
        det.chaves.push(...chaves)
      } else if (bt.type === 'refund' || bt.type === 'payment_refund') {
        det.reembolsos += bruto      // já vem negativo
        det.taxa += taxa
      } else {
        det.outros += bruto
        det.taxa += taxa
      }
      det.itens.push({
        tipo: bt.type, descricao: String(bt.description || bt.type), bruto, taxa, chaves,
      })
      cursor = bt.id
    }
    if (!lote.has_more) break
  }
  const r2 = (n: number) => Math.round(n * 100) / 100
  det.bruto = r2(det.bruto); det.taxa = r2(det.taxa)
  det.reembolsos = r2(det.reembolsos); det.outros = r2(det.outros)
  det.liquido = r2(det.bruto + det.reembolsos + det.outros - det.taxa)
  det.chaves = Array.from(new Set(det.chaves))
  return det
}
