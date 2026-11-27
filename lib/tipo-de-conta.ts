// lib/tipo-de-conta.ts — o que é cartão de crédito, num lugar só.
//
// A importação do QuickBooks gravava 'credit' (o resto do sistema grava
// 'credit_card'): sem aceitar os dois, o cartão importado de lá entraria no
// Balanço como DINHEIRO em banco, com a dívida somando no ativo. O Balanço
// (lib/balanco.ts) e a conciliação (lib/conciliacao-bancaria.ts) perguntam
// aqui — duas definições de "cartão" acabariam discordando.

export function ehCartao(tipo: unknown): boolean {
  const t = String(tipo ?? '').trim().toLowerCase()
  return t === 'credit_card' || t === 'credit'
}
