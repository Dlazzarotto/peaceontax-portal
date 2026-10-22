// POST /api/billing/installment-plan — transforma uma fatura em aberto em parcelamento
//
// Body: { invoiceId, entryAmount?, entryPct?, installments, frequency, firstDueDate }
//   entryAmount  ENTRADA EM DÓLAR, como a equipe digita (0 = sem entrada)
//   entryPct     formato antigo, em porcentagem; entryAmount tem precedência
//   frequency    weekly | biweekly | monthly
//   firstDueDate data da 1ª parcela, escolhida no acordo
//
// Entrada > 0  → Checkout mode 'payment': cobra a entrada e salva o método
// Entrada = 0  → Checkout mode 'setup': cadastra método e mandato ACH sem cobrar
//
// Em ambos, o agendamento das parcelas é criado pelo webhook, depois que
// o método existe. Aqui só nasce o plano e o cronograma da fatura. A sessão
// vem de lib/plan-checkout.ts, e o cliente é avisado por e-mail e no portal
// para cadastrar o débito pelo portal (o link do Checkout expira em 24h).
//
// PATCH { planId, action: 'cancel', motivo, password } — CANCELA o parcelamento
//   O acordo desandou e o cliente vai pagar de outro jeito. Para o débito no
//   Stripe, anula as invoices de parcela já abertas, cancela o cronograma e
//   DEIXA A FATURA EM ABERTO com o saldo que falta. O que já foi pago fica
//   pago: cancelar para a cobrança futura, nunca desfaz recebimento — isso é
//   estorno e tem rotina própria.
//
// PATCH { planId, action: 'agendar', primeira?, motivo, password } — AGENDA
//   as parcelas de um parcelamento que TRAVOU depois de o cliente pagar a
//   entrada (ou autorizar o débito). Até 10/2026 o agendamento no Stripe
//   falhava sempre (lib/agendamento-parcelas.ts conta por quê): a entrada
//   entrava no Stripe e mais nada acontecia. Aqui a equipe confere no Stripe
//   o que o cliente fez, lança a entrada na fatura com a data em que ela
//   entrou, re-data o cronograma a partir da nova 1ª parcela e agenda. Chave
//   `receber` (é a mesma de criar o parcelamento) + senha + motivo.
//
// Só gerente ou sócio.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb, canAccessClient, clientesOcultos } from '@/lib/api-auth'
import { avancarData } from '@/lib/plans'
import { dataDaFirma } from '@/lib/dia-da-firma'
import { fmtUS } from '@/lib/format'
import {
  agendarParcelas, fasesDoParcelamento, pagamentoDaSessao, sessoesDoPlano, metodoDoTipo,
  type PagamentoDaSessao,
} from '@/lib/agendamento-parcelas'
import { filtroDeRecebimento, lancarRecebimentoStripe } from '@/lib/recebimento-stripe'
import { permissoesFinanceiro, RECUSA } from '@/lib/billing-perms'
import { type Frequency } from '@/lib/plans'
// O cronograma e o PISO da parcela moram num modulo puro, com teste: e
// dinheiro com arredondamento, e antes a conta estava aqui dentro sem
// nenhum teste -- e sem piso, entao $15 em 36x criava parcela de $0,41,
// que o Stripe recusa para sempre.
import { montarCronograma } from '@/lib/cronograma-parcelas'
import { criarSessaoDoPlano, stripeClient } from '@/lib/plan-checkout'
import { enviarEmail, avisarNoPortal, emailComMarca, APP_URL, type ResultadoEmail } from '@/lib/avisos'
import { encerrarParcelamento } from '@/lib/parcelamento'
import { entradaDoPedido } from '@/lib/entrada-parcelamento'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://peaceontax-portal.vercel.app'
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

// avancarData (lib/plans.ts) trata mês curto: ver comentário lá.

const STATUS_TEXTO: Record<string, string> = {
  draft: 'rascunho', awaiting_entry: 'aguardando a entrada',
  awaiting_setup: 'aguardando o cliente cadastrar o débito',
  active: 'em cobrança', payment_failed: 'com parcela recusada',
  paused: 'pausado',
}

/**
 * Plano que nasceu e nunca saiu do lugar: o cliente não cadastrou o débito,
 * não há assinatura no Stripe e nenhuma parcela foi paga.
 *
 * Importa porque desfazer isso NÃO é desfazer uma cobrança: não há nada para
 * parar no Stripe nem dinheiro a acertar. Tratar os dois casos como o mesmo
 * fazia a equipe encarar um cancelamento formal para corrigir um acordo que
 * ainda era só uma proposta — e o cliente receber um aviso de que algo foi
 * "cancelado" quando nada tinha começado.
 */
function planoNuncaComecou(p: any): boolean {
  return Number(p?.paid_installments || 0) === 0
    && !p?.stripe_subscription_id
    && !p?.stripe_schedule_id
    // Entrada paga é dinheiro que se moveu: o plano começou, mesmo sem
    // agendamento (o caso do agendamento que travou depois da entrada).
    && !p?.entry_paid_at
}

/** Cronograma: base para todas, última absorve o centavo da divisão. */


