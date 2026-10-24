// lib/orcamento-automatico.ts — o orçamento da declaração calculado pelos documentos
//
// Era o "Gerar cotação automática" do módulo Quotes (aba do cliente). Com os
// orçamentos num lugar só — o Financeiro (decisão do sócio) —, o cálculo
// passou a preencher os ITENS do orçamento no formulário do Financeiro; a
// equipe revisa e salva como qualquer documento. Módulo puro, com teste
// (testes/orcamento-automatico.mts): a conta é dinheiro.
//
// Três defeitos da versão antiga, corrigidos aqui:
//  1. TODO 1099 contava como Schedule C (trabalho por conta própria). O
//     1099-INT e o 1099-DIV vão no Schedule B, o 1099-B no Schedule D, o
//     1099-R/G/SSA são outras linhas da declaração — cobrar Schedule C por
//     eles cobrava do cliente um anexo que ele não tem. Agora o tipo sai do
//     nome do arquivo e da categoria; o que não dá para identificar conta
//     como Schedule C (o lado da firma, revisado antes de enviar) e é
//     CONTADO à parte, para a tela dizer quantos ficaram sem identificação.
//  2. Serviço com `active` nulo era pulado. Nulo conta como ATIVO
//     (lib/catalogo-precos.ts): desativar é um ato, e ele grava false.
//  3. O item levava só o texto: agora leva o id do catálogo, como os itens
//     escolhidos à mão na fatura.

export interface DocumentoDoCliente {
  doc_type?: string | null
  category?: string | null
  subcategory?: string | null
  file_name?: string | null
}

/** De que tipo é o 1099, pelo nome do arquivo, pela categoria e pela subcategoria. */
export type Tipo1099 = 'nec' | 'misc' | 'k' | 'int' | 'div' | 'b' | 'r' | 'g' | 'ssa' | 'nao_identificado'

/** Os que vão no Schedule C. O não identificado entra — e é contado à parte. */
const DO_SCHEDULE_C: Tipo1099[] = ['nec', 'misc', 'k', 'nao_identificado']

const texto = (d: DocumentoDoCliente) =>
  [d.file_name, d.category, d.subcategory].map(x => String(x || '').toLowerCase()).join(' ')

export function ehW2(d: DocumentoDoCliente): boolean {
  if (String(d.doc_type || '').toLowerCase() === 'w2') return true
  if (d.doc_type) return false
  // Não `\bw2\b`: em "W2_2025.pdf" o `_` conta como letra e a fronteira some.
  return /(^|[^a-z0-9])w-?2([^0-9]|$)/.test(texto(d))
}

export function eh1099(d: DocumentoDoCliente): boolean {
  if (String(d.doc_type || '').toLowerCase() === '1099') return true
  if (d.doc_type) return false
  return /1099/.test(texto(d))
}

/**
 * O tipo do 1099. "1099-INT", "1099 int", "1099int" e "interest" valem o
 * mesmo. SSA-1099 (benefício do Social Security) vem antes porque o nome
 * dele também tem "1099".
 */
export function tipoDo1099(d: DocumentoDoCliente): Tipo1099 {
  const t = texto(d)
  if (/ssa[\s_-]*1099|social security/.test(t)) return 'ssa'
  const m = /1099[\s_-]*(nec|misc|int|div|k|b|r|g)(?![a-z])/.exec(t)
  if (m) return m[1] as Tipo1099
  if (/interest|juros/.test(t)) return 'int'
  if (/dividend/.test(t)) return 'div'
  if (/brokerage|corretora|proceeds/.test(t)) return 'b'
  if (/pension|retirement|ira\b|aposentadoria/.test(t)) return 'r'
  if (/unemployment|desemprego/.test(t)) return 'g'
  return 'nao_identificado'
}

export interface PerfilDaDeclaracao {
  casado: boolean
  w2: number
  /** Quantos 1099 de cada tipo — é o que a tela mostra para a equipe revisar. */
  por1099: Partial<Record<Tipo1099, number>>
  scheduleC: number
  scheduleB: boolean
  tem1099B: boolean
  tem1098: boolean
  scheduleE: number
  tem1095A: boolean
  documentos: number
}

