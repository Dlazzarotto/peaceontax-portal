// lib/format.ts — formatos voltados ao cliente, num lugar só.
//
// O projeto usa o padrão dos EUA em tudo que o cliente lê (CLAUDE.md):
// data MM/DD/YYYY e moeda em dólar. Antes cada tela tinha a sua cópia, com
// tratamentos diferentes de nulo e de fuso; aqui a regra é uma.
// Módulo puro, sem servidor: serve tela do cliente, rota e relatório.

/**
 * 'YYYY-MM-DD' ou timestamp ISO → 'MM/DD/YYYY'.
 * Lê os dígitos direto da cadeia, sem passar por Date: o fuso do navegador
 * não muda o dia (um pagamento de 30/09 não vira 01/10 para quem abre em
 * outro fuso). Vazio quando não há data.
 */
export function fmtUS(iso: string | null | undefined): string {
  if (!iso) return ''
  const s = String(iso).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return String(iso)
  return `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`
}

/** Valor em dólar; negativo com sinal de menos, nunca entre parênteses. */
export function money(n: unknown): string {
  const v = Number(n) || 0
  const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${v < 0 ? '-' : ''}$${abs}`
}
