// lib/cronograma-parcelas.ts — o cronograma do parcelamento, e o PISO da parcela.
//
// POR QUE ISTO SAIU DA ROTA
// A conta estava dentro de `app/api/billing/installment-plan/route.ts`, então
// não tinha teste: é dinheiro com arredondamento, exatamente o que a regra do
// projeto manda testar. Aqui é puro e tem teste.
//
// O PISO É A CORREÇÃO DE VERDADE
// O parcelamento aceitava de 2 a 36 parcelas sem olhar QUANTO dá cada uma.
// $15 em 36× = $0,41 por parcela — e o Stripe **recusa** cobrança abaixo de
// US$ 0,50. O plano nasceria, o cliente cadastraria o débito e TODA cobrança
// falharia, para sempre, sem ninguém entender. Pior: com saldo pequeno e
// muitas parcelas, `floor` chega a produzir parcela de **$0,00**.
// Agora a recusa vem antes e diz o número máximo de parcelas para aquele
// saldo — a pessoa no balcão precisa do número, não da regra abstrata.

import { avancarData, type Frequency } from './plans.ts'

/** Piso de uma cobrança em dólar no Stripe. Abaixo disto, a cobrança é recusada. */
export const MINIMO_POR_PARCELA = 0.5

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

export interface LinhaDoCronograma {
  seq: number
  due_date: string
  amount: number
}

/** Em quantas parcelas este saldo ainda cabe sem cair abaixo do piso. */
export function maximoDeParcelas(restante: number): number {
  const r = round2(restante)
  if (r <= 0) return 0
  return Math.max(0, Math.floor(r / MINIMO_POR_PARCELA))
}

/**
 * O cronograma, ou o motivo de não dar.
 *
 * A sobra dos centavos vai para a ÚLTIMA parcela (as outras usam `floor`),
 * então a soma bate exatamente com o saldo — nunca sobra nem falta centavo.
 */
export function montarCronograma(
  restante: number,
  n: number,
  primeira: string,
  freq: Frequency,
): { erro: string } | LinhaDoCronograma[] {
  const r = round2(restante)
  if (r <= 0) return { erro: 'Não há saldo a parcelar.' }
  if (!Number.isInteger(n) || n < 2) return { erro: 'O parcelamento vai de 2 a 36 parcelas.' }

  const base = Math.floor((r / n) * 100) / 100
  const ultima = round2(r - base * (n - 1))

  // O piso vale para a MENOR parcela. Com `floor`, a menor é a base — exceto
  // quando n = 2 e a sobra deixa a última maior; a última nunca é a menor.
  if (base < MINIMO_POR_PARCELA) {
    const max = maximoDeParcelas(r)
    return {
      erro: max >= 2
        ? `Parcela de $${base.toFixed(2)} é baixa demais: o cartão recusa abaixo de ` +
          `$${MINIMO_POR_PARCELA.toFixed(2)}. Com saldo de $${r.toFixed(2)}, o máximo é ${max} parcelas.`
        : `Saldo de $${r.toFixed(2)} não dá para parcelar: cada parcela ficaria abaixo de ` +
          `$${MINIMO_POR_PARCELA.toFixed(2)}, que o cartão recusa.`,
    }
  }

  const inicio = new Date(`${primeira}T12:00:00Z`)
  if (Number.isNaN(inicio.getTime())) return { erro: 'Data da primeira parcela inválida.' }

  const linhas: LinhaDoCronograma[] = []
  for (let i = 0; i < n; i++) {
    linhas.push({
      seq: i + 1,
      due_date: avancarData(inicio, freq, i).toISOString().slice(0, 10),
      amount: i === n - 1 ? ultima : base,
    })
  }
  return linhas
}

/** A soma do cronograma, para conferir que fecha com o saldo. */
export function somaDoCronograma(linhas: LinhaDoCronograma[]): number {
  return round2(linhas.reduce((s, l) => s + l.amount, 0))
}
