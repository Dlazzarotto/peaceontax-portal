// POST /api/plaid/sync { clientId } — sincroniza TODAS as conexões do cliente (equipe)
//   → { ok, added, ruled, falhas, jaNoLivro, iguais, exemplos[], incompleto, details[] }
//   `incompleto`: alguma conexão parou no prazo e continua na próxima rodada.
//   `ruled`: as que SAÍRAM de não reconhecidas agora (regras aplicadas UMA vez,
//   no fim — por conexão, a fila inteira era reaplicada e somada).
import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { syncPlaidItem } from '@/lib/plaid-sync'
import { applyRulesToClient } from '@/lib/apply-rules'

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
  // Quem está há mais tempo sem sincronizar vai PRIMEIRO: na ordem fixa, o
  // banco de histórico maior comia a rodada e o último ficava sempre sem vez.
  const { data: items, error: errItems } = await db.from('plaid_items')
    .select('id, institution_name, status, last_synced_at').eq('client_id', clientId).in('status', ['active', 'error'])
    .order('last_synced_at', { ascending: true, nullsFirst: true })
  if (errItems) return NextResponse.json({ error: `Falhou ao ler as conexões: ${errItems.message}` }, { status: 500 })
  if (!items || items.length === 0) {
    return NextResponse.json({ error: 'Cliente sem bancos conectados via Plaid' }, { status: 404 })
  }

  // O tempo da função é dividido entre as conexões, e cada uma para no seu
  // prazo salvando onde parou: cortada pela Vercel, a rodada não salvava nada
  // e o clique seguinte recomeçava do mesmo lugar (lib/plaid-paginacao.ts).
  const prazoFinal = Date.now() + PRAZO_DA_ROTA_MS
  let totalAdded = 0, falhas = 0, jaNoLivro = 0, iguais = 0, incompleto = false
  const exemplos: string[] = []
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
      const r = await syncPlaidItem(db, item.id, { prazoMs: Math.floor(restante / (items.length - i)), aplicarRegras: false })
      totalAdded += r.added
      falhas += r.falhas || 0
      jaNoLivro += r.jaNoLivro || 0
      iguais += r.iguais || 0
      for (const ex of r.exemplos || []) if (exemplos.length < 3) exemplos.push(ex)
      if (!r.completo) incompleto = true
      results.push(`${nome}: +${r.added}${r.completo ? '' : ' (continua na próxima rodada)'}`
        + (r.jaNoLivro ? ` · ${r.jaNoLivro} já no livro` : '')
        + (r.iguais ? ` · ${r.iguais} igual(is) a outra do mesmo dia` : '')
        + (r.falhas ? ` · ${r.falhas} recusada(s) pelo banco: ${r.primeiraFalha}` : ''))
    } catch (e) {
      await db.from('plaid_items').update({ status: 'error' }).eq('id', item.id)
      results.push(`${nome}: erro (${(e as Error).message})`)
    }
  }

  // Uma vez, no fim, sobre a fila do cliente: conta quem SAIU de não
  // reconhecida agora (lib/apply-rules.ts).
  const ruled = totalAdded > 0 ? await applyRulesToClient(db, clientId).catch(() => 0) : 0

  return NextResponse.json({ ok: true, added: totalAdded, ruled, falhas, jaNoLivro, iguais, exemplos, incompleto, details: results })
}

