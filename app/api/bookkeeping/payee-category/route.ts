// GET /api/bookkeeping/payee-category?clientId=...&payee=...
//
// Devolve TODAS as contas que esse payee já usou NESTE cliente — qualquer ano,
// qualquer banco —, ordenadas da mais recente para a mais antiga, com quantas
// vezes cada uma foi usada. Sem histórico, cai na regra que aponta o payee.
//
// POR QUE O HISTÓRICO INTEIRO, E NÃO SÓ A ÚLTIMA
// Esta rota devolvia uma conta só, e a tela GRAVAVA essa conta sozinha ao se
// escolher o payee. Funciona para o fornecedor que sempre cai na mesma conta
// e erra sempre para o que não cai — há cliente com o mesmo payee em contas
// diferentes (material numa, serviço noutra, combustível noutra). Pior: a
// última, sozinha, esconde que existem outras, e quem lança não tem como
// saber que precisa pensar.
//
// Agora a rota SUGERE e a tela não grava nada. Quem decide é quem lança.
//
// Isto vale para o caminho MANUAL — escolher o payee numa linha sem conta, que
// é o caso do cheque (só vêm número e valor). O caminho automático (regra e IA
// na importação) não passa por aqui e não muda.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { historicoDoPayee, avisoDeVariacao } from '@/lib/payee-contas'
import { buscaLiteral } from '@/lib/clientes-grupos'

export const dynamic = 'force-dynamic'

// O suficiente para as contas aparecerem e para a contagem ter sentido, sem
// arrastar o histórico inteiro de um fornecedor semanal.
const LIMITE = 200

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId')
  const payee = (sp.get('payee') || '').trim()
  if (!clientId || !payee) return NextResponse.json({ error: 'clientId e payee obrigatórios' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const key = payee.toLowerCase()

  // 1) Histórico do cliente — tudo o que esse payee já recebeu de conta.
  // O curinga do LIKE é escapado: um payee chamado "100%" casaria com
  // qualquer coisa começando em "100". A comparação exata vem depois.
  const { data: hist, error: errHist } = await db
    .from('bank_transactions')
    .select('category, payee, tx_date, fiscal_year')
    .eq('client_id', clientId)
    .ilike('payee', buscaLiteral(payee))
    .not('category', 'is', null)
    .neq('status', 'excluded')
    .order('tx_date', { ascending: false })
    .limit(LIMITE)

  // Consulta que falha não vira "payee sem histórico": isso faria a tela
  // dizer que não há sugestão quando há, e o lançador escolheria no escuro.
  if (errHist) {
    return NextResponse.json({
      error: `Não foi possível ler o histórico do payee: ${errHist.message}`,
    }, { status: 500 })
  }

  // O ilike casa por padrão; aqui exige-se o nome exato (sem caixa).
  const doPayee = (hist || []).filter(
    (t: any) => String(t.payee || '').trim().toLowerCase() === key
  )

  if (doPayee.length) {
    const h = historicoDoPayee(doPayee)
    return NextResponse.json({
      ok: true,
      source: 'historico',
      // `category` é a sugestão. Continua aqui pelo nome antigo porque é o
      // que a tela lê; o que mudou é que NINGUÉM grava por conta dela.
      category: h.sugerida,
      contas: h.contas,
      variado: h.variado,
      aviso: avisoDeVariacao(h),
      lastDate: h.contas[0]?.ultima || null,
      year: doPayee[0]?.fiscal_year ?? null,
      truncado: doPayee.length >= LIMITE,
    })
  }

  // 2) Sem histórico: a regra que aponta para esse payee.
  const { data: rules, error: errRules } = await db
    .from('bookkeeping_rules')
    .select('payee, category, client_id')
    .or(`client_id.eq.${clientId},client_id.is.null`)
    .limit(3000)
  if (errRules) {
    return NextResponse.json({ error: `Não foi possível ler as regras: ${errRules.message}` }, { status: 500 })
  }

  const rule = (rules || []).find(
    (r: any) => String(r.payee || '').trim().toLowerCase() === key && r.category
  )
  if (rule) {
    return NextResponse.json({
      ok: true, source: 'regra', category: rule.category,
      contas: [{ category: rule.category, vezes: 0, ultima: null }],
      variado: false, aviso: null,
    })
  }

  return NextResponse.json({ ok: true, category: null, contas: [], variado: false, aviso: null })
}
