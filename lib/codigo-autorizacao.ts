// lib/codigo-autorizacao.ts — o código que um gerente dá para liberar UMA cobrança
//
// O PROBLEMA QUE ISTO RESOLVE
// A aprovação de recebimento em espécie pedia o e-mail e a senha de um
// gerente, digitados no computador de quem está no balcão. Três defeitos:
//   1. senha de terceiro digitada em máquina alheia — quem está ao lado vê,
//      o navegador oferece salvar, e a senha serve para tudo, não só para
//      aquela cobrança;
//   2. o Supabase limita tentativas de login por IP: na temporada, com 40
//      atendimentos saindo do mesmo escritório, a aprovação começa a falhar
//      por "muitas tentativas" sem nada de errado ter acontecido;
//   3. uma senha autoriza infinitas cobranças; ninguém sabe quantas.
//
// COMO FUNCIONA
// O gerente abre a aba Autorização no PRÓPRIO login, aparece um número, e
// ele dita. O número vale por poucos minutos e por UMA cobrança: o primeiro
// uso o queima. Quem autorizou, para qual fatura e de quanto fica na trilha.
//
// Um código por cobrança é decisão do sócio, e é o que separa "o gerente
// autorizou aquele recebimento de $400 em dinheiro" de "o gerente abriu a
// aba naquela tarde".

/**
 * Alfabeto sem caractere ambíguo: nada de O/0, I/1/L, S/5, Z/2.
 * O código é DITADO ao telefone ou de mesa a mesa — confundir um caractere
 * gasta a paciência de quem tem cliente na frente.
 */
export const ALFABETO = 'ACDEFGHJKMNPQRTUVWXY34679'

/** Oito caracteres: 25^8 ≈ 1,5 × 10^11 combinações, com 10 minutos de vida. */
export const TAMANHO = 8

/** Minutos de vida do código. Dá para atravessar o escritório, não o dia. */
export const MINUTOS_DE_VIDA = 10

/** Gera um código novo. `aleatorio` entra para o teste ser determinístico. */
export function gerarCodigo(aleatorio: () => number = Math.random): string {
  let s = ''
  for (let i = 0; i < TAMANHO; i++) {
    s += ALFABETO[Math.floor(aleatorio() * ALFABETO.length)]
  }
  return s
}

/** Com o hífen no meio, para a tela e para quem dita. */
export function formatar(codigo: string): string {
  const c = normalizar(codigo)
  return c.length === TAMANHO ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

/**
 * O que a pessoa digita vira o que o banco guarda.
 *
 * Aceita minúscula, hífen, espaço e o que mais vier da digitação apressada;
 * recusar por causa de um hífen seria recusar por causa da tela, não da
 * autorização.
 */
export function normalizar(bruto: unknown): string {
  return String(bruto ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** O formato está certo? (Não diz se existe — isso é do banco.) */
export function formatoValido(bruto: unknown): boolean {
  const c = normalizar(bruto)
  if (c.length !== TAMANHO) return false
  for (const ch of c) if (!ALFABETO.includes(ch)) return false
  return true
}

export type MotivoDaRecusa = 'formato' | 'nao_encontrado' | 'ja_usado' | 'expirado' | 'nivel'

/** A frase que a equipe lê. Diz o que fazer, não o código de erro. */
export const RECUSA: Record<MotivoDaRecusa, string> = {
  formato:        'O código tem 8 caracteres, como ACDE-3467. Confira o que foi ditado.',
  nao_encontrado: 'Código não encontrado. Peça ao gerente para abrir a aba Autorização e ditar o número que está na tela.',
  ja_usado:       'Este código já foi usado. Cada código libera uma cobrança só — peça outro.',
  expirado:       `Este código expirou (vale ${MINUTOS_DE_VIDA} minutos). Peça ao gerente para gerar outro.`,
  nivel:          'Quem gerou o código não é gerente nem sócio.',
}

/** Quanto falta, em segundos. Zero quando já venceu. */
export function segundosRestantes(expiraEm: string | Date | null | undefined, agora: Date = new Date()): number {
  if (!expiraEm) return 0
  const fim = new Date(expiraEm).getTime()
  if (!Number.isFinite(fim)) return 0
  return Math.max(0, Math.floor((fim - agora.getTime()) / 1000))
}

/** "3:07" — para o relógio na tela do gerente. */
export function relogio(segundos: number): string {
  const s = Math.max(0, Math.floor(segundos))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
