// /api/billing/orcamentos-antigos — a ponte do módulo Quotes para o Financeiro
//
//  GET            → { abertos, pagos, parcelados }       sócio e gerente
//  POST { ids? }  → traz os ABERTOS (todos, ou só os ids) para o Financeiro,
//                   como orçamento em rascunho
//
// Os orçamentos ficavam em dois lugares (decisão do sócio: um só, o
// Financeiro). A aba "Quotes" da ficha do cliente gravava numa tabela à
// parte (`quotes`), e o link de pagamento saía da própria cotação: o
// dinheiro entrava fora do livro — sem `invoice_payments`, sem a conta de
// passagem do caixa, sem conciliar com o repasse do Stripe.
//
// O que esta rota faz com cada um:
//   aberto (rascunho/enviado) → vira orçamento do Financeiro, com os mesmos
//                               itens; o desconto (item negativo) vira o
//                               desconto do documento. O antigo é encerrado
//                               com o motivo "movido para o Financeiro", na
//                               trilha dele — nada se apaga.
//   pago pelo link antigo     → só é LISTADO. O recebimento está fora do
//                               livro do caixa, e lançá-lo agora é decisão do
//                               sócio (é receita de outra data), não do sistema.
//   parcelado (plano antigo)  → só é listado. O plano já cobra; virar
//                               orçamento seria a mesma cobrança duas vezes.
//
// O antigo é RESERVADO antes (`update … where status in (rascunho, enviado)`):
// dois cliques em "Trazer" não criam dois orçamentos. Se criar falhar, a
// reserva é desfeita e o antigo volta ao que era.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb, canAccessClient, clientesOcultos } from '@/lib/api-auth'
import { getStaffLevel, auditQuote } from '@/lib/staff-perms'
import { permissoesFinanceiro, RECUSA } from '@/lib/billing-perms'

export const dynamic = 'force-dynamic'

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

async function exigeGerente() {
  const auth = await getAuth()
  if (!auth?.isStaff) return { erro: NextResponse.json({ error: 'Acesso restrito' }, { status: 403 }) }
  const nivel = await getStaffLevel(auth.userId)
  if (nivel !== 'owner' && nivel !== 'manager') {
    return { erro: NextResponse.json({ error: 'Trazer os orçamentos antigos é do sócio e do gerente.' }, { status: 403 }) }
  }
  return { auth }
}

/** A tabela pode não existir num projeto novo — aí não há o que trazer. */
const semTabela = (e: any) => /quotes/.test(String(e?.message || '')) && /does not exist|not find/i.test(String(e?.message || ''))

async function lerAntigos(auth: NonNullable<Awaited<ReturnType<typeof getAuth>>>) {
  const db = serviceDb()
  const [{ data: quotes, error }, { data: planos, error: errPlanos }, escopo] = await Promise.all([
    db.from('quotes')
      .select('id, client_id, fiscal_year, items, total, status, paid_at, stripe_payment_intent, created_at, clients(name, business_name)')
      .neq('status', 'cancelled').order('created_at'),
    db.from('payment_plans').select('quote_id').not('quote_id', 'is', null),
    clientesOcultos(auth),
  ])
  if (error) return semTabela(error) ? { vazio: true as const } : { erro: `Orçamentos antigos: ${error.message}` }
  if (errPlanos) return { erro: `Planos antigos: ${errPlanos.message}` }
  if (escopo.erro) return { erro: escopo.erro }

  const comPlano = new Set((planos || []).map((p: any) => p.quote_id))
  // Mesmo escopo das outras listas: empresa para quem não tem verEmpresas,
  // e o caixa da firma para quem não é sócio, não aparecem.
  const visiveis = (quotes || []).filter((q: any) => !escopo.ocultos.has(q.client_id))
  const linha = (q: any) => ({
    id: q.id,
    clientId: q.client_id,
    cliente: q.clients?.business_name || q.clients?.name || '—',
    ano: q.fiscal_year,
    total: round2(q.total),
    status: q.status,
    itens: Array.isArray(q.items) ? q.items.length : 0,
    criado: q.created_at,
    pagoEm: q.paid_at,
    stripe: q.stripe_payment_intent,
  })
  return {
    abertos: visiveis.filter((q: any) => ['draft', 'sent'].includes(q.status) && !comPlano.has(q.id)).map(linha),
    pagos: visiveis.filter((q: any) => q.status === 'paid').map(linha),
    parcelados: visiveis.filter((q: any) => comPlano.has(q.id)).map(linha),
    brutos: visiveis,
  }
}

export async function GET() {
  const guarda = await exigeGerente()
  if (guarda.erro) return guarda.erro
  const r = await lerAntigos(guarda.auth!)
  if ('erro' in r) return NextResponse.json({ error: r.erro }, { status: 500 })
  if ('vazio' in r) return NextResponse.json({ abertos: [], pagos: [], parcelados: [] })
  return NextResponse.json({ abertos: r.abertos, pagos: r.pagos, parcelados: r.parcelados })
}

