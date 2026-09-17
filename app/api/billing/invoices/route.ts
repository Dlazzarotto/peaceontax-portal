// /api/billing/invoices
//
// GET    ?doc=&status=&clientId=   → lista + clientes + suas permissões
// POST   { clientId, docType, dueDate, paymentPlan, expectedMethod, discount, notes, items[] }
// PATCH  { id, action: 'send' | 'resend' | 'cancel' | 'duplicate' | 'edit' }
//          resend → repete o AVISO da fatura ao cliente (e-mail + portal), sem
//                   mexer no status; serve à fatura que nasceu enviada pelo Stripe
//          remind → LEMBRETE DE COBRANÇA: outro texto, sabe se está vencida
// DELETE ?id=
//
// Permissões (lib/billing-perms):
//   assistente → SÓ cria (nasce rascunho), e a LISTA mostra apenas as
//                faturas que ele mesmo emitiu HOJE — no dia seguinte zera.
//                Quem emite não precisa da carteira inteira à vista.
//   gerente    → envia, reenvia, recebe, duplica, cancela, apaga
//   sócio      → tudo + relatórios
//
// O corte do dia é o do ESCRITÓRIO (lib/dia-da-firma.ts), não o do servidor:
// às 20h de Malden já é o dia seguinte em UTC, e a lista zeraria no meio do
// expediente da temporada. Soltar a lista inteira para alguém é autorização
// individual (`verTodasFaturas`), sem promover de nível.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { permissoesFinanceiro, RECUSA } from '@/lib/billing-perms'
import { enviarEmail, avisarNoPortal, emailComMarca, APP_URL } from '@/lib/avisos'
import { fmtUS, money } from '@/lib/format'
import Stripe from 'stripe'
import { parcelamentoVivo, encerrarParcelamento } from '@/lib/parcelamento'
import { achEmTransito, diasEmTransito } from '@/lib/ach-transito'
import { corteDeHoje, dataDaFirma } from '@/lib/dia-da-firma'

