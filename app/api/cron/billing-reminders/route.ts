// GET /api/cron/billing-reminders — aviso de cobrança três dias antes do débito
//
// Quem chama: o cron da Vercel (vercel.json), todo dia às 14:00 UTC (manhã
// em Massachusetts). Rota pública no middleware; a trava é o CRON_SECRET, que
// a Vercel envia em "Authorization: Bearer <CRON_SECRET>". Sem a variável
// configurada a rota recusa tudo — nunca fica aberta por omissão.
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
    return NextResponse.json({ ok: true, dry, ...r })
  } catch (e) {
    console.error('[cron/billing-reminders] falha:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