// GET → parcelamentos existentes + faturas elegíveis para parcelar
export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  const db = serviceDb()

  // CONFERIR O ERRO NÃO É OPCIONAL. Antes o erro desta consulta era
  // ignorado e `planos` vinha null: a lista saía vazia e a tela dizia
  // "nenhuma fatura parcelada ainda". Consulta que falha tem de gritar, não
  // devolver lista vazia — já se perdeu tempo procurando parcelamento que
  // existia e não aparecia.
  const [{ data: planos, error: errPlanos }, { data: faturas, error: errFaturas }, escopo] = await Promise.all([
    db.from('payment_plans')
      // invoices!invoice_id: DIZER a FK. Há DUAS relações entre payment_plans
      // e invoices — payment_plans.invoice_id → invoices.id (a fatura que foi
      // parcelada) e invoices.plan_id → payment_plans.id (as faturas que um
      // plano mensal gera). Sem apontar a coluna, o PostgREST não sabe qual
      // usar e recusa a consulta INTEIRA com "more than one relationship was
      // found", e a aba de Parcelamentos não abria. Aqui a fatura é a de
      // ORIGEM do parcelamento: invoice_id. A chave da resposta continua
      // `invoices` (o hint só desambigua), então o map abaixo não muda.
      .select('id, client_id, invoice_id, status, total, entry_pct, entry_amount, frequency, installments, installment_amount, paid_installments, next_charge_date, stripe_session_id, created_at, description, clients(name, business_name), invoices!invoice_id(number, total, paid_total)')
      .eq('kind', 'installment')
      // Os SEM fatura também: são os parcelamentos do módulo antigo de
      // orçamentos (Quotes). Com a aba de Planos fora da ficha do cliente,
      // este é o único lugar onde eles aparecem — e o alerta de "plano
      // parado" manda desistir deles aqui.
      .order('created_at', { ascending: false })
      .limit(200),
    // Faturas que podem ser parceladas: fatura (não orçamento), não cancelada,
    // não rascunho, e com saldo em aberto.
    db.from('invoices')
      .select('id, client_id, number, total, paid_total, issue_date, clients(name, business_name)')
      .eq('doc_type', 'invoice')
      .not('status', 'in', '(void,draft,paid)')
      .order('issue_date', { ascending: false })
      .limit(200),
    // O escopo por tipo vale aqui também: as duas listas mostravam a carteira
    // INTEIRA — o nome das empresas e quanto cada uma deve — a quem não pode
    // abrir empresa nenhuma, e o caixa da firma a quem não é sócio.
    clientesOcultos(auth),
  ])
  if (escopo.erro) return NextResponse.json({ error: escopo.erro }, { status: 500 })

  if (errPlanos) {
    return NextResponse.json({
      error: `Não foi possível ler os parcelamentos: ${errPlanos.message}`,
    }, { status: 500 })
  }
  if (errFaturas) {
    return NextResponse.json({
      error: `Não foi possível ler as faturas: ${errFaturas.message}`,
    }, { status: 500 })
  }

  // Se o plano chegou a virar cobrança de verdade no Stripe. Consulta
  // SEPARADA e tolerante de propósito: é um detalhe de texto do modal
  // ("encerrar proposta" x "cancelar parcelamento"), e não pode ser o motivo
  // de a lista inteira desaparecer — foi o que aconteceu quando estas duas
  // colunas entraram no select principal.
  const comCobranca = new Set<string>()
  const entradaPaga = new Set<string>()
  if ((planos || []).length) {
    const { data: stripeIds } = await db.from('payment_plans')
      .select('id, stripe_subscription_id, stripe_schedule_id, entry_paid_at')
      .in('id', (planos || []).map((p: any) => p.id))
    for (const p of (stripeIds || []) as any[]) {
      if (p.stripe_subscription_id || p.stripe_schedule_id) comCobranca.add(p.id)
      if (p.entry_paid_at) entradaPaga.add(p.id)
    }
  }

  // Fatura que já tem parcelamento vivo sai da lista de elegíveis
  const VIVOS = ['draft', 'awaiting_entry', 'awaiting_setup', 'active', 'payment_failed']
  const ocupadas = new Set(
    (planos || []).filter((p: any) => VIVOS.includes(p.status)).map((p: any) => p.invoice_id),
  )

  return NextResponse.json({
    perms,
    plans: (planos || []).filter((p: any) => !escopo.ocultos.has(p.client_id)).map((p: any) => ({
      ...p,
      cliente: p.clients?.business_name || p.clients?.name || '—',
      numero: p.invoices?.number || (p.invoice_id ? '—' : 'sem fatura (antigo)'),
      semFatura: !p.invoice_id,
      // Decidido no servidor: a tela não precisa adivinhar nem receber os
      // ids do Stripe para saber a diferença.
      cobrandoNoStripe: comCobranca.has(p.id),
      nuncaComecou: Number(p.paid_installments || 0) === 0 && !comCobranca.has(p.id) && !entradaPaga.has(p.id),
      // Aguardando o cliente e sem agendamento no Stripe: pode ser que ele
      // JÁ tenha pago a entrada e o agendamento tenha travado. Só o Stripe
      // diz — a ação "agendar" confere antes de fazer qualquer coisa.
      podeAgendar: ['awaiting_entry', 'awaiting_setup'].includes(p.status) && !comCobranca.has(p.id),
      entradaPaga: entradaPaga.has(p.id),
    })),
    hoje: dataDaFirma(),
    invoices: (faturas || [])
      .filter((i: any) => !escopo.ocultos.has(i.client_id))
      .map((i: any) => ({
        id: i.id, number: i.number,
        cliente: i.clients?.business_name || i.clients?.name || '—',
        saldo: round2(Number(i.total) - Number(i.paid_total)),
      }))
      .filter((i: any) => i.saldo > 0 && !ocupadas.has(i.id)),
  })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  if (!perms.receber) return NextResponse.json({ error: RECUSA.receber }, { status: 403 })

  const b = await req.json()
  const db = serviceDb()

  // ── validações ──
  if (!b.invoiceId) return NextResponse.json({ error: 'Selecione a fatura.' }, { status: 400 })

  const freq = String(b.frequency || 'monthly') as Frequency
  if (!['weekly', 'biweekly', 'monthly'].includes(freq)) {
    return NextResponse.json({ error: 'Frequência inválida.' }, { status: 400 })
  }

  const n = Math.trunc(Number(b.installments) || 0)
  if (n < 2 || n > 36) {
    return NextResponse.json({ error: 'O parcelamento vai de 2 a 36 parcelas.' }, { status: 400 })
  }

  if (!b.firstDueDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.firstDueDate))) {
    return NextResponse.json({ error: 'Informe a data da primeira parcela.' }, { status: 400 })
  }

  const { data: inv } = await db.from('invoices')
    .select('id, client_id, number, doc_type, total, paid_total, status, clients(name, email, language)')
    .eq('id', b.invoiceId).maybeSingle()
  if (!inv) return NextResponse.json({ error: 'Fatura não encontrada.' }, { status: 404 })
  // isStaff diz QUEM chama; QUAL cliente é o escopo por tipo.
  if (!(await canAccessClient(auth, inv.client_id))) return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })
  if (inv.doc_type !== 'invoice') {
    return NextResponse.json({ error: 'Só faturas podem ser parceladas. Converta o orçamento primeiro.' }, { status: 409 })
  }
  if (inv.status === 'void') {
    return NextResponse.json({ error: 'Fatura cancelada não pode ser parcelada.' }, { status: 409 })
  }

  const saldo = round2(Number(inv.total) - Number(inv.paid_total))
  if (saldo <= 0) {
    return NextResponse.json({ error: `${inv.number} já está quitada.` }, { status: 409 })
  }

  // Um parcelamento vivo por fatura. A recusa LEVA O PLANO: mandar procurar
  // o botão em outra aba é o que fazia a equipe travar aqui.
  const { data: existente } = await db.from('payment_plans')
    .select('id, status, paid_installments, stripe_subscription_id, stripe_schedule_id')
    .eq('invoice_id', inv.id)
    .in('status', ['draft', 'awaiting_entry', 'awaiting_setup', 'active', 'payment_failed'])
    .limit(1)
  if (existente && existente.length > 0) {
    const ja = existente[0]
    const parado = planoNuncaComecou(ja)
    return NextResponse.json({
      error: parado
        ? `${inv.number} já tem um parcelamento criado que o cliente ainda não cadastrou. ` +
          `Cancele-o para refazer o acordo — nada foi cobrado.`
        : `${inv.number} já tem um parcelamento em andamento (${STATUS_TEXTO[ja.status] || ja.status}). ` +
          `Cancele-o antes de criar outro.`,
      planoExistente: { id: ja.id, status: ja.status, nuncaComecou: parado },
    }, { status: 409 })
  }

  // A entrada vem em DÓLAR (lib/entrada-parcelamento.ts faz a conta e a
  // porcentagem). A validação só é possível aqui, depois de saber o saldo.
  const res = entradaDoPedido({ saldo, entryAmount: b.entryAmount, entryPct: b.entryPct })
  if ('erro' in res) return NextResponse.json({ error: res.erro }, { status: 400 })
  const { entrada, pct: entryPct, restante } = res

  const cron = montarCronograma(restante, n, String(b.firstDueDate), freq)
  if ('erro' in cron) return NextResponse.json({ error: cron.erro }, { status: 400 })
  const cronograma = cron
  const valorParcela = cronograma[0].amount

  const client = (inv as any).clients || {}
  const lang = client.language || 'en'
  const stripe = stripeClient()

  try {
    // ── plano ──
    const { data: plan, error: pErr } = await db.from('payment_plans').insert({
      client_id: inv.client_id,
      invoice_id: inv.id,
      kind: 'installment',
      total: saldo,
      entry_pct: entryPct,
      entry_amount: entrada,
      frequency: freq,
      installments: n,
      installment_amount: valorParcela,
      description: `Parcelamento da fatura ${inv.number}`,
      status: entrada > 0 ? 'awaiting_entry' : 'awaiting_setup',
      // Data acordada da 1ª parcela. O webhook lê daqui em vez de derivar
      // da data em que a entrada foi paga.
      next_charge_date: String(b.firstDueDate),
      created_by: auth.userId,
    }).select('*').single()

    if (pErr || !plan) {
      return NextResponse.json({ error: `Plano: ${pErr?.message || 'falha ao criar'}` }, { status: 500 })
    }

    // ── cronograma da fatura (fonte da impressão) ──
    await db.from('invoice_installments').delete().eq('invoice_id', inv.id)
    const { error: cErr } = await db.from('invoice_installments')
      .insert(cronograma.map(l => ({ ...l, invoice_id: inv.id, status: 'scheduled' })))
    if (cErr) {
      await db.from('payment_plans').delete().eq('id', plan.id)
      return NextResponse.json({ error: `Cronograma: ${cErr.message}` }, { status: 500 })
    }

    await db.from('invoices').update({
      payment_plan: 'installments',
      due_date: cronograma[0].due_date,
    }).eq('id', inv.id)

    // ── sessão Stripe (mesma regra do portal: lib/plan-checkout) ──
    const { url: sessionUrl, sessionId } = await criarSessaoDoPlano(db, stripe, { ...plan, clients: client }, {
      origem: 'equipe', performedBy: auth.userId, baseUrl: BASE_URL,
    })
    const session = { id: sessionId, url: sessionUrl }

    // ── o cliente fica sabendo na hora: e-mail + aviso no portal ──
    // O link do Checkout expira em 24h; o e-mail leva ao portal, onde o
    // cliente gera a sessão na hora em que clicar.
    const valorParcelaFmt = `$${valorParcela.toFixed(2)}`
    const textoPortal = lang === 'pt'
      ? `📆 Sua fatura ${inv.number} foi parcelada em ${n}x de ${valorParcelaFmt}${entrada > 0 ? `, com entrada de $${entrada.toFixed(2)}` : ''}. Em Pagamentos, cadastre o débito automático (conta bancária ou cartão).`
      : lang === 'es'
      ? `📆 Su factura ${inv.number} fue dividida en ${n} cuotas de ${valorParcelaFmt}${entrada > 0 ? `, con anticipo de $${entrada.toFixed(2)}` : ''}. En Pagos, registre el débito automático (cuenta bancaria o tarjeta).`
      : `📆 Your invoice ${inv.number} was split into ${n} installments of ${valorParcelaFmt}${entrada > 0 ? `, with a down payment of $${entrada.toFixed(2)}` : ''}. Under Payments, set up automatic debit (bank account or card).`
    await avisarNoPortal(db, inv.client_id, textoPortal)
    // O resultado do e-mail NAO se joga fora: sem ele, "o cliente nao
    // recebeu" nao tem pista nenhuma. Vai para a trilha e para a resposta.
    let emailParcelamento: ResultadoEmail = { ok: false, motivo: 'cliente sem e-mail no cadastro' }
    if (client.email) {
      emailParcelamento = await enviarEmail(client.email,
        lang === 'pt' ? `Fatura ${inv.number} parcelada — cadastre o débito automático` : lang === 'es' ? `Factura ${inv.number} en cuotas — registre el débito automático` : `Invoice ${inv.number} installment plan — set up automatic debit`,
        emailComMarca({ lang, nome: client.name, corpoHtml: `<p>${textoPortal.replace(/^📆 /, '')}</p>`,
          botao: { texto: lang === 'pt' ? 'Cadastrar débito automático' : lang === 'es' ? 'Registrar débito automático' : 'Set up automatic debit', url: `${APP_URL}/portal/payments` } }))
    }

    await db.from('invoice_audit').insert({
      invoice_id: inv.id, action: 'installment_plan_created', performed_by: auth.userId,
      staff_level: perms.nivel,
      next: { planId: plan.id, entrada, parcelas: n, frequencia: freq, primeira: b.firstDueDate,
              email: emailParcelamento.ok, emailMotivo: emailParcelamento.motivo || null },
    }).then(() => null, () => null)

    return NextResponse.json({
      ok: true,
      planId: plan.id,
      url: session.url,
      cronograma,
      message: entrada > 0
        ? `Parcelamento de ${inv.number} criado: entrada de $${entrada.toFixed(2)} + ${n}x. Envie o link ao cliente.`
        : `Parcelamento de ${inv.number} criado: ${n}x sem entrada. O link cadastra o débito automático sem cobrar nada agora.`,
    })
  } catch (e) {
    console.error('Installment plan error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

// ── Cancelar o parcelamento, com a fatura seguindo em aberto ──
export async function PATCH(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  const b = await req.json().catch(() => ({} as any))

  // ── Agendar as parcelas do parcelamento que travou depois da entrada ──
  if (b.action === 'agendar') {
    if (!perms.receber) return NextResponse.json({ error: RECUSA.receber }, { status: 403 })
    return agendarParcelamentoTravado(auth, b)
  }

  if (!perms.cancelar) return NextResponse.json({ error: RECUSA.cancelar }, { status: 403 })
  if (b.action !== 'cancel') return NextResponse.json({ error: 'Ação desconhecida.' }, { status: 400 })
  if (!b.planId) return NextResponse.json({ error: 'planId obrigatório' }, { status: 400 })

  const motivo = String(b.motivo || '').trim()
  if (motivo.length < 5) {
    return NextResponse.json({
      error: 'Descreva por que o parcelamento está sendo cancelado (mínimo 5 caracteres). Fica na trilha do plano.',
    }, { status: 400 })
  }
  if (!b.password) return NextResponse.json({ error: 'Confirme com a sua senha.' }, { status: 400 })

  const db = serviceDb()

  // Senha da própria pessoa: parar uma régua de cobrança é ação sensível
  // (princípio 3) e não pode sair de uma tela destravada no balcão.
  const recusaSenha = await conferirSenhaPropria(db, auth.userId, b.password)
  if (recusaSenha) return recusaSenha

  const { data: plano } = await db.from('payment_plans')
    .select('id, invoice_id, client_id, status, kind, installments, paid_installments, stripe_schedule_id, stripe_subscription_id, stripe_session_id, stripe_customer_id, entry_amount, entry_paid_at')
    .eq('id', b.planId).eq('kind', 'installment').maybeSingle()
  if (!plano) return NextResponse.json({ error: 'Parcelamento não encontrado.' }, { status: 404 })
  if (!(await canAccessClient(auth, plano.client_id))) return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })
  if (!plano.invoice_id) return desistirDaPropostaAntiga(db, plano, auth.userId, motivo)
  // Já encerrado: dizer isso é melhor que rodar de novo e tentar cancelar no
  // Stripe uma assinatura que não existe mais.
  if (['cancelled', 'completed'].includes(String(plano.status))) {
    return NextResponse.json({
      error: `Este parcelamento já está ${plano.status === 'completed' ? 'concluído' : 'cancelado'}.`,
    }, { status: 409 })
  }

  const { data: inv } = await db.from('invoices')
    .select('id, number, total, paid_total, clients(name, email, language)')
    .eq('id', plano.invoice_id).maybeSingle()
  if (!inv) return NextResponse.json({ error: 'Fatura do parcelamento não encontrada.' }, { status: 404 })

  // Parece proposta (nada no banco diz que começou), mas pode ser o
  // agendamento que TRAVOU depois de a entrada ser paga: aí o dinheiro está
  // no Stripe e fora da fatura. Cancelar "como proposta" diria ao cliente que
  // nada foi cobrado e deixaria o saldo errado. Confere no Stripe e, se a
  // entrada entrou, lança antes de cancelar.
  if (planoNuncaComecou(plano) && Number(plano.entry_amount || 0) > 0 && plano.stripe_customer_id && process.env.STRIPE_SECRET_KEY) {
    const pago = await entradaPagaNoStripe(plano)
    if (pago) {
      const r = await lancarRecebimentoStripe(db, {
        invoiceId: plano.invoice_id, clientId: plano.client_id, valor: round2(Number(plano.entry_amount)),
        metodo: metodoDoTipo(pago.tipo), referencia: pago.intent, objetoStripe: pago.sessao, recebidoEm: pago.quando,
      })
      if (r.ok === false) {
        return NextResponse.json({ error: `A entrada deste parcelamento FOI PAGA no Stripe, e não deu para lançá-la na fatura: ${r.motivo}. Nada foi cancelado.` }, { status: 500 })
      }
      await db.from('payment_plans').update({ entry_paid_at: (pago.quando || new Date()).toISOString() }).eq('id', plano.id)
      plano.entry_paid_at = (pago.quando || new Date()).toISOString()
    }
  }

  // Lido ANTES de encerrar: é o estado em que o plano estava quando a
  // decisão foi tomada, e é isso que a trilha tem de guardar.
  const nuncaComecou = planoNuncaComecou(plano)

  const r = await encerrarParcelamento(db, stripeClient(), plano, plano.invoice_id, {
    motivo: 'plano_cancelado', performedBy: auth.userId, razao: motivo,
  })

  // O saldo depois de tudo: se a entrada travada acabou de ser lançada, o
  // valor lido lá em cima já não vale — e é ele que vai no aviso ao cliente.
  const { data: depois } = await db.from('invoices').select('total, paid_total').eq('id', inv.id).maybeSingle()
  const saldo = round2(Number((depois || inv).total) - Number((depois || inv).paid_total))

  await db.from('invoice_audit').insert({
    invoice_id: inv.id, action: 'installment_plan_cancelled', performed_by: auth.userId,
    staff_level: perms.nivel, reason: motivo,
    next: { planId: plano.id, saldoEmAberto: saldo, nuncaComecou,
            stripeOk: r.stripeOk, parcelasFechadas: r.parcelasFechadas },
  }).then(() => null, () => null)

  // O cliente tinha um acordo e o débito automático dele. Se o acordo acabou,
  // ele precisa saber ANTES de estranhar o débito que não veio.
  const client = (inv as any).clients || {}
  const lang = (client.language || 'en').toLowerCase()
  // Quem nunca cadastrou o débito não teve nada cobrado: dizer que "o débito
  // automático não será mais cobrado" assusta sem motivo e faz o cliente
  // procurar uma cobrança que nunca existiu. O aviso é outro, e o essencial
  // é o link antigo não servir mais.
  const texto = nuncaComecou
    ? (lang === 'pt'
      ? `📆 A proposta de parcelamento da fatura ${inv.number} foi encerrada — o link para cadastrar o débito não vale mais, e nada foi cobrado. Saldo em aberto: $${saldo.toFixed(2)}. Fale com a nossa equipe para combinar o pagamento.`
      : lang === 'es'
      ? `📆 La propuesta de cuotas de la factura ${inv.number} fue cancelada — el enlace para registrar el débito ya no es válido y no se cobró nada. Saldo pendiente: $${saldo.toFixed(2)}. Hable con nuestro equipo para acordar el pago.`
      : `📆 The installment proposal for invoice ${inv.number} was withdrawn — the link to set up automatic debit no longer works, and nothing was charged. Outstanding balance: $${saldo.toFixed(2)}. Please contact our team to arrange payment.`)
    : (lang === 'pt'
      ? `📆 O parcelamento da fatura ${inv.number} foi encerrado e o débito automático não será mais cobrado. Saldo em aberto: $${saldo.toFixed(2)}. Fale com a nossa equipe para combinar o pagamento.`
      : lang === 'es'
      ? `📆 El plan de cuotas de la factura ${inv.number} fue cancelado y el débito automático ya no se cobrará. Saldo pendiente: $${saldo.toFixed(2)}. Hable con nuestro equipo para acordar el pago.`
      : `📆 The installment plan for invoice ${inv.number} was ended and automatic debit will no longer be charged. Outstanding balance: $${saldo.toFixed(2)}. Please contact our team to arrange payment.`)
  await avisarNoPortal(db, plano.client_id, texto)
  let emailCancelamento: ResultadoEmail = { ok: false, motivo: 'cliente sem e-mail no cadastro' }
  if (client.email) {
    emailCancelamento = await enviarEmail(client.email,
      lang === 'pt' ? `Parcelamento da fatura ${inv.number} encerrado`
      : lang === 'es' ? `Plan de cuotas de la factura ${inv.number} cancelado`
      : `Installment plan for invoice ${inv.number} ended`,
      emailComMarca({ lang, nome: client.name, corpoHtml: `<p>${texto.replace(/^📆 /, '')}</p>`,
        botao: { texto: lang === 'pt' ? 'Ver em Pagamentos' : lang === 'es' ? 'Ver en Pagos' : 'View in Payments',
          url: `${APP_URL}/portal/payments` } }))
  }

  return NextResponse.json({
    ok: true,
    saldo,
    nuncaComecou,
    message: nuncaComecou
      ? `Proposta de parcelamento de ${inv.number} encerrada — nada havia sido cobrado. ` +
        `Saldo em aberto: $${saldo.toFixed(2)}. Pode criar o novo acordo.`
      : `Parcelamento de ${inv.number} cancelado. Saldo em aberto: $${saldo.toFixed(2)}.${r.nota}`,
    // O cliente tinha um acordo e um debito automatico: ele PRECISA saber.
    // Se o e-mail nao saiu, quem cancelou tem de ver o motivo na hora.
    email: emailCancelamento.ok,
    emailMotivo: emailCancelamento.motivo || null,
    avisoAoCliente: emailCancelamento.ok
      ? 'Cliente avisado por e-mail e no portal.'
      : `Cliente avisado NO PORTAL. E-mail nao saiu: ${emailCancelamento.motivo}`,
  })
}

