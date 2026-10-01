// Contas a pagar da firma — o caixa DIÁRIO, não a contabilidade.
//
// A SEPARAÇÃO, OUTRA VEZ (seção 4.2 da especificação)
// O livro da firma é por REGIME DE CAIXA: a despesa nasce quando o dinheiro
// sai, e isso já chega pelo extrato. Uma conta a pagar NÃO vira lançamento —
// se virasse, a mesma despesa entraria duas vezes, uma na emissão e outra no
// pagamento, e o P&L do ano sairia dobrado onde houvesse boleto.
//
// O que ela faz é outra coisa: dizer o que se deve, para quem e quando
// vence — para não esquecer de pagar e para projetar o caixa. Quando o
// débito aparece no banco, a conta é LIGADA a ele e fecha; a despesa
// continua sendo a do extrato.
//
// Tudo aqui é puro e recebe `hoje` de fora: o dia é o do ESCRITÓRIO
// (`dataDaFirma`, America/New_York), nunca o do servidor — às 20h de Malden
// o UTC já virou amanhã, e uma conta venceria um dia antes.

export type SituacaoDaConta = 'paga' | 'cancelada' | 'vencida' | 'vence_hoje' | 'a_vencer'

export interface ContaAPagar {
  id?: string
  payee: string
  description?: string | null
  category?: string | null
  amount: number
  issue_date?: string | null
  due_date: string
  status?: string
  paid_tx_id?: string | null
}

