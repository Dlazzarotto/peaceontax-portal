// lib/clientes-grupos.ts — como a carteira se divide, num módulo puro.
//
// A tela de Clientes deixou de ser um quadro só com todo mundo dentro. Agora a
// entrada são dois cartões — Empresas e Pessoa física — e o quadro abre já
// separado por tipo. O motivo é de negócio, não de estética: empresa a gente
// atende o ano todo, pessoa física aparece na temporada. Misturar as duas num
// quadro de seis colunas fazia a fila da temporada esconder quem está parado
// há meses.
//
// As seis etapas do quadro respondem à pergunta "em que pé está a declaração".
// Para o cartão de entrada isso é detalhe demais: lá interessa saber quanto
// está parado esperando, quanto está na mão da equipe e quanto acabou. São
// estas três situações.

export const ETAPAS = [
  'Onboarding', 'Gathering Docs', 'In Preparation', 'Under Review', 'Filed', 'Complete',
] as const

export type Situacao = 'pendente' | 'trabalhando' | 'concluido'

/**
 * Em que situação cada etapa cai.
 *   pendente    → a bola está com o cliente (entrou agora, ou falta documento)
 *   trabalhando → a bola está com a equipe
 *   concluido   → declarado ou encerrado
 * Etapa desconhecida conta como pendente: é mais seguro aparecer na fila do
 * que sumir da conta.
 */
export const SITUACAO_DA_ETAPA: Record<string, Situacao> = {
  'Onboarding': 'pendente',
  'Gathering Docs': 'pendente',
  'In Preparation': 'trabalhando',
  'Under Review': 'trabalhando',
  'Filed': 'concluido',
  'Complete': 'concluido',
}

export function situacaoDaEtapa(etapa: string | null | undefined): Situacao {
  return SITUACAO_DA_ETAPA[String(etapa || '').trim()] || 'pendente'
}

export const ROTULO_SITUACAO: Record<Situacao, string> = {
  pendente: 'Esperando o cliente',
  trabalhando: 'Com a equipe',
  concluido: 'Concluído',
}

export interface ResumoTipo {
  total: number
  pendente: number
  trabalhando: number
  concluido: number
}

export const ZERADO: ResumoTipo = { total: 0, pendente: 0, trabalhando: 0, concluido: 0 }

/**
 * Soma por situação a partir de linhas { stage, quantidade }. Vem assim porque
 * a contagem é feita no banco: com quase mil cadastros, trazer todos para
 * contar no navegador é transferir a carteira inteira a cada abertura da tela.
 */
export function resumirEtapas(linhas: { stage: string | null; quantidade: number }[]): ResumoTipo {
  const r: ResumoTipo = { ...ZERADO }
  for (const l of linhas) {
    const n = Number(l.quantidade) || 0
    if (n <= 0) continue
    r.total += n
    r[situacaoDaEtapa(l.stage)] += n
  }
  return r
}

/** Escapa curinga de LIKE. Sem isto, buscar "100%" casa com "1000" e "100X". */
export function buscaLiteral(termo: string): string {
  return String(termo || '').replace(/[\\%_]/g, c => `\\${c}`)
}
