// lib/excedente-transacoes.ts — quanto o cliente de bookkeeping passou da franquia
//
// O DEFEITO QUE ORIGINOU ESTE MÓDULO
// `payment_plans.included_transactions` é POR MÊS: o formulário pede
// "Transações incluídas/mês" (components/PlansTab.tsx) e o contrato assinado
// promete "up to N transactions per month" (lib/contract-html.ts). A rota de
// excedente e a central de bookkeeping comparavam esse número com a contagem
// do ANO INTEIRO. Um cliente com franquia de 100/mês e 590 lançamentos no ano
// aparecia com 490 acima e $612,50 "a cobrar" — e o botão "Cobrar excedente"
// lançava esse valor na próxima fatura do Stripe, de verdade.
//
// A REGRA (decidida em setembro, commit af814e1, que nunca chegou à main):
//   · a franquia do período é o número mensal × os MESES DE VIGÊNCIA no ano,
//     contados da PRIMEIRA COBRANÇA (`ancoraDeCobranca`, a mesma regra do
//     checkout) — contrato criado em 20/08 com débito no dia 5 começa em
//     05/09 e vale por set·out·nov·dez, não por cinco meses;
//   · a apuração é ANUAL: mês de pouco movimento compensa mês de muito;
//   · a contagem também se limita à vigência — lançamento importado de antes
//     do contrato não pode virar excedente;
//   · contrato que não vigorava no ano não gera excedente.
//
// E UMA REGRA NOVA, que a versão de setembro não tinha: no ANO CORRENTE a
// franquia vai só ATÉ O MÊS CORRENTE. Comparar dez meses de movimento com a
// franquia de doze escondia o excedente que já existe; o contrário (doze
// contra dez) o inventaria. O número do ano corrente é PARCIAL, e a tela
// precisa dizer isso (`parcial`).
//
// Este módulo só CONTA. Cobrar o excedente é faturamento: passa pela alçada
// de quem emite e de quem dá baixa, e não sai daqui.

import { ancoraDeCobranca } from './plans.ts'

export interface PlanoDeBookkeeping {
  created_at?: string | null
  due_day?: number | string | null
  included_transactions?: number | string | null
  overage_rate?: number | string | null
}

export interface Vigencia {
  /** Meses de franquia no período apurado (0 = contrato não vigorava). */
  meses: number
  /** Primeiro dia que entra na contagem (YYYY-MM-DD), ou null = ano inteiro. */
  desde: string | null
  /** O ano ainda não acabou: o número é parcial. */
  parcial: boolean
}

/** Taxa por transação quando o plano não tem uma gravada (a do contrato padrão). */
export const TAXA_PADRAO = 1.25

/**
 * Meses de franquia do contrato DENTRO do ano, contados da primeira cobrança
 * e — no ano corrente — só até o mês de `hoje` (YYYY-MM-DD, dia do escritório).
 */
export function vigenciaNoAno(plano: PlanoDeBookkeeping, ano: number, hoje: string): Vigencia {
  const anoDeHoje = Number(hoje.slice(0, 4))
  const mesDeHoje = Number(hoje.slice(5, 7)) - 1           // 0..11
  if (!Number.isInteger(ano) || ano > anoDeHoje) return { meses: 0, desde: null, parcial: false }
  const parcial = ano === anoDeHoje
  const ultimoMes = parcial ? mesDeHoje : 11

  const criado = plano.created_at ? new Date(plano.created_at) : null
  // Sem data de criação não dá para saber quando começou: vale o ano inteiro
  // (o que é o caso mais FAVORÁVEL ao cliente — franquia maior).
  if (!criado || Number.isNaN(criado.getTime())) {
    return { meses: ultimoMes + 1, desde: null, parcial }
  }

  const primeira = ancoraDeCobranca(plano.due_day ?? 5, criado)
  const anoDaPrimeira = primeira.getUTCFullYear()
  if (anoDaPrimeira > ano) return { meses: 0, desde: null, parcial }
  if (anoDaPrimeira < ano) return { meses: ultimoMes + 1, desde: null, parcial }

  const mesDaPrimeira = primeira.getUTCMonth()
  if (mesDaPrimeira > ultimoMes) return { meses: 0, desde: null, parcial }
  return {
    meses: ultimoMes - mesDaPrimeira + 1,
    desde: primeira.toISOString().slice(0, 10),
    parcial,
  }
}

export interface Apuracao {
  incluidasPorMes: number | null
  meses: number
  franquia: number | null
  total: number
  excedente: number
  taxa: number | null
  valor: number
  parcial: boolean
}

/**
 * O excedente, em quantidade e em dólar. `total` é a contagem JÁ recortada
 * pela vigência (`desde`). Sem franquia no contrato não há excedente — não é
 * "franquia zero", é contrato que não limita.
 */
export function apurarExcedente(
  plano: PlanoDeBookkeeping | null,
  total: number,
  vig: Vigencia,
): Apuracao {
  const porMes = Math.trunc(Number(plano?.included_transactions))
  const base = { meses: vig.meses, total, parcial: vig.parcial }
  if (!plano || !Number.isFinite(porMes) || porMes <= 0) {
    return { ...base, incluidasPorMes: null, franquia: null, excedente: 0, taxa: null, valor: 0 }
  }
  const taxaGravada = Number(plano.overage_rate)
  const taxa = Number.isFinite(taxaGravada) && taxaGravada > 0 ? taxaGravada : TAXA_PADRAO
  const franquia = porMes * vig.meses
  // Contrato que não vigorava no período: nada a apurar, ainda que haja
  // lançamentos (histórico importado).
  const excedente = vig.meses > 0 ? Math.max(0, total - franquia) : 0
  return {
    ...base,
    incluidasPorMes: porMes,
    franquia,
    excedente,
    taxa,
    // Arredonda em dois passos: 3 × 1,255 dá 3,7649999… em ponto flutuante e
    // viraria $3,76. Primeiro fixa na casa do milionésimo, depois no centavo.
    valor: Math.round(Math.round(excedente * taxa * 1e6) / 1e4) / 100,
  }
}
