// /api/caixa/contas — contas a pagar da firma (caixa diário)
//
// GET                     → contas abertas, aging, fornecedores e as pagas recentes
// POST { ...campos }      → cadastra a conta
// POST { sugerir: id }    → débitos do extrato que podem ser o pagamento dela
// PATCH { id, acao }      → 'pagar' (liga ao débito do banco) · 'cancelar' (com motivo)
//                           · 'editar' (enquanto aberta)
//
// SÓ O SÓCIO. É o dinheiro da firma.
//
// ISTO NÃO É CONTABILIDADE. O livro da firma é por regime de caixa e a
// despesa vem do extrato; uma conta a pagar nunca vira lançamento — se
// virasse, a mesma despesa entraria duas vezes. Pagar aqui só FECHA a conta
// e a amarra ao débito que já existe no banco.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { idDaFirma } from '@/lib/caixa-firma'
import { dataDaFirma } from '@/lib/dia-da-firma'
import {
  camposDaConta, criticarConta, situacaoDaConta, agingDePagar, candidatosParaConta,
} from '@/lib/contas-a-pagar'

export const dynamic = 'force-dynamic'

const SO_O_SOCIO = 'As contas a pagar da firma são do sócio. Fale com ele.'
const SEM_CAIXA  = 'O caixa da firma ainda não existe. Crie em Caixa da firma.'

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
  const hoje = dataDaFirma()

  const [contas, fornecedores] = await Promise.all([
    db.from('firm_bills')
      .select('id, payee, description, category, amount, issue_date, due_date, status, paid_tx_id, paid_at, cancel_reason, notes')
      .eq('client_id', firma).order('due_date').limit(2000),
    db.from('payees').select('name').eq('client_id', firma).eq('type', 'vendor')
      .eq('active', true).order('name').limit(1000),
  ])
  // Cada consulta responde pelo próprio erro: lista vazia na tela é uma
  // afirmação ("não há conta a pagar"), e o sócio acredita.
  if (contas.error)       return NextResponse.json({ error: `Contas: ${contas.error.message}` }, { status: 500 })
  if (fornecedores.error) return NextResponse.json({ error: `Fornecedores: ${fornecedores.error.message}` }, { status: 500 })

  const todas = (contas.data || []).map((c: any) => ({
    ...c, amount: Number(c.amount), situacao: situacaoDaConta(c, hoje),
  }))

  return NextResponse.json({
    hoje,
    abertas: todas.filter((c: any) => c.status === 'aberta'),
    // As últimas fechadas ficam à mão para desfazer um pagamento errado.
    fechadas: todas.filter((c: any) => c.status !== 'aberta')
      .sort((a: any, b: any) => String(b.paid_at || '').localeCompare(String(a.paid_at || '')))
      .slice(0, 30),
    aging: agingDePagar(todas, hoje),
    fornecedores: (fornecedores.data || []).map((p: any) => p.name),
  })
}

export async function POST(req: NextRequest) {
  const ctx = await socioEFirma()
  if ('erro' in ctx) return NextResponse.json({ error: ctx.erro }, { status: ctx.status })
  const { auth, db, firma } = ctx
  const body = await req.json().catch(() => ({} as any))

  if (body?.sugerir) return sugerir(db, firma, String(body.sugerir))

  // O corpo nunca vai inteiro para o banco: `status` e `paid_tx_id` vindos
  // de fora dariam conta "paga" sem débito nenhum no extrato.
  const campos = camposDaConta(body)
  const critica = criticarConta(campos)
  if (critica) return NextResponse.json({ error: critica }, { status: 400 })

  const { data, error } = await db.from('firm_bills')
    .insert({ ...campos, client_id: firma, status: 'aberta', created_by: auth.userId })
    .select('id').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // O fornecedor entra no cadastro que já existe (payees), não numa segunda
  // lista. Falhar aqui não desfaz a conta — mas aparece na resposta.
  const { error: errPayee } = await db.from('payees')
    .upsert({ client_id: firma, name: campos.payee, type: 'vendor' }, { onConflict: 'client_id,name' })

  return NextResponse.json({
    ok: true, id: data.id,
    aviso: errPayee ? `A conta foi criada, mas o fornecedor não entrou no cadastro: ${errPayee.message}` : null,
  })
}

