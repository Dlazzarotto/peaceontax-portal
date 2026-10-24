// GET /api/cron/contratos — a rotina diária que emite a fatura dos contratos POR FATURA
//
// Quem chama: o cron da Vercel (vercel.json), todo dia às 11:00 UTC (de
// madrugada em Massachusetts: a fatura já está no portal quando o cliente
// acorda). Rota pública no middleware; a trava é o CRON_SECRET, que a Vercel
// manda em "Authorization: Bearer <CRON_SECRET>". Sem a variável a rota
// recusa tudo — nunca fica aberta por omissão.
//
// O contrato por DÉBITO não passa por aqui: a assinatura do Stripe cobra, e
// a fatura dele nasce no webhook.
//
//   ?dry=1   só lista o que seria emitido, encerrado ou recusado — não grava nada
//
// A regra está em lib/contrato-unico.ts (decidirEmissao, com teste) e o banco
// em lib/emissao-contratos.ts; aqui só autenticação.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { serviceDb } from '@/lib/api-auth'
import { dataDaFirma } from '@/lib/dia-da-firma'
import { emitirFaturasDosContratos } from '@/lib/emissao-contratos'
import { avisarClienteDaFatura } from '@/lib/aviso-da-fatura'

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
  try {
    // O dia é o do ESCRITÓRIO: às 20h de Malden já é amanhã em UTC.
    const r = await emitirFaturasDosContratos(serviceDb(), {
      hoje: dataDaFirma(), dry, avisar: (db, inv) => avisarClienteDaFatura(db, inv, 'envio'),
    })
    console.log('[cron/contratos]', JSON.stringify({
      hoje: r.hoje, dry, alvo: r.alvo, emitidas: r.emitidas.length, jaEmitidas: r.jaEmitidas.length,
      encerrados: r.encerrados.length, recusados: r.recusados.length, falhas: r.falhas,
    }))
    return NextResponse.json({ ok: r.falhas.length === 0, ...r })
  } catch (e) {
    console.error('[cron/contratos] falha:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
