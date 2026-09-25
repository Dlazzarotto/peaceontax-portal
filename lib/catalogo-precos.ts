// lib/catalogo-precos.ts — quando um item do catálogo (pricing_items) conta
// como ATIVO, num lugar só.
//
// POR QUE ISTO EXISTE
// O catálogo era lido de três jeitos diferentes:
//
//   /api/pricing            (tela Preços, orçamentos)  — TODOS os itens
//   /api/billing/invoices   (a fatura)                 — só `active = true`
//   /api/plans              (contrato mensal)          — só `active = true`
//
// E o POST de /api/pricing criava o item SEM gravar `active`. Quando a coluna
// não tem `default true`, o item nasce com `active` NULO: aparece na tela de
// Preços (que não filtra) e NÃO aparece na fatura (que exige `= true`). Para
// quem cadastrou, "a lista de serviços da fatura não atualiza" — o item está
// lá, só que invisível justamente onde ele seria usado.
//
// Duas coisas consertam isso e as duas estão feitas: o POST grava
// `active: true`, e quem lê trata NULO como ativo. Nulo aqui quer dizer
// "ninguém desativou", não "está desativado" — desativar é um ato, e ele
// grava `false`. A migração `sql/pricing-items-ativo-v1.sql` acerta as
// linhas que já nasceram nulas e põe o `default` na coluna.

/** Filtro PostgREST: ativo é `true` ou ainda não decidido (nulo). */
export const FILTRO_ATIVO = 'active.is.null,active.eq.true'

/** A mesma regra em memória: só `false` desativa. */
export function ehItemAtivo(active: unknown): boolean {
  return active !== false
}
