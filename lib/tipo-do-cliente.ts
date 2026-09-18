// lib/tipo-do-cliente.ts — empresa ou pessoa física, a partir do que está no cadastro
//
// POR QUE ISTO EXISTE
// A importação do QuickBooks lê `Client type`: ORGANIZATION vira empresa, o
// resto vira pessoa física. Só que na carteira real muita PESSOA está
// cadastrada no QuickBooks como organização — e desde que o tipo virou
// fronteira de acesso (assistente atende só pessoa física), esses cadastros
// desapareceram justamente de quem atende o balcão.
//
// Consertar ficha por ficha, com senha e motivo em cada uma, não é opção com
// centenas de cadastros. Este módulo propõe o tipo; a equipe confirma o plano
// antes de gravar, como na importação.
//
// O ERRO NÃO É SIMÉTRICO, e isso decide o desenho:
//   pessoa marcada como empresa  → ela desaparece do assistente. Incômodo.
//   empresa marcada como pessoa  → a carteira da empresa fica visível a quem
//                                  não deveria vê-la. Falha de acesso.
// Por isso só se propõe virar pessoa física quando NÃO HÁ NENHUM sinal de
// empresa. Sinal fraco (palavra de ramo, "&") vai para REVISAR, e ninguém
// decide por ele.

export type TipoCliente = 'individual' | 'business'

/** Sufixo jurídico: sinal FORTE. Quem escreve LLC no nome tem LLC. */
const SUFIXOS = [
  'LLC', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO',
  'COMPANY', 'LTD', 'LIMITED', 'LP', 'LLP', 'PLLC', 'PC', 'PA',
  'TRUST', 'FOUNDATION', 'ASSOCIATION', 'ASSOC', 'PARTNERS', 'PARTNERSHIP',
  'HOLDINGS', 'ENTERPRISES', 'ENTERPRISE', 'VENTURES', 'GROUP',
]

/** Palavra de ramo: sinal FRACO. Sobrenome também pode ser "Market". */
const RAMOS = [
  'SERVICES', 'SERVICE', 'CONSTRUCTION', 'CLEANING', 'LANDSCAPING', 'PAINTING',
  'REMODELING', 'ROOFING', 'PLUMBING', 'ELECTRIC', 'TRANSPORT', 'TRUCKING',
  'LOGISTICS', 'AUTO', 'MOTORS', 'RESTAURANT', 'PIZZA', 'CAFE', 'BAKERY',
  'MARKET', 'GROCERY', 'STORE', 'SHOP', 'SALON', 'BARBER', 'SPA', 'GYM',
  'FITNESS', 'CONSULTING', 'SOLUTIONS', 'SYSTEMS', 'TECHNOLOGIES', 'REALTY',
  'PROPERTIES', 'INSURANCE', 'AGENCY', 'STUDIO', 'CHURCH', 'MINISTRY',
  'ACADEMY', 'SCHOOL', 'CLINIC', 'DENTAL', 'MEDICAL', 'PHARMACY',
]

export interface CadastroParaClassificar {
  name?: string | null
  business_name?: string | null
  ein?: string | null
  business_type?: string | null
  type?: string | null
}

/**
 * Palavras do nome, em maiúscula e sem pontuação.
 *
 * O PONTO É REMOVIDO, não trocado por espaço: `L.L.C.` tem de virar `LLC`,
 * e não `L` + `L` + `C` — foi assim que "Alpha L.L.C." passou por pessoa
 * física no primeiro teste. Vale também para `P.C.` e `P.A.`.
 */
function palavras(nome: unknown): string[] {
  return String(nome ?? '')
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/[,'"()]/g, ' ')
    .split(/[\s\-\/]+/)
    .filter(Boolean)
}

/** EIN com nove dígitos. `ein` em branco ou com máscara vazia não conta. */
function temEin(ein: unknown): boolean {
  return String(ein ?? '').replace(/\D/g, '').length === 9
}

export interface Sinais {
  fortes: string[]
  fracos: string[]
}

/**
 * O que no cadastro indica empresa.
 *
 * `business_name` diferente do `name` conta como forte: a equipe digitou uma
 * razão social à parte. Igual ao nome NÃO conta — a herança automática de
 * `lib/novo-cliente.ts` copia o nome quando a razão social vem vazia, então
 * ela não prova nada.
 */
export function sinaisDeEmpresa(c: CadastroParaClassificar): Sinais {
  const fortes: string[] = []
  const fracos: string[] = []

  if (temEin(c.ein)) fortes.push('tem EIN')
  if (String(c.business_type ?? '').trim()) fortes.push(`tipo de entidade: ${String(c.business_type).trim()}`)

  const nome = String(c.name ?? '').trim()
  const razao = String(c.business_name ?? '').trim()
  if (razao && razao.toUpperCase() !== nome.toUpperCase()) {
    fortes.push(`razão social própria: ${razao}`)
  }

  const p = new Set([...palavras(nome), ...palavras(razao)])
  for (const s of SUFIXOS) if (p.has(s)) { fortes.push(`"${s}" no nome`); break }
  for (const r of RAMOS)   if (p.has(r)) { fracos.push(`"${r}" no nome`); break }
  if (/&| E | AND /i.test(` ${nome} `)) fracos.push('"&" no nome')

  return { fortes, fracos }
}

export type Decisao = 'manter_empresa' | 'virar_pessoa' | 'revisar'

export interface Proposta {
  decisao: Decisao
  motivos: string[]
}

/**
 * O que fazer com um cadastro que hoje está como EMPRESA.
 *
 * - sinal forte  → fica empresa
 * - sinal fraco  → REVISAR (ninguém decide por palavra de ramo)
 * - nenhum sinal → propõe pessoa física
 */
export function propostaParaEmpresa(c: CadastroParaClassificar): Proposta {
  const { fortes, fracos } = sinaisDeEmpresa(c)
  if (fortes.length) return { decisao: 'manter_empresa', motivos: fortes }
  if (fracos.length) return { decisao: 'revisar', motivos: fracos }
  return {
    decisao: 'virar_pessoa',
    motivos: ['nenhum sinal de empresa: sem EIN, sem tipo de entidade, sem razão social própria, nome sem sufixo jurídico'],
  }
}
