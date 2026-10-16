// testes/painel.mts — o painel conta pelo dia do ESCRITÓRIO
//
// `received_at` e `created_at` são timestamps. Cortar os 10 primeiros
// caracteres é a data em UTC — e às 20h de Malden o UTC já virou amanhã: o
// recebimento das 22h do dia 31 caía no mês SEGUINTE, e o "recebido no mês"
// do painel discordava do relatório (que corta por `janelaDaFirma`) e do
// caixa. É o número em que o sócio decide; por isso é testado, não lido.
//
// 2026: o horário de verão acaba em 1/nov às 2h (06:00 UTC). Os instantes
// abaixo ficam ANTES da virada de propósito — a dúvida que se testa é a do
// fuso, não a da virada.

import { hojeET, janelas, somaPeriodo, serieMensal, resumoCarteira } from '../lib/painel.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// ── hojeET: a data civil de Nova York ───────────────────────────────────
eq('22h EDT do dia 31 ainda é dia 31', hojeET(new Date('2026-11-01T02:00:00Z')), '2026-10-31')
eq('meia-noite EDT vira dia 1', hojeET(new Date('2026-11-01T04:00:00Z')), '2026-11-01')
eq('inverno (EST −5): 23h30 do dia 30', hojeET(new Date('2026-12-01T04:30:00Z')), '2026-11-30')

// ── somaPeriodo: o recebimento conta no dia do escritório ───────────────
{
  const pg = [
    { amount: 100, received_at: '2026-10-31T23:30:00Z' },   // 19:30 EDT, 31/out
    { amount: 200, received_at: '2026-11-01T02:00:00Z' },   // 22:00 EDT, 31/out — em UTC já é 1/nov
    { amount: 400, received_at: '2026-11-01T04:00:00Z' },   // 00:00 EDT, 1/nov
    { amount: 8,   received_at: '2026-10-15' },             // data pura: fica como está
  ]
  eq('outubro inclui o das 22h do dia 31 (o caso do bug)', somaPeriodo(pg, '2026-10-01', '2026-10-31'), 308)
  eq('novembro começa na meia-noite do escritório', somaPeriodo(pg, '2026-11-01', '2026-11-30'), 400)
  eq('fatia de um dia', somaPeriodo(pg, '2026-10-31', '2026-10-31'), 300)
  eq('valor em texto soma', somaPeriodo([{ amount: '12.50', received_at: '2026-10-10T15:00:00Z' }], '2026-10-01', '2026-10-31'), 12.5)
  eq('data inválida não derruba, só não conta', somaPeriodo([{ amount: 5, received_at: 'x' }], '2026-10-01', '2026-10-31'), 0)
  eq('lista vazia', somaPeriodo([], '2026-10-01', '2026-10-31'), 0)
}

// ── serieMensal: o balde do mês é o do escritório ───────────────────────
{
  const pg = [
    { amount: 200, received_at: '2026-11-01T02:00:00Z' },   // 22:00 EDT 31/out → outubro
    { amount: 50,  received_at: '2026-11-01T04:00:00Z' },   // 1/nov
  ]
  const s = serieMensal(pg, '2026-11', 2)
  eq('série: dois meses na ordem', s.map(l => l.ym), ['2026-10', '2026-11'])
  eq('série: 22h do dia 31 cai em outubro', s[0].total, 200)
  eq('série: novembro só com o de 1/nov', s[1].total, 50)
}

// ── janelas ─────────────────────────────────────────────────────────────
{
  const j = janelas('2026-10-09')
  eq('início do mês', j.inicioMes, '2026-10-01')
  eq('mês anterior', j.inicioMesAnterior, '2026-09-01')
  eq('mesmo dia do mês anterior', j.mesmoDiaMesAnterior, '2026-09-09')
  eq('fim do mês anterior', j.fimMesAnterior, '2026-09-30')
  eq('início do ano', j.inicioAno, '2026-01-01')
  eq('janeiro olha para dezembro do ano anterior', janelas('2026-01-31').mesmoDiaMesAnterior, '2025-12-31')
  eq('dia 31 em mês curto anterior encosta no último dia', janelas('2026-03-31').mesmoDiaMesAnterior, '2026-02-28')
}

// ── resumoCarteira: "novo no mês" pelo dia do escritório ────────────────
{
  const cs = [
    { type: 'business',   created_at: '2026-11-01T02:00:00Z' },   // 22:00 EDT 31/out → NÃO é de novembro
    { type: 'individual', created_at: '2026-11-01T04:00:00Z' },   // 1/nov → novo
    { type: 'individual', stage: 'Done' },
  ]
  const r = resumoCarteira(cs, '2026-11-05')
  eq('novos no mês: só o de 1/nov', r.novosNoMes, 1)
  eq('empresas × pessoas', [r.empresas, r.pessoas], [1, 2])
  eq('etapa ausente conta como Onboarding', r.porEtapa.Onboarding, 2)
}

console.log(`painel: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
