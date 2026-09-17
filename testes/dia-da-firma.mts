// testes/dia-da-firma.mts — o corte do dia no fuso do escritório
//
// Decide o que o assistente VÊ. Com a data do servidor (UTC), a lista dele
// zerava às 20h de Malden — no meio do expediente da temporada.

import { dataDaFirma, inicioDoDia, corteDeHoje, FUSO_DA_FIRMA } from '../lib/dia-da-firma.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

eq('o fuso e o de Massachusetts', FUSO_DA_FIRMA, 'America/New_York')

// ── O caso que motivou o modulo ──
// 21h de Malden em setembro (EDT, -4h) = 01h do dia SEGUINTE em UTC.
// Pela data do servidor seria dia 18; no escritorio ainda e dia 17.
eq('21h de setembro ainda e o mesmo dia no escritorio',
   dataDaFirma(new Date('2026-09-18T01:30:00Z')), '2026-09-17')
eq('e em UTC ja virou',
   new Date('2026-09-18T01:30:00Z').toISOString().slice(0, 10), '2026-09-18')

// ── Horario de verao: EDT (-4h) ──
eq('setembro: o dia comeca as 04:00 UTC',
   inicioDoDia(new Date('2026-09-17T14:00:00Z')).toISOString(), '2026-09-17T04:00:00.000Z')

// ── Horario padrao: EST (-5h) ──
eq('janeiro: o dia comeca as 05:00 UTC',
   inicioDoDia(new Date('2026-01-15T14:00:00Z')).toISOString(), '2026-01-15T05:00:00.000Z')
eq('janeiro, 20h local, ainda e o mesmo dia',
   dataDaFirma(new Date('2026-01-16T01:00:00Z')), '2026-01-15')

// ── Os dois domingos em que o relogio muda ──
// 8 de marco de 2026: 2h vira 3h (EST -> EDT). O dia comecou em EST.
eq('domingo de marco: o dia comeca as 05:00 UTC',
   inicioDoDia(new Date('2026-03-08T18:00:00Z')).toISOString(), '2026-03-08T05:00:00.000Z')
// 1 de novembro de 2026: 2h volta para 1h (EDT -> EST). O dia comecou em EDT.
eq('domingo de novembro: o dia comeca as 04:00 UTC',
   inicioDoDia(new Date('2026-11-01T18:00:00Z')).toISOString(), '2026-11-01T04:00:00.000Z')
// A segunda seguinte ja e EST inteiro
eq('segunda depois da virada: 05:00 UTC',
   inicioDoDia(new Date('2026-11-02T18:00:00Z')).toISOString(), '2026-11-02T05:00:00.000Z')

// ── Meia-noite em ponto pertence ao dia que comeca ──
eq('00:00 local e o inicio do proprio dia',
   inicioDoDia(new Date('2026-09-17T04:00:00Z')).toISOString(), '2026-09-17T04:00:00.000Z')
eq('um minuto antes ainda e o dia anterior',
   dataDaFirma(new Date('2026-09-17T03:59:00Z')), '2026-09-16')

// ── Virada de ano e de mes ──
eq('31 de dezembro as 20h local ainda e dezembro',
   dataDaFirma(new Date('2027-01-01T01:00:00Z')), '2026-12-31')
eq('ultimo dia de fevereiro em ano comum', dataDaFirma(new Date('2026-03-01T04:30:00Z')), '2026-02-28')

// ── O corte e o mesmo instante, em texto ──
{
  const agora = new Date('2026-09-17T14:00:00Z')
  eq('corteDeHoje devolve o inicio do dia',
     corteDeHoje(agora), inicioDoDia(agora).toISOString())
  eq('o corte esta no passado', new Date(corteDeHoje(agora)) <= agora, true)
}

console.log(`dia-da-firma: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