export const dynamic = 'force-dynamic'

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)

  const sp = req.nextUrl.searchParams
  const db = serviceDb()

  // Uma fatura específica, com itens — usado pela tela de edição
  const umId = sp.get('id')
  if (umId) {
    const [{ data: doc }, { data: itens }] = await Promise.all([
      db.from('invoices').select('*').eq('id', umId).single(),
      db.from('invoice_items').select('*').eq('invoice_id', umId).order('sort'),
    ])
    if (!doc) return NextResponse.json({ error: 'Documento não encontrado' }, { status: 404 })
    // Filtrar a lista e deixar ?id= aberto seria fechar a porta e esquecer a
    // janela: bastaria o id para ver qualquer fatura da carteira.
    if (!perms.verTodasFaturas && doc.created_by !== auth.userId) {
      return NextResponse.json({ error: 'Documento não encontrado' }, { status: 404 })
    }
    return NextResponse.json({ invoice: doc, items: itens || [], perms })
  }

  let q = db.from('invoices')
    .select('id, client_id, doc_type, number, status, issue_date, due_date, total, paid_total, payment_plan, expected_method, financier, notes, ach_desde, ach_valor, clients(business_name, name)')
    .order('issue_date', { ascending: false })
    .order('number', { ascending: false })
    .limit(400)

  // Sem `verTodasFaturas`: só o que a própria pessoa emitiu hoje.
  // A trava é daqui, não da tela — a rota responde a quem a chamar direto.
  if (!perms.verTodasFaturas) {
    q = q.eq('created_by', auth.userId).gte('created_at', corteDeHoje())
  }

  if (sp.get('doc')) q = q.eq('doc_type', sp.get('doc'))
  if (sp.get('status')) q = q.eq('status', sp.get('status'))
  if (sp.get('clientId')) q = q.eq('client_id', sp.get('clientId'))

  const [{ data: invoices, error }, { data: clients }, { data: services }] = await Promise.all([
    q,
    db.from('clients').select('id, business_name, name').eq('active', true).order('name'),
    db.from('pricing_items').select('id, code, label, amount, kind').eq('active', true).order('sort').order('label'),
  ])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    invoices: (invoices || []).map((i: any) => ({
      ...i,
      cliente: i.clients?.business_name || i.clients?.name || '—',
      saldo: round2(Number(i.total) - Number(i.paid_total)),
    })),
    clients: (clients || []).map((c: any) => ({ id: c.id, nome: c.business_name || c.name })),
    // Catálogo de preços (tela Preços) — fonte única para os itens da fatura
    services: (services || []).map((x: any) => ({
      id: x.id, nome: x.label, preco: Number(x.amount) || 0, code: x.code, kind: x.kind,
    })),
    perms,
    // A tela precisa dizer POR QUE a lista está curta, senão parece defeito.
    escopo: perms.verTodasFaturas
      ? null
      : { apenasMinhas: true, dia: dataDaFirma() },
  })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)

  const b = await req.json()
  const itens = Array.isArray(b.items) ? b.items.filter((i: any) => String(i.description || '').trim()) : []
  if (!b.clientId) return NextResponse.json({ error: 'Escolha o cliente.' }, { status: 400 })
  if (itens.length === 0) return NextResponse.json({ error: 'Inclua ao menos um item.' }, { status: 400 })

  const docType = b.docType === 'estimate' ? 'estimate' : 'invoice'
  const desconto = perms.darDesconto ? round2(b.discount) : 0
  if (!perms.darDesconto && Number(b.discount) > 0) {
    return NextResponse.json({ error: RECUSA.desconto }, { status: 403 })
  }

  const subtotal = round2(itens.reduce((s: number, i: any) =>
    s + (Number(i.qty) || 1) * (Number(i.unitPrice) || 0), 0))
  const total = round2(subtotal - desconto)
  if (total < 0) return NextResponse.json({ error: 'O desconto é maior que o valor dos itens.' }, { status: 400 })

  const db = serviceDb()
  const { data: num, error: numErr } = await db.rpc('next_invoice_number', { p_kind: docType })
  if (numErr) return NextResponse.json({ error: `Numeração: ${numErr.message}` }, { status: 500 })

  const { data: inv, error } = await db.from('invoices').insert({
    client_id: b.clientId,
    doc_type: docType,
    number: num,
    status: 'draft',                       // nasce rascunho, sempre
    due_date: b.dueDate || null,
    subtotal, discount: desconto, total,
    payment_plan: b.paymentPlan || 'full',
    expected_method: b.expectedMethod || null,
    financier: b.financier || null,
    notes: b.notes || null,
    created_by: auth.userId,
  }).select('id, number').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // O item guarda descrição e preço praticados. A referência ao catálogo é
  // apenas informativa — se o id não existir mais, gravamos sem ela em vez
  // de derrubar a fatura inteira por integridade referencial.
  const idsPedidos = itens.map((i: any) => i.serviceId).filter(Boolean)
  let idsValidos = new Set<string>()
  if (idsPedidos.length) {
    const { data: cat } = await db.from('pricing_items').select('id').in('id', idsPedidos)
    idsValidos = new Set((cat || []).map((c: any) => c.id))
  }

  const linhas = itens.map((i: any, idx: number) => ({
    invoice_id: inv.id,
    service_id: i.serviceId && idsValidos.has(i.serviceId) ? i.serviceId : null,
    description: String(i.description).trim(),
    qty: Number(i.qty) || 1,
    unit_price: round2(i.unitPrice),
    amount: round2((Number(i.qty) || 1) * (Number(i.unitPrice) || 0)),
    sort: idx,
  }))
  const { error: itErr } = await db.from('invoice_items').insert(linhas)
  if (itErr) {
    // Sem itens a fatura não serve para nada: desfaz para não sobrar documento vazio
    await db.from('invoices').delete().eq('id', inv.id)
    return NextResponse.json({ error: `Itens: ${itErr.message}` }, { status: 500 })
  }

  // ── Parcelamento: gera o cronograma ──
  let parcelas = 0
  if (b.paymentPlan === 'installments') {
    const n = Math.max(2, Math.min(36, Number(b.installments) || 0))
    if (!b.firstDueDate) {
      return NextResponse.json({ error: 'Informe o vencimento da primeira parcela.' }, { status: 400 })
    }
    if (!['card', 'ach'].includes(String(b.expectedMethod || ''))) {
      return NextResponse.json({
        error: 'Parcelamento exige cartão ou débito em conta (ACH). Dinheiro, Zelle e Venmo são à vista.',
      }, { status: 400 })
    }

    const base = Math.floor((total / n) * 100) / 100
    const linhas: any[] = []
    for (let i = 0; i < n; i++) {
      const d = new Date(`${b.firstDueDate}T12:00:00Z`)
      d.setMonth(d.getMonth() + i)
      linhas.push({
        invoice_id: inv.id,
        seq: i + 1,
        due_date: d.toISOString().slice(0, 10),
        // a última parcela absorve o centavo da divisão
        amount: i === n - 1 ? round2(total - base * (n - 1)) : base,
      })
    }
    const { error: pErr } = await db.from('invoice_installments').insert(linhas)
    if (pErr) return NextResponse.json({ error: `Parcelas: ${pErr.message}` }, { status: 500 })
    parcelas = n
    await db.from('invoices').update({ due_date: linhas[0].due_date }).eq('id', inv.id)
  }

  await db.from('invoice_audit').insert({
    invoice_id: inv.id, action: 'created', performed_by: auth.userId,
    staff_level: perms.nivel, next: { number: inv.number, total },
  }).then(() => null, () => null)

  // ── Criar e enviar num passo ──
  // O documento continua NASCENDO rascunho: o assistente preenche e alguém
  // confere antes de o cliente ver. Mas para quem já pode enviar, obrigar a
  // criar, achar na lista e clicar Enviar são três passos no balcão com fila.
  // Quem não pode enviar não perde o trabalho: o rascunho fica salvo.
  let envio = ''
  let aviso: string | null = null
  if (b.enviarAgora) {
    if (!perms.enviar) {
      aviso = RECUSA.enviar
    } else {
      const { data: cheia } = await db.from('invoices').select('*').eq('id', inv.id).single()
      await db.from('invoices')
        .update({ status: 'sent', updated_at: new Date().toISOString() }).eq('id', inv.id)
      await db.from('invoice_audit').insert({
        invoice_id: inv.id, action: 'sent', performed_by: auth.userId, staff_level: perms.nivel,
      }).then(() => null, () => null)
      const r = await avisarClienteDaFatura(db, cheia)
      envio = r.email
        ? ' e enviado ao cliente (e-mail e portal)'
        : r.motivo
          ? ` e enviado (portal; e-mail não saiu: ${r.motivo})`
          : ' e enviado ao cliente (portal)'
    }
  }

  const doc = docType === 'estimate' ? 'Orçamento' : 'Fatura'
  const partes = [
    `${doc} ${inv.number} ${envio ? `criado${envio}` : 'criado como rascunho'}`,
    parcelas ? `${parcelas} parcelas geradas` : '',
  ].filter(Boolean)

  return NextResponse.json({
    ok: true, id: inv.id, number: inv.number, enviado: !!envio,
    message: partes.join(' · ') + '.',
    // Rascunho salvo mas sem permissão para enviar: o trabalho não se perde,
    // e a tela diz o que fazer em vez de fingir que deu tudo certo.
    aviso,
  })
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)

  // Ler o corpo UMA vez: depois de consumido não dá para clonar
  const corpo = (await req.json()) as any
  const { id, action } = corpo
  if (!id || !action) return NextResponse.json({ error: 'id e action obrigatórios' }, { status: 400 })

  const db = serviceDb()
  const { data: inv } = await db.from('invoices').select('*').eq('id', id).single()
  if (!inv) return NextResponse.json({ error: 'Documento não encontrado' }, { status: 404 })

  if (action === 'send') {
    // Estava preso a `perms.cancelar`. Dava no mesmo enquanto tudo era por
    // nível; com autorização individual, soltar cancelar soltava o envio
    // junto, e retirar cancelar tirava o envio sem ninguém entender por quê.
    if (!perms.enviar) return NextResponse.json({ error: RECUSA.enviar }, { status: 403 })
    if (inv.status !== 'draft') return NextResponse.json({ error: 'Só rascunho pode ser enviado.' }, { status: 400 })
    await db.from('invoices').update({ status: 'sent', updated_at: new Date().toISOString() }).eq('id', id)
    await db.from('invoice_audit').insert({ invoice_id: id, action: 'sent', performed_by: auth.userId, staff_level: perms.nivel }).then(() => null, () => null)

    // O cliente recebe na hora: aviso no portal e e-mail com o caminho para pagar.
    // Em Pagamentos ele escolhe cartão, débito em conta ou Klarna num link só.
    const aviso = await avisarClienteDaFatura(db, inv)
    return NextResponse.json({ ok: true, message: `${inv.number} enviado ao cliente${aviso.email ? ' (e-mail e portal)' : aviso.motivo ? ` (portal; e-mail não enviado: ${aviso.motivo})` : ' (portal)'}.` })
  }

  // Reenviar ao cliente: e-mail perdido, caixa de spam, cliente trocou de
  // e-mail, ou a fatura nasceu já enviada (mensalidade vinda do Stripe, que
  // nunca passa por rascunho e por isso nunca teve o botão Enviar).
  // NÃO mexe no status nem em valor: só repete o aviso.
  if (action === 'resend' || action === 'remind') {
    const lembrete = action === 'remind'
    if (!perms.cancelar) {
      return NextResponse.json({ error: `${lembrete ? 'Cobrar' : 'Reenviar'} ao cliente é de gerente ou sócio.` }, { status: 403 })
    }
    if (inv.status === 'draft') {
      return NextResponse.json({ error: 'Ainda é rascunho — use Enviar.' }, { status: 400 })
    }
    if (inv.status === 'void') {
      return NextResponse.json({ error: 'Fatura cancelada não vai ao cliente.' }, { status: 409 })
    }
    const saldoAberto = Math.round((Number(inv.total) - Number(inv.paid_total || 0)) * 100) / 100
    if (saldoAberto <= 0) {
      return NextResponse.json({
        error: 'Fatura quitada: não há o que cobrar. Para mandar o documento ao cliente, use Imprimir.',
      }, { status: 409 })
    }

    // Débito em conta a caminho: cobrar quem já mandou o dinheiro é o tipo de
    // mensagem que custa cliente. Reenviar o documento continua liberado.
    const transito = achEmTransito(inv)
    if (lembrete && transito) {
      const dias = diasEmTransito(transito.desde)
      return NextResponse.json({
        error: `${inv.number} tem um débito em conta de $${transito.valor.toFixed(2)} a caminho há ${dias} dia(s)`
          + ' — o cliente já pagou e o banco ainda não confirmou. Cobrar agora seria cobrar duas vezes.'
          + ' Use Reenviar se ele só quer o documento.',
      }, { status: 409 })
    }

    // Quantas vezes o cliente já foi avisado desta fatura — a equipe vê o
    // número antes de insistir de novo.
    const { count: jaAvisado } = await db.from('invoice_audit')
      .select('id', { count: 'exact', head: true })
      .eq('invoice_id', id).in('action', ['sent', 'resent', 'reminded'])

    const aviso = await avisarClienteDaFatura(db, inv, lembrete ? 'lembrete' : 'envio')
    await db.from('invoice_audit').insert({
      invoice_id: id, action: lembrete ? 'reminded' : 'resent',
      performed_by: auth.userId, staff_level: perms.nivel,
      next: { email: aviso.email, motivo: aviso.motivo || null, avisoNumero: (jaAvisado ?? 0) + 1 },
    }).then(() => null, () => null)

    return NextResponse.json({
      ok: true,
      message: `${inv.number}: ${lembrete ? 'lembrete de cobrança enviado' : 'reenviado'} ao cliente`
        + (aviso.email ? ' (e-mail e portal)' : aviso.motivo ? ` (portal; e-mail não enviado: ${aviso.motivo})` : ' (portal)')
        + ` · ${(jaAvisado ?? 0) + 1}º aviso desta fatura`,
    })
  }

  if (action === 'cancel') {
    if (!perms.cancelar) return NextResponse.json({ error: RECUSA.cancelar }, { status: 403 })
    if (Number(inv.paid_total) > 0) {
      return NextResponse.json({ error: 'Já há pagamento registrado. Estorne o pagamento antes de cancelar.' }, { status: 409 })
    }

    // A fatura pode ter parcelamento com débito automático vivo no Stripe.
    // Cancelar só o documento deixava o débito correndo: o cliente seguia
    // sendo cobrado mês a mês por uma fatura anulada, e não havia saída pela
    // tela — receber é recusado em fatura cancelada, e parcelamento em
    // andamento não se cancela. Aqui os dois terminam juntos.
    const plano = await parcelamentoVivo(db, id)
    let notaPlano = ''
    if (plano) {
      if (Number(plano.paid_installments || 0) > 0) {
        return NextResponse.json({
          error: `Este parcelamento já teve ${plano.paid_installments} parcela(s) paga(s). Fatura com dinheiro recebido não se cancela: quite o saldo restante (quitação antecipada) ou estorne os pagamentos antes.`,
        }, { status: 409 })
      }
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' as Stripe.LatestApiVersion })
      const r = await encerrarParcelamento(db, stripe, plano, id,
        { motivo: 'fatura_cancelada', performedBy: auth.userId })
      notaPlano = r.nota
    }

    await db.from('invoices').update({
      status: 'void', payment_plan: 'full', updated_at: new Date().toISOString(),
    }).eq('id', id)
    await db.from('invoice_audit').insert({
      invoice_id: id, action: 'canceled', performed_by: auth.userId, staff_level: perms.nivel,
      previous: { status: inv.status },
      next: plano ? { parcelamento_encerrado: plano.id } : null,
    }).then(() => null, () => null)
    return NextResponse.json({ ok: true, message: `${inv.number} cancelado (permanece no histórico)${notaPlano}.` })
  }

  if (action === 'edit') {
    if (!perms.editar) return NextResponse.json({ error: RECUSA.editar }, { status: 403 })
    if (Number(inv.paid_total) > 0) {
      return NextResponse.json({
        error: 'Fatura com pagamento registrado não pode ser editada. Estorne o pagamento ou emita nota de ajuste.',
      }, { status: 409 })
    }
    if (inv.status === 'void') {
      return NextResponse.json({ error: 'Fatura cancelada não pode ser editada.' }, { status: 409 })
    }

    const b2 = corpo
    const motivo = String(b2.reason || '').trim()

    // Gerente confirma com senha e justifica; sócio edita direto
    if (perms.senhaNaEdicao) {
      if (motivo.length < 5) {
        return NextResponse.json({ error: 'Descreva o motivo da alteração (mínimo 5 caracteres).' }, { status: 400 })
      }
      if (!b2.password) return NextResponse.json({ error: 'Confirme com a sua senha.' }, { status: 400 })

      const { data: quem } = await db.auth.admin.getUserById(auth.userId)
      const email = quem?.user?.email
      if (!email) return NextResponse.json({ error: 'Não foi possível identificar seu login.' }, { status: 400 })

      const sbAuth = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      )
      const { error: pwErr } = await sbAuth.auth.signInWithPassword({
        email, password: String(b2.password).trim(),
      })
      if (pwErr) {
        const m = pwErr.message || ''
        if (/rate|too many|429/i.test(m)) {
          return NextResponse.json({ error: 'Muitas tentativas. Aguarde 1 minuto.' }, { status: 429 })
        }
        return NextResponse.json({ error: `Senha não confere para ${email}.` }, { status: 401 })
      }
    }

    const itens2 = Array.isArray(b2.items)
      ? b2.items.filter((i: any) => String(i.description || '').trim()) : []
    if (itens2.length === 0) return NextResponse.json({ error: 'A fatura precisa de ao menos um item.' }, { status: 400 })

    const desconto2 = perms.darDesconto ? round2(b2.discount) : Number(inv.discount)
    const subtotal2 = round2(itens2.reduce((s2: number, i: any) =>
      s2 + (Number(i.qty) || 1) * (Number(i.unitPrice) || 0), 0))
    const total2 = round2(subtotal2 - desconto2)
    if (total2 < 0) return NextResponse.json({ error: 'O desconto é maior que o valor dos itens.' }, { status: 400 })

    const anterior = { total: Number(inv.total), discount: Number(inv.discount), due_date: inv.due_date, notes: inv.notes }

    const { error: upErr } = await db.from('invoices').update({
      due_date: b2.dueDate || null,
      subtotal: subtotal2, discount: desconto2, total: total2,
      expected_method: b2.expectedMethod || null,
      notes: b2.notes ?? inv.notes,
      updated_at: new Date().toISOString(),
    }).eq('id', id)
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

    // Itens são reescritos: mais simples e sem risco de sobra
    await db.from('invoice_items').delete().eq('invoice_id', id)
    const idsPedidos2 = itens2.map((i: any) => i.serviceId).filter(Boolean)
    let validos2 = new Set<string>()
    if (idsPedidos2.length) {
      const { data: cat } = await db.from('pricing_items').select('id').in('id', idsPedidos2)
      validos2 = new Set((cat || []).map((c: any) => c.id))
    }
    await db.from('invoice_items').insert(itens2.map((i: any, idx: number) => ({
      invoice_id: id,
      service_id: i.serviceId && validos2.has(i.serviceId) ? i.serviceId : null,
      description: String(i.description).trim(),
      qty: Number(i.qty) || 1,
      unit_price: round2(i.unitPrice),
      amount: round2((Number(i.qty) || 1) * (Number(i.unitPrice) || 0)),
      sort: idx,
    })))

    await db.from('invoice_audit').insert({
      invoice_id: id, action: 'edited', performed_by: auth.userId,
      staff_level: perms.nivel, reason: motivo || null,
      previous: anterior, next: { total: total2, discount: desconto2, due_date: b2.dueDate || null },
    }).then(() => null, () => null)

    return NextResponse.json({ ok: true, message: `${inv.number} atualizada (${total2.toFixed(2)}).` })
  }

  if (action === 'duplicate') {
    if (!perms.duplicar) return NextResponse.json({ error: RECUSA.duplicar }, { status: 403 })
    const { data: num } = await db.rpc('next_invoice_number', { p_kind: inv.doc_type })
    const { data: novo, error } = await db.from('invoices').insert({
      client_id: inv.client_id, doc_type: inv.doc_type, number: num, status: 'draft',
      due_date: null, subtotal: inv.subtotal, discount: inv.discount, total: inv.total,
      payment_plan: inv.payment_plan, expected_method: inv.expected_method,
      financier: inv.financier, notes: inv.notes, converted_from: inv.id, created_by: auth.userId,
    }).select('id, number').single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const { data: itens } = await db.from('invoice_items').select('*').eq('invoice_id', id)
    if (itens && itens.length) {
      await db.from('invoice_items').insert(itens.map((i: any) => ({
        invoice_id: novo.id, service_id: i.service_id, description: i.description,
        qty: i.qty, unit_price: i.unit_price, amount: i.amount, sort: i.sort,
      })))
    }
    return NextResponse.json({ ok: true, message: `Cópia criada: ${novo.number} (rascunho).` })
  }

  return NextResponse.json({ error: 'Ação desconhecida' }, { status: 400 })
}