const DIA = 86400000
const emDias = (iso: string) => Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`)

/** Dias até vencer: negativo é atraso. Meio-dia evita o pulo do verão. */
export function diasAteVencer(due: string, hoje: string): number {
  return Math.round((emDias(due) - emDias(hoje)) / DIA)
}

/**
 * Paga e cancelada vencem o vencimento: conta paga com atraso não volta a
 * aparecer como vencida, e cancelada não cobra nada de ninguém.
 */
export function situacaoDaConta(c: ContaAPagar, hoje: string): SituacaoDaConta {
  if (c.status === 'paga') return 'paga'
  if (c.status === 'cancelada') return 'cancelada'
  const d = diasAteVencer(c.due_date, hoje)
  if (d < 0) return 'vencida'
  if (d === 0) return 'vence_hoje'
  return 'a_vencer'
}

export interface AgingDePagar {
  aVencer: number
  ate30: number
  ate60: number
  ate90: number
  mais90: number
  total: number
  vencido: number
}

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * O que a firma deve, por faixa de atraso. Só conta ABERTA entra — paga e
 * cancelada não são dívida.
 *
 * "Vence hoje" conta em `aVencer`: ainda dá para pagar hoje, e somá-lo ao
 * atraso faria o número de vencido pular todo dia de manhã.
 */
export function agingDePagar(contas: ContaAPagar[], hoje: string): AgingDePagar {
  const a: AgingDePagar = { aVencer: 0, ate30: 0, ate60: 0, ate90: 0, mais90: 0, total: 0, vencido: 0 }
  for (const c of contas || []) {
    const s = situacaoDaConta(c, hoje)
    if (s === 'paga' || s === 'cancelada') continue
    const v = Number(c.amount) || 0
    const atraso = -diasAteVencer(c.due_date, hoje)
    if (atraso <= 0) a.aVencer += v
    else if (atraso <= 30) a.ate30 += v
    else if (atraso <= 60) a.ate60 += v
    else if (atraso <= 90) a.ate90 += v
    else a.mais90 += v
    a.total += v
  }
  a.aVencer = r2(a.aVencer); a.ate30 = r2(a.ate30); a.ate60 = r2(a.ate60)
  a.ate90 = r2(a.ate90); a.mais90 = r2(a.mais90); a.total = r2(a.total)
  a.vencido = r2(a.ate30 + a.ate60 + a.ate90 + a.mais90)
  return a
}

/**
 * Normaliza nome para COMPARAR SUGESTÃO — e só isso.
 *
 * NÃO é o motor de classificação (`casaTexto`/`limparRuido`, que vive em
 * três arquivos e precisa continuar idêntico nos três). Aqui ninguém
 * classifica nada: o resultado só ordena candidatos que uma pessoa vai
 * escolher. Misturar os dois faria uma quarta cópia do motor.
 */
export function chaveDoFornecedor(s: string | null | undefined): string {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export interface LancamentoDoBanco {
  id: string
  tx_date: string
  description?: string | null
  payee?: string | null
  amount: number        // negativo = saída
  bill_id?: string | null
}

export interface Candidato {
  id: string
  tx_date: string
  description: string
  valor: number
  distanciaEmDias: number
  pareceOFornecedor: boolean
}

/**
 * Débitos do banco que podem ser o pagamento desta conta.
 *
 * O valor tem de bater ao CENTAVO: pagamento parcial de boleto não existe
 * aqui (quem paga a menos renegocia e emite outra conta), e aceitar
 * aproximado faria a conta fechar com o débito errado — que é pior que não
 * fechar, porque some do radar.
 *
 * A data é uma JANELA em volta do vencimento, não o dia exato: boleto se
 * paga adiantado e atrasado. Quem decide é a pessoa; isto só ordena.
 */
export function candidatosParaConta(
  conta: ContaAPagar,
  lancamentos: LancamentoDoBanco[],
  janelaDias = 45
): Candidato[] {
  const alvo = Math.round(Number(conta.amount) * 100)
  const chave = chaveDoFornecedor(conta.payee)
  const palavras = chave.split(' ').filter(p => p.length >= 3)

  return (lancamentos || [])
    .filter(t => !t.bill_id)                                  // já pagou outra conta
    .filter(t => Number(t.amount) < 0)                        // só saída
    .filter(t => Math.round(Math.abs(Number(t.amount)) * 100) === alvo)
    .map(t => {
      const texto = chaveDoFornecedor(`${t.description || ''} ${t.payee || ''}`)
      return {
        id: t.id,
        tx_date: t.tx_date,
        description: String(t.description || ''),
        valor: Math.abs(Number(t.amount)),
        distanciaEmDias: Math.abs(diasAteVencer(t.tx_date, conta.due_date)),
        pareceOFornecedor: palavras.length > 0 && palavras.every(p => texto.includes(p)),
      }
    })
    .filter(c => c.distanciaEmDias <= janelaDias)
    // Quem parece o fornecedor vem primeiro; depois, o mais perto do vencimento.
    .sort((a, b) => (Number(b.pareceOFornecedor) - Number(a.pareceOFornecedor))
                 || (a.distanciaEmDias - b.distanciaEmDias))
}

/** Campos que o formulário pode gravar. O corpo nunca vai inteiro ao banco. */
const CAMPOS = ['payee', 'description', 'category', 'amount', 'issue_date', 'due_date', 'notes'] as const

export function camposDaConta(corpo: any): Record<string, any> {
  const limpo: Record<string, any> = {}
  for (const k of CAMPOS) {
    const v = corpo?.[k]
    if (v === undefined || v === null) continue
    if (k === 'amount') { limpo[k] = Math.round(Number(v) * 100) / 100; continue }
    const t = String(v).trim()
    limpo[k] = t === '' ? null : t
  }
  return limpo
}

/** O que impede a conta de existir. Devolve a mensagem, ou null. */
export function criticarConta(c: Record<string, any>): string | null {
  if (!c.payee) return 'Informe o fornecedor.'
  if (!c.due_date) return 'Informe o vencimento.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.due_date))) return 'Vencimento inválido (use AAAA-MM-DD).'
  if (c.issue_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(c.issue_date))) {
    return 'Data de emissão inválida (use AAAA-MM-DD).'
  }
  if (c.issue_date && String(c.issue_date) > String(c.due_date)) {
    return 'O vencimento não pode ser antes da emissão.'
  }
  const v = Number(c.amount)
  if (!Number.isFinite(v) || v <= 0) return 'Informe um valor maior que zero.'
  return null
}