/**
 * Parcelamento SEM fatura: veio do módulo antigo de orçamentos (Quotes),
 * que já saiu. Desistir só da PROPOSTA que nunca começou — nada cobrado,
 * nenhuma assinatura no Stripe. Era o que a aba de Planos da ficha fazia, e
 * sem isto o alerta diário de "plano parado" mandava desistir de um plano
 * que não tinha mais botão em lugar nenhum.
 *
 * O que já começou a cobrar não se cancela por aqui: não há fatura onde o
 * saldo fique em aberto (encerrarParcelamento precisa dela), e cancelar em
 * silêncio deixaria dinheiro combinado sem registro. Diz isso e para.
 *
 * "Nunca começou" pelo banco não basta: até 10/2026 o agendamento travava
 * DEPOIS de a entrada ser paga (lib/agendamento-parcelas.ts), e o plano
 * ficava com cara de proposta. Quem diz se o cliente pagou é o Stripe.
 */
async function desistirDaPropostaAntiga(db: any, plano: any, userId: string, motivo: string) {
  if (['cancelled', 'completed'].includes(String(plano.status))) {
    return NextResponse.json({ error: `Este parcelamento já está ${plano.status === 'completed' ? 'concluído' : 'cancelado'}.` }, { status: 409 })
  }
  // A entrada paga no Stripe faz do plano um acordo em andamento: dizer ao
  // cliente que "nada foi cobrado" seria falso, e sem fatura não há onde
  // lançá-la. Fica registrado que entrou — o portal para de oferecer pagá-la
  // de novo — e a desistência é recusada, dizendo o que fazer.
  if (planoNuncaComecou(plano) && Number(plano.entry_amount || 0) > 0 && plano.stripe_customer_id && process.env.STRIPE_SECRET_KEY) {
    let pago: PagamentoDaSessao | null
    try { pago = await entradaPagaNoStripe(plano) } catch (e) {
      // Consulta que falha não é "não pagou".
      return NextResponse.json({ error: `Não deu para conferir no Stripe se a entrada foi paga: ${(e as Error).message}. Nada foi feito.` }, { status: 502 })
    }
    if (pago) {
      const quando = pago.quando || new Date()
      await db.from('payment_plans').update({ entry_paid_at: quando.toISOString(), updated_at: new Date().toISOString() })
        .eq('id', plano.id).is('entry_paid_at', null)
      return NextResponse.json({
        error: `A entrada deste parcelamento antigo FOI PAGA no Stripe ($${pago.valor.toFixed(2)} em ${fmtUS(dataDaFirma(quando))}): não é proposta, e o cliente não pode ouvir que nada foi cobrado. Para seguir o acordo, use "Conferir pagamento e agendar"; para desfazê-lo, a entrada se devolve no painel do Stripe — fale com o sócio.`,
      }, { status: 409 })
    }
  }
  if (!planoNuncaComecou(plano) || !['draft', 'awaiting_entry', 'awaiting_setup'].includes(String(plano.status))) {
    return NextResponse.json({
      error: 'Parcelamento antigo (sem fatura) que já começou a cobrar não se cancela por aqui: não há fatura para o saldo ficar em aberto. Ele segue até o fim; para interromper, fale com o sócio (painel do Stripe).',
    }, { status: 409 })
  }
  // A trilha ANTES (princípio 2): falhou, não desiste.
  const { error: errT } = await db.from('plan_audit').insert({
    plan_id: plano.id, action: 'cancelled', reason: motivo, performed_by: userId,
    snapshot: { previous_status: plano.status, semFatura: true, proposta: true },
  })
  if (errT) return NextResponse.json({ error: `Nada foi feito: não deu para gravar a trilha (${errT.message}).` }, { status: 500 })
  // O link que ficou com o cliente deixa de valer.
  if (plano.stripe_session_id && process.env.STRIPE_SECRET_KEY) {
    await stripeClient().checkout.sessions.expire(plano.stripe_session_id).catch(() => null)
  }
  const { error } = await db.from('payment_plans').update({
    status: 'cancelled', cancel_reason: motivo, stripe_session_id: null, updated_at: new Date().toISOString(),
  }).eq('id', plano.id).in('status', ['draft', 'awaiting_entry', 'awaiting_setup'])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const aviso = await avisarNoPortal(db, plano.client_id,
    '📆 A proposta de parcelamento que estava aguardando o seu cadastro foi encerrada — o link não vale mais, e nada foi cobrado. Fale com a nossa equipe se quiser combinar de novo.')
  return NextResponse.json({
    ok: true, nuncaComecou: false,
    message: 'Proposta antiga encerrada: nada tinha sido cobrado, e o link do cliente deixou de valer.'
      + (aviso.ok ? '' : ` O aviso no portal não saiu: ${aviso.motivo}.`),
  })
}

