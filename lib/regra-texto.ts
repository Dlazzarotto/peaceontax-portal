// lib/regra-texto.ts — o texto de uma regra precisa apontar um comerciante.
//
// O extrato começa com o jargão do banco: "PURCHASE AUTHORIZED ON 09/12",
// "CHECKCARD 0912", "ACH DEBIT", "POS PURCHASE". Uma regra feita desse jargão
// casa com TODO lançamento do mesmo tipo — foi assim que "Payroll Fees"
// engoliu BJ's Wholesale e Facebook: a regra dizia "purchase authorized on".
//
// Aqui ficam (1) a sugestão de texto a partir da descrição, já sem o jargão,
// e (2) a conferência que recusa um texto feito só de jargão. Módulo puro:
// serve a tela, a rota e o teste. O MOTOR de casamento não muda — ele continua
// idêntico nos três lugares (CLAUDE.md).

// Palavras que o banco imprime e que não identificam ninguém
export const JARGAO = new Set([
  // tipo de movimento
  'purchase', 'purchases', 'authorized', 'authorization', 'auth', 'on', 'at', 'in', 'to', 'from',
  'card', 'cards', 'checkcard', 'check', 'chk', 'debit', 'credit', 'pos', 'ach', 'eft', 'dda',
  'electronic', 'withdrawal', 'withdrawl', 'deposit', 'payment', 'payments', 'pmt', 'pymt', 'pay',
  'recurring', 'online', 'mobile', 'transaction', 'transactions', 'transfer', 'transfers',
  'des', 'ppd', 'ccd', 'web', 'tel', 'arc', 'pos', 'sig', 'pin', 'chip', 'tap', 'contactless',
  'visa', 'mastercard', 'mc', 'amex', 'discover', 'dbt', 'crd', 'pur', 'purch', 'sale', 'sales',
  'merchant', 'store', 'terminal', 'trace', 'seq', 'ref', 'conf', 'confirmation', 'id', 'trn',
  'orig', 'bnf', 'bk', 'co', 'entry', 'memo', 'descr', 'indn', 'name', 'date', 'time', 'amount',
  // banco e localidade
  'bank', 'america', 'bofa', 'chase', 'wells', 'fargo', 'citizens', 'td', 'santander', 'usa', 'us',
  'ma', 'nh', 'ny', 'ct', 'ri', 'fl', 'boston', 'malden', 'everett', 'somerville', 'cambridge',
  // conectivos e sufixos de empresa que sozinhos não dizem nada
  'the', 'of', 'and', 'or', 'for', 'with', 'by', 'inc', 'llc', 'corp', 'ltd', 'com', 'www', 'http', 'https',
])

// Quebra a descrição em palavras úteis, na ordem, sem datas, números e jargão
export function palavrasUteis(desc: string): string[] {
  return String(desc || '')
    .toLowerCase()
    .replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/g, ' ')          // datas
    .replace(/[x*#•.]{2,}\s*\d*/g, ' ')                     // xxxx1234, ****, ...
    .replace(/\b[\w-]*\d[\w-]*\b/g, ' ')                    // qualquer token com dígito: 0912, abc12, s385
    .replace(/[^a-z&'\s-]/g, ' ')                            // pontuação (mantém & e ')
    .split(/\s+/)
    .map(w => w.replace(/^[-']+|[-']+$/g, ''))
    .filter(w => w.length >= 3 && !JARGAO.has(w))
}

/** Sugestão de texto para a regra: até 3 palavras úteis, na ordem do extrato. */
export function sugerirTexto(desc: string): string {
  // "DES:GUSTO ... GUSTO" repete o nome — cada palavra entra uma vez
  return Array.from(new Set(palavrasUteis(desc))).slice(0, 3).join(' ')
}

/**
 * Verdadeiro quando o texto (uma ou mais variações separadas por |) não
 * identifica ninguém: só jargão, números ou pedaços curtos demais.
 * Uma regra assim casa com quase tudo e não pode ser salva.
 */
export function textoGenerico(pattern: string | null | undefined): boolean {
  const variantes = String(pattern || '').split('|').map(v => v.trim()).filter(Boolean)
  if (variantes.length === 0) return false      // sem texto: a regra é só por valor, isso é outro caso
  return variantes.every(v => palavrasUteis(v).length === 0)
}

export const MOTIVO_GENERICO =
  'O texto da regra é só jargão do banco ("purchase authorized on", "checkcard", "ach debit") e casaria com quase todo lançamento. Use o nome do comerciante — por exemplo "bjs wholesale" ou "facebk".'
