// GET /api/cron/billing-reminders — aviso de cobrança três dias antes do débito
//
// Quem chama: o cron da Vercel (vercel.json), todo dia às 14:00 UTC (manhã
// em Massachusetts). Rota pública no middleware; a trava é o CRON_SECRET, que
// a Vercel envia em "Authorization: Bearer <CRON_SECRET>". Sem a variável
// configurada a rota recusa tudo — nunca fica aberta por omissão.
//
// Na mesma rodada também alerta a equipe sobre plano que parou esperando o
// cliente (lib/planos-parados.ts) — nada é cancelado, só avisado.
//
//   ?dry=1     só lista quem seria avisado, sem enviar nada
//   ?dias=N    avisa N dias antes (padrão 3) — útil para teste
//
// A lógica fica em lib/billing-reminders.ts; aqui só autenticação.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { executarAvisosDeCobranca } from '@/lib/billing-reminders'
import { alertarPlanosParados } from '@/lib/planos-parados'
import { alertarAchParado } from '@/lib/ach-transito'
import { serviceDb } from '@/lib/api-auth'

function autorizado(req: NextRequest): boolean {
  const segredo = process.env.CRON_SECRET
  if (!segredo) return false
  const cab = req.headers.get('authorization') || ''
  const recebido = cab.startsWith('Bearer ') ? cab.slice(7) : ''
  const a = Buffer.from(recebido), b = Buffer.from(segredo)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'CRON_SECRET não configurado no ambiente' }, { status: 503 })
  }
  if (!autorizado(req)) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const dry = req.nextUrl.searchParams.get('dry') === '1'
  const diasParam = Number(req.nextUrl.searchParams.get('dias') || 3)
  const diasAntes = Number.isInteger(diasParam) && diasParam >= 1 && diasParam <= 30 ? diasParam : 3

  try {
    const r = await executarAvisosDeCobranca({ dry, diasAntes })
    console.log('[cron/billing-reminders]', JSON.stringify({ alvo: r.alvo, total: r.total, dry,
      canais: r.resultados.map(x => `${x.planId}:${x.canal}`) }))

    // Na mesma rodada: plano que parou esperando o cliente. Sem isto, plano em
    // awaiting_* ficava parado para sempre e ninguem percebia - nao ha tela que
    // liste "parados".
    let parados: { alvo: number; alertados: string[] } = { alvo: 0, alertados: [] }
    try {
      parados = await alertarPlanosParados(serviceDb(), { dry })
      if (parados.alertados.length) console.log('[cron/planos-parados]', JSON.stringify(parados))
    } catch (e) {
      // Falhar aqui nao pode derrubar o aviso de cobranca, que e o principal
      console.error('[cron/planos-parados] falha:', e)
    }
    // E debito em conta que ficou pelo caminho: o ACH normal leva ate quatro
    // dias uteis; passou disso, ou a confirmacao se perdeu, ou o cliente nao
    // concluiu a verificacao da conta - e a fatura ficava fora da cobranca
    // esperando dinheiro que nao vem.
    let achParado: { alvo: number; alertados: string[] } = { alvo: 0, alertados: [] }
    try {
      achParado = await alertarAchParado(serviceDb(), { dry })
      if (achParado.alertados.length) console.log('[cron/ach-parado]', JSON.stringify(achParado))
    } catch (e) {
      console.error('[cron/ach-parado] falha:', e)
    }
    return NextResponse.json({ ok: true, dry, ...r, parados, achParado })
  } catch (e) {
    console.error('[cron/billing-reminders] falha:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