/** Senha da PRÓPRIA pessoa (princípio 3). Devolve a recusa pronta, ou null. */
async function conferirSenhaPropria(db: any, userId: string, senha: unknown): Promise<NextResponse | null> {
  const { data: quem } = await db.auth.admin.getUserById(userId)
  const email = quem?.user?.email
  if (!email) return NextResponse.json({ error: 'Não foi possível identificar seu login.' }, { status: 400 })
  const sbAuth = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
  const { error: pwErr } = await sbAuth.auth.signInWithPassword({ email, password: String(senha || '').trim() })
  if (!pwErr) return null
  if (/rate|too many|429/i.test(pwErr.message || '')) {
    return NextResponse.json({ error: 'Muitas tentativas. Aguarde 1 minuto.' }, { status: 429 })
  }
  return NextResponse.json({ error: `Senha não confere para ${email}.` }, { status: 401 })
}

/** O que o cliente fez no Stripe para este plano: a sessão paga pode não ser a última gerada. */
async function oQueOClienteFez(plano: any): Promise<PagamentoDaSessao[]> {
  const stripe = stripeClient()
  const sessoes = await sessoesDoPlano(stripe, plano.stripe_customer_id, plano.id)
  return Promise.all(sessoes.map(s => pagamentoDaSessao(stripe, s)))
}

