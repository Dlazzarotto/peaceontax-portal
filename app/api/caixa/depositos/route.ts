// /api/caixa/depositos — conciliar o que entrou no banco com os recebimentos
//
// GET                      → sincroniza os recebimentos, lista o que está em
//                            trânsito e os depósitos ainda não explicados
// POST { sugerir: <txId> } → pergunta ao Stripe o que veio dentro daquele
//                            repasse e propõe os recebimentos que o formam
//                            (é POST porque chama o Stripe e demora; não grava nada)
// POST { depositoId, recebimentos[], contaDaTaxa? } → concilia (RPC atômica)
// DELETE ?id=<txId>        → desfaz a conciliação
//
// SÓ O SÓCIO. É o livro fiscal da própria firma.
//
// A conta é feita NO BANCO (`conciliar_deposito`): a tela manda ids, o banco
// soma e decide quanto sobra de taxa. Número vindo do navegador não lança
// despesa.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { idDaFirma } from '@/lib/caixa-firma'
import { sincronizarRecebimentos } from '@/lib/caixa-recebimentos'
import { conferirDeposito, casarRepasse, CONTA_DA_TAXA, CONTA_DO_DEPOSITO } from '@/lib/deposito-match'
import { stripeDaFirma, repassesRecentes, repasseDoDeposito, detalharRepasse } from '@/lib/stripe-repasse'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const SO_O_SOCIO = 'O caixa da firma é do sócio. Fale com ele.'
const SEM_CAIXA = 'O caixa da firma ainda não existe. Crie em Caixa da firma.'

async function socioEFirma() {
  const auth = await getAuth()
  if (!auth?.isStaff) return { erro: SO_O_SOCIO, status: 403 as const }
  if ((await getStaffLevel(auth.userId)) !== 'owner') return { erro: SO_O_SOCIO, status: 403 as const }
  const db = serviceDb()
  const firma = await idDaFirma(db)
  if (!firma) return { erro: SEM_CAIXA, status: 400 as const }
  return { auth, db, firma }
}

export async function GET() {
  const ctx = await socioEFirma()
  if ('erro' in ctx) return NextResponse.json({ error: ctx.erro }, { status: ctx.status })
  const { db, firma } = ctx

  const sincronia = await sincronizarRecebimentos(db, firma)
  if (sincronia.erro) return NextResponse.json({ error: sincronia.erro }, { status: 500 })
  const passagem = sincronia.contaDePassagem

  const [emTransito, movimento] = await Promise.all([
    db.from('bank_transactions')
      .select('id, tx_date, description, amount, payment_id')
      .eq('client_id', firma).not('payment_id', 'is', null).is('deposit_tx_id', null)
      .order('tx_date').limit(2000),
    // Tudo o que entrou nas contas de banco (a de passagem fica de fora) e
    // tudo o que já foi conciliado, para saber o que sobra.
    db.from('bank_transactions')
      .select('id, tx_date, description, amount, account_id, category, status, deposit_tx_id')
      .eq('client_id', firma).gt('amount', 0).order('tx_date', { ascending: false }).limit(2000),
  ])
  if (emTransito.error) return NextResponse.json({ error: `Em trânsito: ${emTransito.error.message}` }, { status: 500 })
  if (movimento.error)  return NextResponse.json({ error: `Extrato: ${movimento.error.message}` }, { status: 500 })

  const conciliados = new Set((movimento.data || []).map((t: any) => t.deposit_tx_id).filter(Boolean))
  const depositos = (movimento.data || [])
    .filter((t: any) => t.account_id !== passagem)
    .filter((t: any) => !conciliados.has(t.id))
    .map((t: any) => ({
      id: t.id, data: t.tx_date, descricao: t.description, valor: Number(t.amount),
      pareceStripe: /stripe/i.test(String(t.description || '')),
    }))

  // Os já conciliados ficam à mão para DESFAZER: o sócio vai errar a
  // seleção, e sem isto a única saída seria SQL na mão.
  const conciliados_ = (movimento.data || [])
    .filter((t: any) => t.account_id !== passagem && conciliados.has(t.id))
    .slice(0, 20)
    .map((t: any) => ({ id: t.id, data: t.tx_date, descricao: t.description, valor: Number(t.amount) }))

  const transito = (emTransito.data || []).map((t: any) => ({
    id: t.id, data: t.tx_date, descricao: t.description, valor: Number(t.amount),
  }))

  return NextResponse.json({
    sincronia: { criados: sincronia.criados, removidos: sincronia.removidos, avisos: sincronia.avisos },
    transito,
    saldoEmTransito: Math.round(transito.reduce((s: number, t: any) => s + t.valor, 0) * 100) / 100,
    depositos,
    conciliados: conciliados_,
    contaDaTaxa: CONTA_DA_TAXA,
    contaDoDeposito: CONTA_DO_DEPOSITO,
    stripeConfigurado: Boolean(process.env.STRIPE_SECRET_KEY),
  })
}

