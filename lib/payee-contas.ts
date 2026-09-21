// lib/payee-contas.ts — que contas contábeis este payee já usou, e quantas vezes
//
// O PROBLEMA QUE ISTO RESOLVE
// Ao escolher o payee numa linha sem categoria, o sistema pegava a conta do
// ÚLTIMO lançamento dele e gravava sozinho. Funciona para o fornecedor que
// sempre cai na mesma conta — e erra sempre para o fornecedor que não cai.
// Há cliente com o mesmo payee em contas diferentes (material numa, serviço
// noutra, combustível noutra), e ali a última não é resposta: é palpite.
//
// Mudar para "sugere a última, mas não grava" resolve metade. A outra metade
// é que a última, sozinha, ESCONDE que existem outras — quem lança não tem
// como saber que precisa pensar. Por isso este módulo devolve o histórico
// INTEIRO, ordenado, com quantas vezes cada conta foi usada.
//
// O caminho automático (regra e IA, na importação) não passa por aqui e não
// muda: continua reconhecendo e indo para 🔵 Reconhecidas.
//
// Módulo puro: a rota e a tela usam a MESMA contagem. Duas telas calculando
// o mesmo número de jeitos diferentes é o que a convenção do projeto proíbe.

export interface LancamentoDoPayee {
  category?: string | null
  tx_date?: string | null
}

export interface ContaUsada {
  category: string
  vezes: number
  /** Data do uso mais recente desta conta, em YYYY-MM-DD. */
  ultima: string | null
}

export interface HistoricoDoPayee {
  /** Contas ordenadas: mais recente primeiro; empate na data, mais usada primeiro. */
  contas: ContaUsada[]
  /** A conta do lançamento mais recente — a que o sistema gravava sozinho. */
  sugerida: string | null
  /**
   * Mais de uma conta no histórico.
   *
   * É o sinal que faltava: com `variado`, a tela avisa em vez de sugerir em
   * silêncio, porque a última não representa o payee.
   */
  variado: boolean
}

const data = (v: unknown): string | null => {
  const s = String(v ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

const nome = (v: unknown): string => String(v ?? '').trim()

/**
 * Agrupa os lançamentos de um payee por conta.
 *
 * Aceita a lista em qualquer ordem: quem ordena é esta função, e não quem
 * consultou. Lançamento sem conta é ignorado — não diz nada sobre o payee.
 */
export function historicoDoPayee(lancamentos: LancamentoDoPayee[]): HistoricoDoPayee {
  const porConta = new Map<string, ContaUsada>()

  for (const l of lancamentos || []) {
    const c = nome(l?.category)
    if (!c) continue
    const d = data(l?.tx_date)
    const atual = porConta.get(c)
    if (!atual) {
      porConta.set(c, { category: c, vezes: 1, ultima: d })
      continue
    }
    atual.vezes++
    // `null` é mais antigo que qualquer data: lançamento sem data não pode
    // ganhar da data que existe.
    if (d && (!atual.ultima || d > atual.ultima)) atual.ultima = d
  }

  const contas = [...porConta.values()].sort((a, b) => {
    const da = a.ultima || '', db = b.ultima || ''
    if (da !== db) return db.localeCompare(da)   // mais recente primeiro
    if (a.vezes !== b.vezes) return b.vezes - a.vezes
    return a.category.localeCompare(b.category)  // desempate estável
  })

  return {
    contas,
    sugerida: contas[0]?.category ?? null,
    variado: contas.length > 1,
  }
}

/** A frase que a equipe lê quando o payee não tem uma conta só. */
export function avisoDeVariacao(h: HistoricoDoPayee): string | null {
  if (!h.variado) return null
  const total = h.contas.reduce((s, c) => s + c.vezes, 0)
  return `Este payee já foi lançado em ${h.contas.length} contas diferentes ` +
         `(${total} lançamentos). Escolha a certa para este — a última não vale por regra.`
}
