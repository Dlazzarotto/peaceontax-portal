// lib/entrada-parcelamento.ts — a entrada de um parcelamento, em dólar
//
// A tela pedia ENTRADA %, de 0 a 90. Para uma entrada de $250 numa fatura de
// $1.000 era preciso digitar 25; digitando 250 a rota recusava com "a entrada
// vai de 0% a 90%", e ninguém liga uma coisa à outra. Pior: entrada quebrada
// (os $237 que o cliente tinha no bolso) é 23,7% — porcentagem é como o banco
// pensa, dólar é como o cliente paga.
//
// Agora a equipe digita o valor. A porcentagem continua existindo porque o
// banco guarda as duas colunas (`entry_pct`, `entry_amount`) e os documentos
// impressos mostram a porcentagem — ela passa a ser DERIVADA, não digitada.
//
// Este módulo é a única definição da conta: a rota e a prévia da tela chamam
// a mesma função, senão as duas mostram números diferentes para o mesmo
// acordo — que é exatamente o que a convenção do projeto proíbe.

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

/**
 * Teto da entrada, em porcentagem do saldo.
 *
 * Existe para o parcelamento ter o que parcelar: entrada de 100% é
 * pagamento à vista, e não se registra como acordo de parcelas. Em 90%
 * ainda sobra saldo para 2 parcelas de valor de verdade.
 */
export const LIMITE_PCT = 90

export interface Entrada {
  entrada: number     // em dólar
  pct: number         // derivada, arredondada em 2 casas
  restante: number    // o que vai para as parcelas
}

export interface PedidoDeEntrada {
  saldo: number
  /** Valor em dólar, como a equipe digita. Tem precedência. */
  entryAmount?: unknown
  /** Porcentagem — só para quem ainda chama a rota pelo formato antigo. */
  entryPct?: unknown
}

/** Maior entrada aceita para este saldo, em dólar. */
export function tetoDaEntrada(saldo: number): number {
  return round2(round2(saldo) * (LIMITE_PCT / 100))
}

/**
 * Resolve a entrada. Devolve `erro` com a frase para a equipe, ou o
 * conjunto pronto. Nunca lança: a rota responde 400 com o texto.
 */
export function entradaDoPedido(p: PedidoDeEntrada): { erro: string } | Entrada {
  const saldo = round2(p.saldo)
  if (!(saldo > 0)) return { erro: 'Esta fatura não tem saldo em aberto.' }

  const temValor = p.entryAmount !== undefined && p.entryAmount !== null && p.entryAmount !== ''
  const bruto = temValor ? Number(p.entryAmount) : (Number(p.entryPct) || 0) * saldo / 100

  if (!Number.isFinite(bruto)) return { erro: 'Valor de entrada inválido.' }
  if (bruto < 0) return { erro: 'A entrada não pode ser negativa.' }

  const entrada = round2(bruto)
  const teto = tetoDaEntrada(saldo)

  // A mensagem diz o número que resolve, não a regra abstrata: quem está com
  // o cliente na frente precisa saber quanto pode aceitar, não decorar 90%.
  if (entrada > teto) {
    return {
      erro: entrada >= saldo
        ? `A entrada de $${entrada.toFixed(2)} cobre o saldo de $${saldo.toFixed(2)}. ` +
          `Isso é pagamento à vista — registre em Receber, sem parcelamento.`
        : `Entrada de no máximo $${teto.toFixed(2)} (${LIMITE_PCT}% do saldo de $${saldo.toFixed(2)}). ` +
          `Acima disso não sobra o que parcelar.`,
    }
  }

  const restante = round2(saldo - entrada)
  if (restante <= 0) return { erro: 'A entrada não pode cobrir o saldo inteiro.' }

  return { entrada, pct: round2((entrada / saldo) * 100), restante }
}