// ── A sugestão: o que o Stripe diz que veio dentro do repasse ────────────
export async function POST(req: NextRequest) {
  const ctx = await socioEFirma()
  if ('erro' in ctx) return NextResponse.json({ error: ctx.erro }, { status: ctx.status })
  const { db, firma } = ctx
  const body = await req.json().catch(() => ({} as any))

  // POST { sugerir: txId } → proposta, sem gravar nada
  if (body?.sugerir) return sugerir(db, firma, String(body.sugerir))

  const depositoId = String(body?.depositoId || '')
  const recebimentos: string[] = Array.isArray(body?.recebimentos) ? body.recebimentos.map(String) : []
  if (!depositoId) return NextResponse.json({ error: 'depositoId obrigatório' }, { status: 400 })
  if (recebimentos.length === 0) {
    return NextResponse.json({ error: 'Escolha os recebimentos que compõem este depósito.' }, { status: 400 })
  }

  const { data, error } = await db.rpc('conciliar_deposito', {
    p_deposito: depositoId,
    p_recebimentos: recebimentos,
    p_conta_taxa: String(body?.contaDaTaxa || CONTA_DA_TAXA),
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const r = Array.isArray(data) ? data[0] : data
  if (!r?.ok) return NextResponse.json({ error: explicar(r?.motivo), motivo: r?.motivo }, { status: 409 })

  return NextResponse.json({
    ok: true, bruto: Number(r.bruto), taxa: Number(r.taxa), transferencia: r.transferencia,
  })
}

export async function DELETE(req: NextRequest) {
  const ctx = await socioEFirma()
  if ('erro' in ctx) return NextResponse.json({ error: ctx.erro }, { status: ctx.status })
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const { data, error } = await ctx.db.rpc('desconciliar_deposito', { p_deposito: id })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const r = Array.isArray(data) ? data[0] : data
  if (!r?.ok) return NextResponse.json({ error: explicar(r?.motivo), motivo: r?.motivo }, { status: 409 })
  return NextResponse.json({ ok: true, soltos: Number(r.soltos) })
}

async function sugerir(db: any, firma: string, txId: string) {
  const { data: dep, error } = await db.from('bank_transactions')
    .select('id, tx_date, description, amount, client_id').eq('id', txId).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!dep || dep.client_id !== firma) return NextResponse.json({ error: 'Depósito não encontrado' }, { status: 404 })

  const { data: transito, error: errT } = await db.from('bank_transactions')
    .select('id, amount, payment_id')
    .eq('client_id', firma).not('payment_id', 'is', null).is('deposit_tx_id', null).limit(2000)
  if (errT) return NextResponse.json({ error: `Em trânsito: ${errT.message}` }, { status: 500 })

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: 'Stripe não está configurado no servidor (falta STRIPE_SECRET_KEY).' }, { status: 400 })
  }

  let detalhe, repasse
  try {
    const stripe = stripeDaFirma()
    const achado = repasseDoDeposito(await repassesRecentes(stripe, 50), Number(dep.amount), String(dep.tx_date))
    if (achado.motivo) return NextResponse.json({ error: achado.motivo }, { status: 409 })
    if (!achado.repasse) {
      return NextResponse.json({
        error: `Nenhum repasse do Stripe de ${dep.amount} por volta de ${dep.tx_date}. ` +
               'Se este depósito é de cheque ou Zelle, escolha os recebimentos à mão.',
      }, { status: 404 })
    }
    repasse = achado.repasse
    detalhe = await detalharRepasse(stripe, repasse.id)
  } catch (e) {
    return NextResponse.json({ error: `Stripe: ${(e as Error).message}` }, { status: 502 })
  }

  // Os recebimentos em trânsito que têm a chave de cobrança deste repasse.
  const { data: chaves, error: errC } = await db.from('invoice_payments')
    .select('id, stripe_object, reference')
    .in('id', (transito || []).map((t: any) => t.payment_id).slice(0, 1000))
  if (errC) return NextResponse.json({ error: `Recebimentos: ${errC.message}` }, { status: 500 })

  const casamento = casarRepasse(detalhe.chaves, (chaves || []) as any)
  const porPagamento = new Map((transito || []).map((t: any) => [t.payment_id, t]))
  const propostos = casamento.casados.map(pid => porPagamento.get(pid)).filter(Boolean)

  const conferencia = conferirDeposito(Number(dep.amount), propostos as any)

  return NextResponse.json({
    repasse: { id: repasse.id, chegadaEm: repasse.chegadaEm, valor: repasse.valor },
    detalhe: {
      bruto: detalhe.bruto, taxa: detalhe.taxa,
      reembolsos: detalhe.reembolsos, outros: detalhe.outros, liquido: detalhe.liquido,
      cobrancas: detalhe.itens.filter(i => i.tipo === 'charge' || i.tipo === 'payment').length,
    },
    // Cobrança que o Stripe repassou e que NÃO tem recebimento lançado: é
    // fatura paga que ninguém baixou. Sem isto, a diferença viraria "taxa".
    semRecebimento: casamento.semRecebimento.length,
    selecionar: (propostos as any[]).map(t => t.id),
    conferencia,
    aviso: detalhe.reembolsos < 0
      ? `Este repasse tem ${Math.abs(detalhe.reembolsos).toFixed(2)} de reembolso a cliente. ` +
        'Devolução não é taxa — registre o estorno da fatura antes de conciliar, senão a ' +
        'devolução entra no livro como despesa de processamento.'
      : null,
  })
}

function explicar(motivo: string | undefined): string {
  switch (motivo) {
    case 'ja_conciliado':        return 'Este depósito já foi conciliado. Desfaça antes de refazer.'
    case 'nao_e_deposito':       return 'Este lançamento é uma saída, não um depósito.'
    case 'falta_recebimento':    return 'O depósito é maior que os recebimentos escolhidos — há pagamento neste depósito que não está lançado em fatura nenhuma. Lance o recebimento antes de conciliar.'
    case 'recebimento_invalido': return 'Algum recebimento escolhido já foi depositado ou não é do caixa da firma. Recarregue a tela.'
    case 'sem_recebimentos':     return 'Escolha os recebimentos que compõem este depósito.'
    case 'deposito_nao_encontrado': return 'Depósito não encontrado.'
    case 'nao_estava_conciliado': return 'Este depósito não estava conciliado.'
    default: return `Não foi possível conciliar (${motivo || 'motivo desconhecido'}).`
  }
}