export function perfilDosDocumentos(
  docs: DocumentoDoCliente[],
  estadoCivil: string | null | undefined,
): PerfilDaDeclaracao {
  const lista = docs || []
  const por1099: Partial<Record<Tipo1099, number>> = {}
  for (const d of lista) {
    if (!eh1099(d)) continue
    const t = tipoDo1099(d)
    por1099[t] = (por1099[t] || 0) + 1
  }
  const soma = (tipos: Tipo1099[]) => tipos.reduce((s, t) => s + (por1099[t] || 0), 0)
  return {
    casado: estadoCivil === 'Married Filing Jointly',
    w2: lista.filter(ehW2).length,
    por1099,
    scheduleC: soma(DO_SCHEDULE_C),
    scheduleB: soma(['int', 'div']) > 0,
    tem1099B: (por1099.b || 0) > 0,
    // Form 1098 é o juro da HIPOTECA. O 1098-T (mensalidade escolar) e o
    // 1098-E (juro de empréstimo estudantil) são outros créditos.
    tem1098: lista.some(d => /1098(?![\s_-]*[te](?![a-z]))|mortgage|hipoteca/.test(texto(d))),
    scheduleE: lista.filter(d => /rental|aluguel/.test(texto(d))).length,
    // 1095-A é o do Marketplace (pede o Form 8962); o 1095-B e o 1095-C não pedem nada.
    tem1095A: lista.some(d => /1095(?![\s_-]*[bc](?![a-z]))/.test(texto(d))),
    documentos: lista.length,
  }
}

export interface ItemDoCatalogo {
  id: string
  code: string | null
  label: string
  amount: number | string | null
  active: boolean | null
}

export interface ItemDoOrcamento {
  serviceId: string
  description: string
  qty: number
  unitPrice: number
}

export type OrcamentoCalculado =
  | { ok: true; itens: ItemDoOrcamento[]; total: number }
  | { ok: false; motivo: string }

/** Declaração base cobre até tantos W-2; os outros são cobrados à parte. */
export const W2_INCLUSOS = { casado: 4, solteiro: 2 }

/**
 * Os itens do orçamento, pelo catálogo (tabela Preços). O catálogo decide o
 * preço; aqui só se decide QUAIS itens e quantos.
 */
export function itensDaDeclaracao(perfil: PerfilDaDeclaracao, catalogo: ItemDoCatalogo[]): OrcamentoCalculado {
  const porCodigo = new Map<string, ItemDoCatalogo>()
  for (const c of catalogo || []) if (c.code) porCodigo.set(c.code, c)
  // Nulo conta como ativo: desativar é um ato (lib/catalogo-precos.ts).
  const ativo = (code: string) => {
    const c = porCodigo.get(code)
    return c && c.active !== false ? c : null
  }

  const codBase = perfil.casado ? 'base_married' : 'base_single'
  const base = ativo(codBase)
  if (!base) {
    return { ok: false, motivo: `A declaração base (${codBase}) está desativada ou não existe na tabela de Preços — sem ela não há como calcular.` }
  }

  const itens: ItemDoOrcamento[] = []
  const por = (c: ItemDoCatalogo, qty: number) => {
    if (qty > 0) itens.push({ serviceId: c.id, description: c.label, qty, unitPrice: Math.round(Number(c.amount || 0) * 100) / 100 })
  }
  por(base, 1)
  const extra = (code: string, qty: number) => { const c = ativo(code); if (c) por(c, qty) }

  extra('extra_w2', Math.max(0, perfil.w2 - (perfil.casado ? W2_INCLUSOS.casado : W2_INCLUSOS.solteiro)))
  extra('schedule_c', perfil.scheduleC)
  if (perfil.tem1098) extra('mortgage_1098', 1)
  extra('schedule_e', perfil.scheduleE)
  if (perfil.scheduleB) extra('schedule_b', 1)
  if (perfil.tem1099B) extra('brokerage_1099b', 1)
  if (perfil.tem1095A) extra('health_1095a', 1)

  // Em centavos: 0,1 + 0,2 não pode virar 0,30000000000000004 no total.
  const centavos = itens.reduce((s, i) => s + Math.round(i.unitPrice * 100) * i.qty, 0)
  return { ok: true, itens, total: centavos / 100 }
}