/** A entrada deste plano que entrou de fato no Stripe, se houver. */
async function entradaPagaNoStripe(plano: any): Promise<PagamentoDaSessao | null> {
  const feitos = await oQueOClienteFez(plano)
  return feitos.find(f => f.modo === 'payment' && f.concluido) || null
}

/**
 * Agendar as parcelas de um parcelamento que TRAVOU: o cliente pagou a
 * entrada (ou autorizou o débito) e o agendamento no Stripe não nasceu.
 *
 * Nada aqui confia no banco sobre o que o cliente fez — quem diz é o Stripe.
 * E nada se agenda sem bater a conta: as parcelas em aberto do cronograma têm
 * de somar o saldo da fatura (depois da entrada). Se algo foi recebido por
 * fora no meio-tempo e a conta não fecha, o Stripe cobraria de novo — então
 * recusa e diz quanto falta para cada lado.
 */
async function agendarParcelamentoTravado(auth: { userId: string; isStaff: boolean }, b: any): Promise<NextResponse> {
  if (!b.planId) return NextResponse.json({ error: 'planId obrigatório' }, { status: 400 })
  const motivo = String(b.motivo || '').trim()
  if (motivo.length < 5) {
    return NextResponse.json({ error: 'Descreva por que as parcelas estão sendo agendadas agora (mínimo 5 caracteres). Fica na trilha do plano.' }, { status: 400 })
  }
  if (!b.password) return NextResponse.json({ error: 'Confirme com a sua senha.' }, { status: 400 })
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: 'Stripe não configurado neste ambiente.' }, { status: 503 })

  const db = serviceDb()
  const recusaSenha = await conferirSenhaPropria(db, auth.userId, b.password)
  if (recusaSenha) return recusaSenha

  const { data: plano, error: errPlano } = await db.from('payment_plans')
    .select('*, clients(name, email, language)').eq('id', b.planId).eq('kind', 'installment').maybeSingle()
  if (errPlano) return NextResponse.json({ error: `Não foi possível ler o parcelamento: ${errPlano.message}` }, { status: 500 })
  if (!plano) return NextResponse.json({ error: 'Parcelamento não encontrado.' }, { status: 404 })
  if (!(await canAccessClient(auth as any, plano.client_id))) return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })
  if (!['awaiting_entry', 'awaiting_setup'].includes(String(plano.status))) {
    return NextResponse.json({ error: `Este parcelamento está ${STATUS_TEXTO[plano.status] || plano.status}: não há o que agendar.` }, { status: 409 })
  }
  if (plano.stripe_schedule_id) return NextResponse.json({ error: 'Este parcelamento já tem agendamento no Stripe.' }, { status: 409 })
  if (!plano.stripe_customer_id) {
    return NextResponse.json({ error: 'O cliente nunca abriu o link do débito: não há pagamento nem autorização a conferir no Stripe.' }, { status: 409 })
  }

  // 1. O que o cliente fez — no Stripe, não no banco.
  const comEntrada = Number(plano.entry_amount || 0) > 0
  let feitos: PagamentoDaSessao[]
  try { feitos = await oQueOClienteFez(plano) } catch (e) {
    return NextResponse.json({ error: `Não deu para consultar o Stripe: ${(e as Error).message}` }, { status: 502 })
  }
  // Enquanto travava, o portal seguia oferecendo "pagar a entrada": o cliente
  // pode ter pago mais de uma vez. Só UMA é a entrada — a que já estiver no
  // livro, se alguma estiver; as outras são estorno.
  const entradasPagas = feitos.filter(f => f.modo === 'payment' && f.concluido && f.paymentMethod)
  let jaNoLivro: PagamentoDaSessao | null = null
  if (comEntrada && plano.invoice_id) {
    for (const f of entradasPagas) {
      const filtro = filtroDeRecebimento(f.sessao, f.intent)
      if (!filtro) continue
      const { data: ja, error: eJa } = await db.from('invoice_payments').select('id').or(filtro).limit(1)
      if (eJa) return NextResponse.json({ error: `Não deu para conferir a entrada: ${eJa.message}` }, { status: 500 })
      if (ja?.length) { jaNoLivro = f; break }
    }
  }
  const feito = comEntrada
    ? (jaNoLivro || entradasPagas[0] || null)
    : (feitos.find(f => f.concluido && f.paymentMethod) || null)
  const aMais = comEntrada ? entradasPagas.filter(f => f !== feito) : []
  if (!feito) {
    const processando = feitos.some(f => f.emProcessamento)
    return NextResponse.json({
      error: processando
        ? 'A entrada por débito em conta ainda está sendo confirmada pelo banco (o ACH leva até 4 dias úteis). Quando o banco confirmar, o sistema agenda sozinho.'
        : comEntrada
          ? 'O cliente ainda NÃO pagou a entrada: não há pagamento deste parcelamento no Stripe.'
          : 'O cliente ainda NÃO autorizou o débito: não há cadastro deste parcelamento no Stripe.',
    }, { status: 409 })
  }

  // 2. A data da 1ª parcela. A combinada, se ainda não passou; senão quem
  //    decide é a equipe — hoje cobra a 1ª na hora.
  const hoje = dataDaFirma()
  const original = plano.next_charge_date ? String(plano.next_charge_date).slice(0, 10) : null
  const pedida = String(b.primeira || '').slice(0, 10)
  if (pedida && !/^\d{4}-\d{2}-\d{2}$/.test(pedida)) return NextResponse.json({ error: 'Data da 1ª parcela inválida.' }, { status: 400 })
  if (pedida && pedida < hoje) return NextResponse.json({ error: 'A 1ª parcela não pode ser antes de hoje.' }, { status: 400 })
  const primeira = pedida || (original && original > hoje ? original : '')
  if (!primeira) {
    return NextResponse.json({
      error: `A 1ª parcela estava marcada para ${fmtUS(original) || '—'}, e essa data já passou. Escolha a nova data (hoje = cobra a 1ª parcela na hora).`,
      precisaData: true,
    }, { status: 409 })
  }

  // 3. A conta. Com fatura, são as parcelas EM ABERTO do cronograma, e elas
  //    têm de somar o saldo da fatura depois da entrada.
  const freq = plano.frequency as Frequency
  let abertas: any[] = []
  let entradaJaLancada = true
  let inv: any = null
  if (plano.invoice_id) {
    const [{ data: f, error: eInv }, { data: parcelas, error: eParc }] = await Promise.all([
      db.from('invoices').select('id, number, total, paid_total, status').eq('id', plano.invoice_id).maybeSingle(),
      db.from('invoice_installments').select('seq, due_date, amount, status').eq('invoice_id', plano.invoice_id).order('seq'),
    ])
    if (eInv || eParc) return NextResponse.json({ error: `Não foi possível ler a fatura: ${(eInv || eParc)!.message}` }, { status: 500 })
    if (!f) return NextResponse.json({ error: 'Fatura do parcelamento não encontrada.' }, { status: 404 })
    if (f.status === 'void') return NextResponse.json({ error: `A fatura ${f.number} foi cancelada.` }, { status: 409 })
    inv = f
    abertas = (parcelas || []).filter((p: any) => ['scheduled', 'failed'].includes(p.status))
    if (!abertas.length) return NextResponse.json({ error: 'O cronograma não tem parcela em aberto.' }, { status: 409 })
    if (comEntrada) entradaJaLancada = !!jaNoLivro
    const saldoDepois = round2(Number(f.total) - Number(f.paid_total) - (entradaJaLancada ? 0 : Number(plano.entry_amount || 0)))
    const somaAbertas = round2(abertas.reduce((s: number, p: any) => s + Number(p.amount || 0), 0))
    if (Math.abs(saldoDepois - somaAbertas) > 0.009) {
      return NextResponse.json({
        error: `A conta não fecha: as parcelas em aberto somam $${somaAbertas.toFixed(2)} e o saldo da fatura ${f.number} (depois da entrada) é $${saldoDepois.toFixed(2)}. Houve recebimento fora do parcelamento — agendar cobraria valor errado. Cancele este parcelamento e crie outro com o saldo de agora.`,
      }, { status: 409 })
    }
  }
  const conta = plano.invoice_id
    ? fasesDoParcelamento({ frequencia: freq, parcelas: abertas.length, valorParcela: abertas[0].amount, restante: abertas.reduce((s: number, p: any) => s + Number(p.amount || 0), 0) })
    : fasesDoParcelamento({ frequencia: freq, parcelas: plano.installments, valorParcela: plano.installment_amount, restante: Number(plano.total) - Number(plano.entry_amount || 0) })
  if ('erro' in conta) return NextResponse.json({ error: `O cronograma não vira agendamento: ${conta.erro}.` }, { status: 409 })

  // 4. A trilha ANTES de mudar qualquer coisa (princípio 2).
  const { error: errTrilha } = await db.from('plan_audit').insert({
    plan_id: plano.id, action: 'scheduled_by_staff', performed_by: auth.userId, reason: motivo,
    snapshot: {
      sessao: feito.sessao, modo: feito.modo, pagoEm: feito.quando?.toISOString() || null,
      primeiraAntes: original, primeira, parcelas: conta.fases.reduce((s, f) => s + f.parcelas, 0),
      total: conta.totalCentavos / 100, entradaLancadaAgora: !entradaJaLancada,
      ...(aMais.length ? { entradasAMais: aMais.map(f => ({ sessao: f.sessao, valor: f.valor })) } : {}),
    },
  })
  if (errTrilha) return NextResponse.json({ error: `Nada foi feito: não deu para gravar a trilha (${errTrilha.message}).` }, { status: 500 })

  // 5. O cronograma anda para a nova 1ª parcela — senão o aviso de cobrança,
  //    o portal e o contas a receber leem datas que o Stripe não vai seguir.
  if (inv) {
    const base = new Date(`${primeira}T12:00:00Z`)
    const datas = abertas.map((p: any, k: number) => ({ seq: p.seq, antes: p.due_date, depois: avancarData(base, freq, k).toISOString().slice(0, 10) }))
    for (const d of datas) {
      if (String(d.antes).slice(0, 10) === d.depois) continue
      const { error } = await db.from('invoice_installments').update({ due_date: d.depois })
        .eq('invoice_id', inv.id).eq('seq', d.seq)
      if (error) return NextResponse.json({ error: `Não deu para mudar a data da parcela ${d.seq}: ${error.message}. Nada foi agendado.` }, { status: 500 })
    }
    await db.from('invoices').update({ due_date: datas[0].depois, updated_at: new Date().toISOString() }).eq('id', inv.id)
    await db.from('invoice_audit').insert({
      invoice_id: inv.id, action: 'installment_rescheduled', performed_by: auth.userId, reason: motivo,
      previous: { datas: datas.map(d => [d.seq, d.antes]) }, next: { datas: datas.map(d => [d.seq, d.depois]) },
    }).then(() => null, () => null)
  }

  // 6. A entrada que entrou e ficou fora da fatura — com a data em que entrou.
  if (inv && comEntrada && feito.modo === 'payment' && !entradaJaLancada) {
    const r = await lancarRecebimentoStripe(db, {
      invoiceId: inv.id, clientId: plano.client_id, valor: round2(Number(plano.entry_amount)),
      metodo: metodoDoTipo(feito.tipo), referencia: feito.intent, objetoStripe: feito.sessao, recebidoEm: feito.quando,
    })
    if (r.ok === false) {
      return NextResponse.json({ error: `A entrada não entrou na fatura: ${r.motivo}. Nada foi agendado — tente de novo.` }, { status: 500 })
    }
  }
  // A entrada entrou: marcado JÁ, e não só depois do agendamento — se o
  // Stripe recusar o agendamento, o portal não pode voltar a oferecer a
  // entrada (é entry_paid_at que fecha essa porta).
  if (comEntrada && feito.modo === 'payment' && !plano.entry_paid_at) {
    const { error: errPaga } = await db.from('payment_plans')
      .update({ entry_paid_at: (feito.quando || new Date()).toISOString(), updated_at: new Date().toISOString() })
      .eq('id', plano.id)
    if (errPaga) return NextResponse.json({ error: `A entrada está na fatura, mas o plano não registrou que ela foi paga: ${errPaga.message}. Tente de novo.` }, { status: 500 })
  }
  // O status da fatura com o vencimento novo (a definição mora no banco).
  if (inv) await db.rpc('recalcular_status_da_fatura', { fid: inv.id }).then(() => null, () => null)

  // 7. O agendamento.
  let ag
  try {
    ag = await agendarParcelas(stripeClient(), plano, conta, feito.paymentMethod!, new Date(`${primeira}T12:00:00Z`))
  } catch (e) {
    return NextResponse.json({ error: `O Stripe não aceitou o agendamento: ${(e as Error).message}. O cronograma e a entrada já foram acertados — tente de novo.` }, { status: 502 })
  }
  const pagoEm = (feito.modo === 'payment' ? feito.quando : null) || (plano.entry_paid_at ? new Date(plano.entry_paid_at) : null)
  const { error: errAtivar } = await db.from('payment_plans').update({
    status: 'active',
    ...(comEntrada && pagoEm ? { entry_paid_at: pagoEm.toISOString() } : {}),
    stripe_schedule_id: ag.schedule.id,
    stripe_subscription_id: (ag.schedule.subscription as string) || null,
    next_charge_date: ag.inicio.toISOString().slice(0, 10),
    updated_at: new Date().toISOString(),
  }).eq('id', plano.id)
  if (errAtivar) {
    return NextResponse.json({ error: `O agendamento foi criado no Stripe (${ag.schedule.id}), mas o plano não foi atualizado aqui: ${errAtivar.message}. Tente de novo — o agendamento existente é reaproveitado, não duplica.` }, { status: 500 })
  }

  // 8. O cliente fica sabendo: o débito começa numa data que ele não esperava.
  const client = plano.clients || {}
  const lang = String(client.language || 'en').toLowerCase()
  const nParcelas = conta.fases.reduce((s, f) => s + f.parcelas, 0)
  const valor = `$${(conta.fases[0].centavos / 100).toFixed(2)}`
  const quando = fmtUS(ag.inicio.toISOString().slice(0, 10))
  const texto = lang === 'pt'
    ? `📆 Seu parcelamento${inv ? ` da fatura ${inv.number}` : ''} está ativo: ${nParcelas} parcela(s) de ${valor} no débito automático, a primeira em ${quando}.`
    : lang === 'es'
    ? `📆 Su plan de cuotas${inv ? ` de la factura ${inv.number}` : ''} está activo: ${nParcelas} cuota(s) de ${valor} con débito automático, la primera el ${quando}.`
    : `📆 Your installment plan${inv ? ` for invoice ${inv.number}` : ''} is active: ${nParcelas} installment(s) of ${valor} by automatic debit, the first on ${quando}.`
  const aviso = await avisarNoPortal(db, plano.client_id, texto)
  let email: ResultadoEmail = { ok: false, motivo: 'cliente sem e-mail no cadastro' }
  if (client.email) {
    email = await enviarEmail(client.email,
      lang === 'pt' ? 'Seu parcelamento está ativo' : lang === 'es' ? 'Su plan de cuotas está activo' : 'Your installment plan is active',
      emailComMarca({ lang, nome: client.name, corpoHtml: `<p>${texto.replace(/^📆 /, '')}</p>`,
        botao: { texto: lang === 'pt' ? 'Ver em Pagamentos' : lang === 'es' ? 'Ver en Pagos' : 'View in Payments', url: `${APP_URL}/portal/payments` } }))
  }

  if (aMais.length) {
    await db.from('plan_alerts').insert({
      plan_id: plano.id, client_id: plano.client_id, type: 'entrada_em_dobro',
      message: `🛑 ${plano.description || 'Parcelamento'}: o cliente pagou a entrada ${entradasPagas.length} vezes. Só uma entrou na fatura; estorne no painel do Stripe: ${aMais.map(f => `${f.sessao} ($${f.valor.toFixed(2)})`).join(', ')}.`,
    }).then(() => null, () => null)
  }

  return NextResponse.json({
    ok: true,
    message: `Parcelas agendadas no Stripe${ag.reaproveitado ? ' (o agendamento que já existia foi reaproveitado)' : ''}: ${nParcelas}× a partir de ${quando}.`
      + (aMais.length ? ` ATENÇÃO: o cliente pagou a entrada ${entradasPagas.length} vezes — estorne no Stripe ${aMais.map(f => `$${f.valor.toFixed(2)} (${f.sessao})`).join(', ')}.` : '')
      + (inv && comEntrada && !entradaJaLancada ? ` A entrada de $${round2(Number(plano.entry_amount)).toFixed(2)} foi lançada na fatura ${inv.number} com a data em que entrou.` : '')
      + (email.ok ? ' Cliente avisado por e-mail e no portal.' : ` Cliente avisado ${aviso.ok ? 'no portal' : '— o aviso no portal também falhou'}; e-mail não saiu: ${email.motivo}.`),
  })
}