export async function POST(req: NextRequest) {
  const guarda = await exigeGerente()
  if (guarda.erro) return guarda.erro
  const auth = guarda.auth!

  let corpo: any
  try { corpo = await req.json() } catch { corpo = {} }
  const pedidos: string[] | null = Array.isArray(corpo?.ids) ? corpo.ids.map(String) : null

  const r = await lerAntigos(auth)
  if ('erro' in r) return NextResponse.json({ error: r.erro }, { status: 500 })
  if ('vazio' in r) return NextResponse.json({ ok: true, movidos: [], falhas: [], message: 'Não há orçamentos antigos.' })

  // Quem decide QUAIS se movem é o banco (os abertos de agora), não o corpo:
  // o id pedido só filtra.
  const abertos = new Set(r.abertos.map(a => a.id))
  const alvo = r.brutos.filter((q: any) => abertos.has(q.id) && (!pedidos || pedidos.includes(q.id)))

  const db = serviceDb()
  // O desconto segue a regra de qualquer documento do Financeiro: quem teve
  // `darDesconto` retirado por autorização não o traz de volta pela ponte.
  const perms = await permissoesFinanceiro(auth.userId)
  const movidos: { de: string; para: string; cliente: string }[] = []
  const falhas: { id: string; cliente: string; motivo: string }[] = []

  for (const q of alvo as any[]) {
    const cliente = q.clients?.business_name || q.clients?.name || '—'
    if (!(await canAccessClient(auth, q.client_id))) {
      falhas.push({ id: q.id, cliente, motivo: 'sem acesso a este cliente' })
      continue
    }

    // Itens: o positivo é serviço; o negativo era o jeito de dar desconto no
    // módulo antigo — no Financeiro, desconto é um campo do documento.
    // Montados e conferidos ANTES da reserva: recusa não toca no antigo.
    const itensAntigos: any[] = Array.isArray(q.items) ? q.items : []
    let desconto = 0
    const itens = itensAntigos
      .filter(i => String(i?.label || '').trim())
      .flatMap(i => {
        const qtd = Math.max(1, Number(i.qty) || 1)
        const valor = round2(i.amount)
        if (valor < 0) { desconto = round2(desconto + Math.abs(valor) * qtd); return [] }
        return [{ description: String(i.label).trim(), qty: qtd, unitPrice: valor }]
      })
    if (!itens.length) itens.push({ description: 'Serviço — descrever', qty: 1, unitPrice: 0 })
    const subtotal = round2(itens.reduce((s, i) => s + i.qty * i.unitPrice, 0))
    const total = round2(subtotal - desconto)
    if (total < 0) { falhas.push({ id: q.id, cliente, motivo: 'o desconto é maior que os itens' }); continue }
    if (desconto > 0 && !perms.darDesconto) { falhas.push({ id: q.id, cliente, motivo: RECUSA.desconto }); continue }

    // Reserva: só um clique leva este orçamento.
    const { data: reservado, error: errReserva } = await db.from('quotes')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', q.id).in('status', ['draft', 'sent'])
      .select('id')
    if (errReserva) { falhas.push({ id: q.id, cliente, motivo: errReserva.message }); continue }
    if (!reservado?.length) continue   // outro clique já levou

    const desfazer = async (motivo: string) => {
      await db.from('quotes').update({ status: q.status, updated_at: new Date().toISOString() }).eq('id', q.id)
      falhas.push({ id: q.id, cliente, motivo })
    }

    const { data: num, error: errNum } = await db.rpc('next_invoice_number', { p_kind: 'estimate' })
    if (errNum) { await desfazer(`numeração: ${errNum.message}`); continue }

    const { data: novo, error: errNovo } = await db.from('invoices').insert({
      client_id: q.client_id, doc_type: 'estimate', number: num, status: 'draft',
      due_date: null, subtotal, discount: desconto, total, payment_plan: 'full',
      notes: q.fiscal_year ? `Declaração ${q.fiscal_year}.` : null,
      created_by: auth.userId,
    }).select('id, number').single()
    if (errNovo) { await desfazer(errNovo.message); continue }

    const { error: errItens } = await db.from('invoice_items').insert(itens.map((i, idx) => ({
      invoice_id: novo.id, service_id: null, description: i.description,
      qty: i.qty, unit_price: i.unitPrice, amount: round2(i.qty * i.unitPrice), sort: idx,
    })))
    if (errItens) {
      await db.from('invoices').delete().eq('id', novo.id)
      await desfazer(`itens: ${errItens.message}`)
      continue
    }

    await db.from('invoice_audit').insert({
      invoice_id: novo.id, action: 'created', performed_by: auth.userId,
      next: { number: novo.number, total, doModuloAntigo: q.id },
    }).then(() => null, () => null)
    await auditQuote({
      quoteId: q.id, action: 'cancelled', performedBy: auth.userId,
      reason: `Movido para o Financeiro como ${novo.number}`,
      previousState: { status: q.status, items: q.items, total: q.total },
      newState: { status: 'cancelled', movidoPara: novo.number },
    })
    movidos.push({ de: q.id, para: novo.number, cliente })
  }

  const partes = [
    movidos.length ? `${movidos.length} orçamento(s) trazido(s) para o Financeiro, como rascunho` : 'Nenhum orçamento trazido',
    falhas.length ? `${falhas.length} não vieram: ${falhas.map(f => `${f.cliente} (${f.motivo})`).join('; ')}` : '',
  ].filter(Boolean)
  return NextResponse.json({ ok: falhas.length === 0, movidos, falhas, message: partes.join(' · ') + '.' })
}