export async function DELETE(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  if (!perms.apagar) return NextResponse.json({ error: RECUSA.apagar }, { status: 403 })

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: inv } = await db.from('invoices').select('number, paid_total').eq('id', id).single()
  if (!inv) return NextResponse.json({ error: 'Documento não encontrado' }, { status: 404 })
  if (Number(inv.paid_total) > 0) {
    return NextResponse.json({ error: 'Documento com pagamento não pode ser apagado — cancele.' }, { status: 409 })
  }

  const { error } = await db.from('invoices').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, message: `${inv.number} apagado.` })
}

/** E-mail e aviso no portal quando a fatura é enviada. Não derruba a operação se o e-mail falhar. */
async function avisarClienteDaFatura(
  db: any, inv: any, tom: 'envio' | 'lembrete' = 'envio',
): Promise<{ email: boolean; motivo?: string }> {
  const { data: c } = await db.from('clients').select('id, name, email, language').eq('id', inv.client_id).maybeSingle()
  if (!c) return { email: false, motivo: 'cliente não encontrado' }
  const lang = (c.language || 'en').toLowerCase()
  const valor = money(Math.round((Number(inv.total) - Number(inv.paid_total || 0)) * 100) / 100)
  const venc = fmtUS(inv.due_date)
  const parcelada = inv.payment_plan === 'installments'
  // Vencida? Comparação por data civil, sem passar por fuso.
  const hoje = new Date().toISOString().slice(0, 10)
  const vencida = !!inv.due_date && String(inv.due_date).slice(0, 10) < hoje

  // Envio e cobrança não dizem a mesma coisa. Quem pede o documento de novo
  // não é quem está atrasado, e o cliente percebe a diferença.
  const T: Record<string, { texto: string; assunto: string; botao: string }> = {
    pt: {
      texto: tom === 'lembrete'
        ? (parcelada
            ? `⏰ Lembrete: a fatura ${inv.number} está parcelada e o débito automático não foi concluído. Em Pagamentos você regulariza ou refaz o cadastro do débito.`
            : `⏰ Lembrete: a fatura ${inv.number} de ${valor}${venc ? (vencida ? ` venceu em ${venc}` : ` vence em ${venc}`) : ''}. Em Pagamentos você paga com cartão, débito em conta ou Klarna.`)
        : (parcelada
            ? `🧾 Fatura ${inv.number} (${valor}) enviada. Ela é parcelada: em Pagamentos, cadastre o débito automático.`
            : `🧾 Fatura ${inv.number} de ${valor}${venc ? `, vencimento ${venc}` : ''}. Em Pagamentos você paga com cartão, débito em conta ou Klarna.`),
      assunto: tom === 'lembrete' ? `Lembrete: fatura ${inv.number} — Peace on Tax` : `Fatura ${inv.number} — Peace on Tax`,
      botao: tom === 'lembrete' ? 'Pagar agora' : (parcelada ? 'Cadastrar débito automático' : 'Ver e pagar a fatura'),
    },
    es: {
      texto: tom === 'lembrete'
        ? (parcelada
            ? `⏰ Recordatorio: la factura ${inv.number} está en cuotas y el débito automático no se completó. En Pagos puede regularizar o registrar el débito de nuevo.`
            : `⏰ Recordatorio: la factura ${inv.number} de ${valor}${venc ? (vencida ? ` venció el ${venc}` : ` vence el ${venc}`) : ''}. En Pagos puede pagar con tarjeta, débito en cuenta o Klarna.`)
        : (parcelada
            ? `🧾 Factura ${inv.number} (${valor}) enviada. Es en cuotas: en Pagos, registre el débito automático.`
            : `🧾 Factura ${inv.number} de ${valor}${venc ? `, vence el ${venc}` : ''}. En Pagos puede pagar con tarjeta, débito en cuenta o Klarna.`),
      assunto: tom === 'lembrete' ? `Recordatorio: factura ${inv.number} — Peace on Tax` : `Factura ${inv.number} — Peace on Tax`,
      botao: tom === 'lembrete' ? 'Pagar ahora' : (parcelada ? 'Registrar débito automático' : 'Ver y pagar la factura'),
    },
    en: {
      texto: tom === 'lembrete'
        ? (parcelada
            ? `⏰ Reminder: invoice ${inv.number} is on an installment plan and the automatic debit did not go through. Under Payments you can settle it or set up the debit again.`
            : `⏰ Reminder: invoice ${inv.number} for ${valor}${venc ? (vencida ? ` was due on ${venc}` : ` is due on ${venc}`) : ''}. Under Payments you can pay by card, bank debit (ACH) or Klarna.`)
        : (parcelada
            ? `🧾 Invoice ${inv.number} (${valor}) sent. It is an installment plan: under Payments, set up automatic debit.`
            : `🧾 Invoice ${inv.number} for ${valor}${venc ? `, due ${venc}` : ''}. Under Payments you can pay by card, bank debit (ACH) or Klarna.`),
      assunto: tom === 'lembrete' ? `Reminder: invoice ${inv.number} — Peace on Tax` : `Invoice ${inv.number} — Peace on Tax`,
      botao: tom === 'lembrete' ? 'Pay now' : (parcelada ? 'Set up automatic debit' : 'View and pay invoice'),
    },
  }
  const t = T[lang] || T.en
  await avisarNoPortal(db, c.id, t.texto)

  if (!c.email || !c.email.includes('@')) return { email: false, motivo: 'cliente sem e-mail' }
  const ok = await enviarEmail(c.email, t.assunto,
    emailComMarca({ lang, nome: c.name, corpoHtml: `<p>${t.texto.replace(/^[🧾⏰] /, '')}</p>`,
      botao: { texto: t.botao, url: `${APP_URL}/portal/payments` } }))
  return { email: ok, motivo: ok ? undefined : 'falha no envio' }
}

