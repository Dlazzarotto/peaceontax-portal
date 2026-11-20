// POST /api/plaid/sync { clientId } — sincroniza TODAS as conexões do cliente (equipe)
//   → { ok, added, ruled, falhas, incompleto, details[] }
//   `incompleto`: alguma conexão parou no prazo e continua na próxima rodada.
import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { syncPlaidItem } from '@/lib/plaid-sync'

export const maxDuration = 120
/** Parte dos 120 s que vai para as conexões; o resto é folga para regras e resposta. */
const PRAZO_DA_ROTA_MS = 90_000

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const { clientId } = await req.json()
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  // A conexão que deu erro UMA vez também entra: com `.eq('status','active')`
  // um tropeço (rede, tempo) a tirava do botão para sempre — e a tela seguia
  // contando-a em "Sincronizar Plaid (N)". Se o erro persiste, a frase volta.
  const { data: items, error: errItems } = await db.from('plaid_items')
    .select('id, institution_name, status').eq('client_id', clientId).in('status', ['active', 'error'])
  if (errItems) return NextResponse.json({ error: `Falhou ao ler as conexões: ${errItems.message}` }, { status: 500 })
  if (!items || items.length === 0) {
    return NextResponse.json({ error: 'Cliente sem bancos conectados via Plaid' }, { status: 404 })
  }

  // O tempo da função é dividido entre as conexões, e cada uma para no seu
  // prazo salvando onde parou: cortada pela Vercel, a rodada não salvava nada
  // e o clique seguinte recomeçava do mesmo lugar (lib/plaid-paginacao.ts).
  const prazoFinal = Date.now() + PRAZO_DA_ROTA_MS
  let totalAdded = 0, ruled = 0, falhas = 0, incompleto = false
  const results: string[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const nome = item.institution_name || 'Banco'
    const restante = prazoFinal - Date.now()
    if (restante < 5_000) {
      incompleto = true
      results.push(`${nome}: ficou para a próxima rodada (sem tempo nesta)`)
      continue
    }
    try {
      const r = await syncPlaidItem(db, item.id, { prazoMs: Math.floor(restante / (items.length - i)) })
      totalAdded += r.added
      ruled += r.ruled || 0
      falhas += r.falhas || 0
      if (!r.completo) incompleto = true
      results.push(`${nome}: +${r.added}${r.completo ? '' : ' (continua na próxima rodada)'}`
        + (r.falhas ? ` · ${r.falhas} recusada(s) pelo banco: ${r.primeiraFalha}` : ''))
    } catch (e) {
      await db.from('plaid_items').update({ status: 'error' }).eq('id', item.id)
      results.push(`${nome}: erro (${(e as Error).message})`)
    }
  }

  return NextResponse.json({ ok: true, added: totalAdded, ruled, falhas, incompleto, details: results })
}