export async function PATCH(req: NextRequest) {
  const ctx = await socioEFirma()
  if ('erro' in ctx) return NextResponse.json({ error: ctx.erro }, { status: ctx.status })
  const { db, firma } = ctx
  const b = await req.json().catch(() => ({} as any))
  const id = String(b?.id || '')
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  // ── Pagar: amarra a conta ao débito que JÁ está no extrato ────────────
  if (b.acao === 'pagar') {
    const txId = String(b.txId || '')
    if (!txId) return NextResponse.json({ error: 'Escolha o débito do extrato que pagou esta conta.' }, { status: 400 })

    const { data: tx, error: errTx } = await db.from('bank_transactions')
      .select('id, client_id, amount, tx_date').eq('id', txId).maybeSingle()
    if (errTx) return NextResponse.json({ error: errTx.message }, { status: 500 })
    if (!tx || tx.client_id !== firma) {
      return NextResponse.json({ error: 'Lançamento não encontrado no livro da firma.' }, { status: 404 })
    }
    if (Number(tx.amount) >= 0) {
      return NextResponse.json({ error: 'Esse lançamento é uma entrada, não um pagamento.' }, { status: 400 })
    }

    // `status = 'aberta'` no WHERE: duas abas abertas não pagam duas vezes.
    // O valor NÃO é conferido aqui de novo por acaso — a tela só oferece
    // débito do mesmo valor, e o índice único em paid_tx_id impede que o
    // mesmo débito pague duas contas.
    const { data, error } = await db.from('firm_bills')
      .update({ status: 'paga', paid_tx_id: txId, paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id).eq('client_id', firma).eq('status', 'aberta')
      .select('id, amount').maybeSingle()
    if (error) {
      // 23505 = o índice único: esse débito já fechou outra conta.
      if ((error as any).code === '23505') {
        return NextResponse.json({
          error: 'Esse débito do extrato já pagou outra conta. Um pagamento fecha uma conta só.',
        }, { status: 409 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Esta conta já estava paga ou cancelada. Recarregue a tela.' }, { status: 409 })

    const diferenca = Math.round((Math.abs(Number(tx.amount)) - Number(data.amount)) * 100) / 100
    return NextResponse.json({ ok: true, diferenca })
  }

  // ── Cancelar: preserva, não apaga ─────────────────────────────────────
  if (b.acao === 'cancelar') {
    const motivo = String(b.motivo || '').trim()
    if (motivo.length < 5) return NextResponse.json({ error: 'Diga por que está cancelando (mínimo 5 caracteres).' }, { status: 400 })
    const { data, error } = await db.from('firm_bills')
      .update({ status: 'cancelada', cancel_reason: motivo, updated_at: new Date().toISOString() })
      .eq('id', id).eq('client_id', firma).eq('status', 'aberta')
      .select('id').maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Só conta aberta pode ser cancelada.' }, { status: 409 })
    return NextResponse.json({ ok: true })
  }

  // ── Desfazer o pagamento ──────────────────────────────────────────────
  if (b.acao === 'reabrir') {
    const { data, error } = await db.from('firm_bills')
      .update({ status: 'aberta', paid_tx_id: null, paid_at: null, updated_at: new Date().toISOString() })
      .eq('id', id).eq('client_id', firma).neq('status', 'aberta')
      .select('id').maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Esta conta já está aberta.' }, { status: 409 })
    return NextResponse.json({ ok: true })
  }

  // ── Editar, enquanto aberta ───────────────────────────────────────────
  if (b.acao === 'editar') {
    const campos = camposDaConta(b)
    if (Object.keys(campos).length === 0) return NextResponse.json({ error: 'Nada a alterar.' }, { status: 400 })
    const { data: atual, error: errAtual } = await db.from('firm_bills')
      .select('payee, amount, due_date, issue_date').eq('id', id).eq('client_id', firma).maybeSingle()
    if (errAtual) return NextResponse.json({ error: errAtual.message }, { status: 500 })
    if (!atual) return NextResponse.json({ error: 'Conta não encontrada.' }, { status: 404 })
    const critica = criticarConta({ ...atual, ...campos })
    if (critica) return NextResponse.json({ error: critica }, { status: 400 })

    const { data, error } = await db.from('firm_bills')
      .update({ ...campos, updated_at: new Date().toISOString() })
      .eq('id', id).eq('client_id', firma).eq('status', 'aberta')
      .select('id').maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Conta paga ou cancelada não se edita — reabra antes.' }, { status: 409 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Ação desconhecida.' }, { status: 400 })
}

/** Débitos do extrato que podem ser o pagamento desta conta. Só leitura. */
async function sugerir(db: any, firma: string, id: string) {
  const { data: conta, error } = await db.from('firm_bills')
    .select('id, payee, amount, due_date, status').eq('id', id).eq('client_id', firma).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!conta) return NextResponse.json({ error: 'Conta não encontrada.' }, { status: 404 })

  const [lancamentos, jaUsados] = await Promise.all([
    db.from('bank_transactions')
      .select('id, tx_date, description, payee, amount')
      .eq('client_id', firma).lt('amount', 0).order('tx_date', { ascending: false }).limit(3000),
    db.from('firm_bills').select('paid_tx_id').eq('client_id', firma).not('paid_tx_id', 'is', null).limit(5000),
  ])
  if (lancamentos.error) return NextResponse.json({ error: `Extrato: ${lancamentos.error.message}` }, { status: 500 })
  if (jaUsados.error)    return NextResponse.json({ error: `Pagamentos: ${jaUsados.error.message}` }, { status: 500 })

  // Um débito paga UMA conta: o que já fechou outra sai da lista aqui, e o
  // índice único no banco é quem garante de verdade.
  const usados = new Set((jaUsados.data || []).map((x: any) => x.paid_tx_id))
  const lista = (lancamentos.data || []).map((t: any) => ({
    ...t, amount: Number(t.amount), bill_id: usados.has(t.id) ? 'outra' : null,
  }))

  return NextResponse.json({
    candidatos: candidatosParaConta(conta as any, lista).slice(0, 20),
    total: lista.length,
  })
}
