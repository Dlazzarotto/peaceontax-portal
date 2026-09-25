// lib/dia-da-firma.ts — que dia é "hoje" para a Peace on Tax
//
// O servidor da Vercel roda em UTC. O escritório fica em Massachusetts.
// Às 20h de Malden já é o dia seguinte em UTC — e na temporada se atende
// até tarde. Usar a data do servidor faria a lista do assistente ZERAR no
// meio do expediente, com ele ainda atendendo. Por isso o corte do dia sai
// daqui, no fuso da firma, e não de `new Date().toISOString().slice(0,10)`.
//
// Também trata o horário de verão: em março e novembro o deslocamento muda
// (EDT −4h, EST −5h) e meia-noite local não cai no mesmo ponto de UTC.

export const FUSO_DA_FIRMA = 'America/New_York'

/** Quanto o fuso está deslocado de UTC NESTE instante, em milissegundos. */
function deslocamento(instante: Date, fuso: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p: any = Object.fromEntries(f.formatToParts(instante).map(x => [x.type, x.value]))
  const comoSeFosseUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second),
  )
  return comoSeFosseUtc - instante.getTime()
}

/** A data local no fuso da firma, em YYYY-MM-DD. */
export function dataDaFirma(agora: Date = new Date(), fuso = FUSO_DA_FIRMA): string {
  // en-CA formata como YYYY-MM-DD, que é o que o banco entende.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(agora)
}

/**
 * O instante em que começou o dia de hoje no escritório.
 *
 * Duas passadas: a primeira chuta meia-noite usando o deslocamento de agora,
 * a segunda corrige usando o deslocamento no próprio chute. Sem isso, o
 * domingo em que o relógio muda erra em uma hora — e uma hora de fatura
 * sumindo da tela é exatamente o tipo de coisa que ninguém liga ao horário
 * de verão.
 */
export function inicioDoDia(agora: Date = new Date(), fuso = FUSO_DA_FIRMA): Date {
  const [a, m, d] = dataDaFirma(agora, fuso).split('-').map(Number)
  const comoUtc = Date.UTC(a, m - 1, d, 0, 0, 0, 0)
  let instante = new Date(comoUtc - deslocamento(agora, fuso))
  instante = new Date(comoUtc - deslocamento(instante, fuso))
  return instante
}

/** O corte pronto para o filtro do Supabase (`.gte('created_at', …)`). */
export function corteDeHoje(agora: Date = new Date(), fuso = FUSO_DA_FIRMA): string {
  return inicioDoDia(agora, fuso).toISOString()
}

/**
 * A janela [de, ate] de um relatório, no dia do ESCRITÓRIO.
 *
 * O relatório comparava `received_at` com `from` e `${to}T23:59:59Z` — UTC.
 * Malden está 4 ou 5 horas atrás: um recebimento das 20h do último dia do mês
 * já é 00h do dia seguinte em UTC e **caía no mês seguinte**. Na temporada,
 * com balcão à noite, isso muda o faturamento do mês — e é o número em que o
 * sócio decide.
 *
 * Devolve o fim EXCLUSIVO (use `.lt`, não `.lte`): assim nenhum instante fica
 * de fora nem é contado duas vezes na emenda de um período com o outro.
 */
export function janelaDaFirma(de: string, ate: string, fuso = FUSO_DA_FIRMA): {
  inicio: string
  fimExclusivo: string
} {
  // Meio-dia UTC cai no MESMO dia em Nova York o ano todo — não há como o
  // fuso empurrar a data para trás a partir daí.
  const meioDia = (d: string) => new Date(`${d}T12:00:00Z`)
  const diaSeguinte = new Date(meioDia(ate).getTime() + 24 * 60 * 60 * 1000)
  return {
    inicio: inicioDoDia(meioDia(de), fuso).toISOString(),
    fimExclusivo: inicioDoDia(diaSeguinte, fuso).toISOString(),
  }
}
