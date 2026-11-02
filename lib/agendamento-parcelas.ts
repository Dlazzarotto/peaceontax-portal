// lib/agendamento-parcelas.ts — o agendamento das parcelas no Stripe, num lugar só.
//
// POR QUE ISTO EXISTE
// As parcelas NUNCA foram cobradas. Desde 07/07/2026 o sistema fala com o
// Stripe na versão 2026-06-24.dahlia, e a versão 2025-09-30.clover TIROU o
// parâmetro `iterations` das fases do SubscriptionSchedule (changelog do
// stripe-node: "Remove support for `iterations` on
// SubscriptionScheduleCreateParams.phases[]"). O webhook criava o agendamento
// logo depois da entrada paga, o Stripe recusava, e a rota respondia 500 com
// um console.error e mais nada: o plano ficava "aguardando a entrada", a
// entrada paga não chegava à fatura e nenhuma parcela era agendada. O
// typecheck passava porque o SDK instalado (17.7.0) ainda declara o campo —
// a mesma armadilha do payload pobre da invoice (lib/stripe-invoice.ts).
//
// Três regras daqui:
//   1. A fase dura `duration` (intervalo × quantidade), nunca `iterations`.
//   2. Antes de criar, procura o agendamento que JÁ existe para o plano
//      (metadata.planId). O Stripe reenvia o evento, e a equipe pode agendar
//      à mão: dois agendamentos seriam cada parcela cobrada duas vezes.
//   3. A conta das fases é pura e tem teste (testes/agendamento-parcelas.mts).
//   4. Só o plano que ESPERA o cliente se põe a cobrar. Com o agendamento
//      funcionando, um evento antigo reenviado (pelo Stripe ou pelo painel)
//      reativava o plano cancelado e agendava as parcelas de um acordo
//      desfeito: a única guarda era "já está ativo".
//   5. Entrada DEVOLVIDA ou contestada não é entrada. O `payment_status` da
//      sessão continua 'paid' depois do reembolso; quem diz é a cobrança
//      (`amount_refunded`, `disputed`).

import type Stripe from 'stripe'
import { FREQ_STRIPE, type Frequency } from './plans.ts'

/** O Stripe recusa cobrança abaixo de US$ 0,50 (lib/cronograma-parcelas.ts). */
const MINIMO_CENTAVOS = 50

export interface FaseDoParcelamento {
  rotulo: 'unica' | 'base' | 'ultima'
  /** Quantas parcelas esta fase cobra. */
  parcelas: number
  /** O valor de CADA parcela da fase, em centavos. */
  centavos: number
  /** Quanto a fase dura: o intervalo da cobrança vezes as parcelas dela. */
  duration: { interval: 'week' | 'month'; interval_count: number }
}

export interface ContaDasFases {
  fases: FaseDoParcelamento[]
  /** A recorrência do preço: de quanto em quanto tempo cada parcela é cobrada. */
  recorrencia: { interval: 'week' | 'month'; interval_count: number }
  totalCentavos: number
}

const centavos = (v: unknown) => Math.round((Number(v) || 0) * 100)

/**
 * As fases do agendamento.
 *
 * DUAS FASES quando a última parcela difere: o cronograma faz a última
 * absorver o centavo da divisão (1000/3 = 333.33 + 333.33 + 333.34). Uma fase
 * só cobraria 333.33 três vezes, e a fatura fecharia com 1 centavo em aberto
 * para sempre.
 *
 * `restante` é o que as parcelas têm de somar: o total do plano menos a
 * entrada — ou, quando a equipe agenda depois de algum recebimento por fora,
 * a soma das parcelas que ainda estão em aberto.
 */
export function fasesDoParcelamento(p: {
  frequencia: unknown
  parcelas: unknown
  valorParcela: unknown
  restante: unknown
}): ContaDasFases | { erro: string } {
  const freq = String(p.frequencia) as Frequency
  const recorrencia = FREQ_STRIPE[freq]
  if (!recorrencia) return { erro: `frequência desconhecida (${String(p.frequencia)})` }

  const n = Math.trunc(Number(p.parcelas))
  if (!(n >= 1) || n > 60) return { erro: `quantidade de parcelas inválida (${String(p.parcelas)})` }

  const restanteC = centavos(p.restante)
  if (restanteC <= 0) return { erro: 'não há saldo a parcelar' }

  // Parcela única: o valor é o restante inteiro, não o "valor da parcela".
  const baseC = n === 1 ? restanteC : centavos(p.valorParcela)
  if (baseC <= 0) return { erro: 'o valor da parcela é zero' }
  const ultimaC = restanteC - baseC * (n - 1)
  if (ultimaC <= 0) return { erro: `as parcelas (${n} × ${(baseC / 100).toFixed(2)}) passam do saldo a parcelar (${(restanteC / 100).toFixed(2)})` }
  if (baseC < MINIMO_CENTAVOS || ultimaC < MINIMO_CENTAVOS) {
    return { erro: 'há parcela abaixo de US$ 0,50, o mínimo que o Stripe cobra' }
  }

  const dura = (k: number) => ({ interval: recorrencia.interval, interval_count: recorrencia.interval_count * k })
  const fases: FaseDoParcelamento[] = ultimaC === baseC || n === 1
    ? [{ rotulo: 'unica', parcelas: n, centavos: baseC, duration: dura(n) }]
    : [
        { rotulo: 'base', parcelas: n - 1, centavos: baseC, duration: dura(n - 1) },
        { rotulo: 'ultima', parcelas: 1, centavos: ultimaC, duration: dura(1) },
      ]
  return { fases, recorrencia: { ...recorrencia }, totalCentavos: fases.reduce((s, f) => s + f.parcelas * f.centavos, 0) }
}

// ─────────────────────────── Stripe ───────────────────────────

let produtoEmCache: string | null = null
/** O produto "Parcelamento Peace on Tax" — um só para todos os agendamentos. */
async function produtoDoParcelamento(stripe: Stripe): Promise<string> {
  if (produtoEmCache) return produtoEmCache
  const existente = await stripe.products.search({ query: "name:'Parcelamento Peace on Tax'" }).catch(() => null)
  if (existente?.data?.[0]) { produtoEmCache = String(existente.data[0].id); return produtoEmCache }
  const p = await stripe.products.create({ name: 'Parcelamento Peace on Tax' })
  produtoEmCache = p.id
  return p.id
}

/** O agendamento vivo que já existe para este plano no Stripe, se houver. */
export async function agendamentoExistente(
  stripe: Stripe, customer: string, planId: string,
): Promise<Stripe.SubscriptionSchedule | null> {
  const lista = await stripe.subscriptionSchedules.list({ customer, limit: 100 })
  return (lista.data || []).find(s =>
    s.metadata?.planId === planId && ['not_started', 'active'].includes(String(s.status))) || null
}

/**
 * Cria (ou reaproveita) o agendamento das parcelas.
 *
 * `desejada` no passado vira "começar agora": o Stripe recusa start_date
 * anterior ao instante da criação. A 1ª fase cobra no início, e cada parcela
 * seguinte a cada intervalo; o agendamento se encerra depois da última.
 */
export async function agendarParcelas(
  stripe: Stripe,
  plano: { id: string; stripe_customer_id: string | null },
  conta: ContaDasFases,
  paymentMethod: string,
  desejada: Date,
): Promise<{ schedule: Stripe.SubscriptionSchedule; inicio: Date; reaproveitado: boolean }> {
  if (!plano.stripe_customer_id) throw new Error('o plano não tem cliente no Stripe (o link nunca foi aberto)')
  if (!paymentMethod) throw new Error('sem forma de pagamento salva para debitar as parcelas')

  const ja = await agendamentoExistente(stripe, plano.stripe_customer_id, plano.id)
  if (ja) {
    const ts = Number((ja.phases?.[0] as any)?.start_date || 0)
    return { schedule: ja, inicio: ts ? new Date(ts * 1000) : desejada, reaproveitado: true }
  }

  const agora = Math.floor(Date.now() / 1000)
  const ts = Math.max(Math.floor(desejada.getTime() / 1000), agora + 120)
  const produto = await produtoDoParcelamento(stripe)

  // Montado como objeto solto: os TIPOS do SDK instalado ainda trazem
  // `iterations` e não trazem `duration` — quem manda é a versão da API.
  const params: any = {
    customer: plano.stripe_customer_id,
    start_date: ts,
    end_behavior: 'cancel',
    default_settings: {
      default_payment_method: paymentMethod,
      collection_method: 'charge_automatically',
    },
    phases: conta.fases.map(f => ({
      duration: f.duration,
      items: [{
        quantity: 1,
        price_data: { currency: 'usd', product: produto, unit_amount: f.centavos, recurring: conta.recorrencia },
      }],
      // O metadata da FASE vai para a assinatura: é por ele que o webhook
      // acha o plano de cada cobrança (planoDaInvoice).
      metadata: f.rotulo === 'unica' ? { planId: plano.id } : { planId: plano.id, fase: f.rotulo },
    })),
    metadata: { planId: plano.id, planKind: 'installment' },
  }
  const schedule = await stripe.subscriptionSchedules.create(params)
  return { schedule, inicio: new Date(ts * 1000), reaproveitado: false }
}

/** O que o cliente fez numa sessão de Checkout do plano. */
export interface PagamentoDaSessao {
  sessao: string
  modo: 'payment' | 'setup'
  /** payment: o dinheiro entrou · setup: o débito foi autorizado */
  concluido: boolean
  /** payment: concluída, mas o banco ainda não confirmou (ACH) */
  emProcessamento: boolean
  paymentMethod: string | null
  tipo: string | null
  intent: string | null
  quando: Date | null
  valor: number
  /** payment: quanto o Stripe já DEVOLVEU desta cobrança, em dólar */
  devolvido: number
  /** payment: a cobrança tem contestação (chargeback, ACH não autorizado) */
  contestado: boolean
}

/** Lê da sessão a forma de pagamento salva — da entrada paga ou do mandato. */
export async function pagamentoDaSessao(stripe: Stripe, s: Stripe.Checkout.Session): Promise<PagamentoDaSessao> {
  const base: PagamentoDaSessao = {
    sessao: s.id, modo: s.mode === 'setup' ? 'setup' : 'payment',
    concluido: false, emProcessamento: false,
    paymentMethod: null, tipo: null, intent: null, quando: null,
    valor: Number(s.amount_total || 0) / 100,
    devolvido: 0, contestado: false,
  }
  if (s.mode === 'setup') {
    const siId = typeof s.setup_intent === 'string' ? s.setup_intent : (s.setup_intent as any)?.id
    if (s.status !== 'complete' || !siId) return base
    const si = await stripe.setupIntents.retrieve(siId, { expand: ['payment_method'] })
    const pm = si.payment_method as Stripe.PaymentMethod | string | null
    return {
      ...base, concluido: si.status === 'succeeded',
      paymentMethod: typeof pm === 'string' ? pm : pm?.id || null,
      tipo: typeof pm === 'string' ? null : pm?.type || null,
      quando: new Date(Number(si.created) * 1000),
    }
  }
  const piId = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent as any)?.id
  if (s.status === 'complete' && s.payment_status !== 'paid') return { ...base, emProcessamento: true, intent: piId || null }
  if (s.payment_status !== 'paid' || !piId) return base
  const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['payment_method', 'latest_charge'] })
  const pm = pi.payment_method as Stripe.PaymentMethod | string | null
  // A cobrança diz o que aconteceu DEPOIS: reembolso e contestação não mudam
  // o status da sessão nem o do PaymentIntent. Sem ela não se sabe — e não
  // saber não é "não houve": busca-se.
  let charge = (pi as any).latest_charge as Stripe.Charge | string | null
  if (typeof charge === 'string') charge = await stripe.charges.retrieve(charge)
  return {
    ...base, concluido: true, intent: pi.id,
    paymentMethod: typeof pm === 'string' ? pm : pm?.id || null,
    tipo: typeof pm === 'string' ? null : pm?.type || null,
    // A hora em que o dinheiro entrou: a da cobrança, não a de hoje.
    quando: new Date(Number(charge?.created || pi.created) * 1000),
    devolvido: Number(charge?.amount_refunded || 0) / 100,
    contestado: !!charge?.disputed,
  }
}

/**
 * A entrada que está com a firma: paga, sem devolução e sem contestação.
 * Devolução PARCIAL também tira daqui — lançar o valor cheio seria receita
 * que não existe, e decidir quanto ficou não é coisa que o sistema adivinhe.
 */
export function entradaIntegra(p: PagamentoDaSessao): boolean {
  return p.modo === 'payment' && p.concluido && !(p.devolvido > 0) && !p.contestado
}

/** Paga, e depois devolvida (no todo ou em parte) ou contestada. */
export function entradaQueVoltou(p: PagamentoDaSessao): boolean {
  return p.modo === 'payment' && p.concluido && !entradaIntegra(p)
}

/** Planos que ainda esperam o cliente: só neles a entrada ou o mandato põem o parcelamento a cobrar. */
export const ESPERANDO_O_CLIENTE = ['draft', 'awaiting_entry', 'awaiting_setup']
/** Planos encerrados: nada os põe de volta a cobrar. */
export const ENCERRADOS = ['cancelled', 'completed']

export type DecisaoDaEntrada =
  /** lança a entrada (se ainda não está no livro) e agenda as parcelas */
  | { acao: 'seguir' }
  /** ACH concluído e ainda não confirmado pelo banco: espera o async_payment_succeeded */
  | { acao: 'aguardar_banco' }
  /** reenvio, ou plano que já andou: nada a fazer */
  | { acao: 'nada' }
  /** dinheiro que não é a entrada deste plano: a equipe decide (estorno, acordo novo) */
  | { acao: 'alertar'; tipo: 'entrada_em_dobro' | 'entrada_devolvida' | 'entrada_em_plano_encerrado' }

/**
 * O que o webhook faz com a sessão de ENTRADA de um parcelamento — que chega
 * na primeira vez, e volta sempre que o Stripe (ou alguém no painel) reenvia
 * o evento. Pura, com a tabela inteira em testes/agendamento-parcelas.mts.
 *
 * `noLivro` só tem sentido com fatura: é esta sessão já em invoice_payments.
 */
export function decidirEntradaDoWebhook(a: {
  status: string
  pago: boolean
  devolvido: number
  contestado: boolean
  comFatura: boolean
  noLivro: boolean
  entradaRegistrada: boolean
}): DecisaoDaEntrada {
  const esperando = ESPERANDO_O_CLIENTE.includes(a.status)
  const encerrado = ENCERRADOS.includes(a.status)
  // Plano que já andou ou acabou não espera ACH de entrada nenhuma.
  if (!a.pago) return esperando ? { acao: 'aguardar_banco' } : { acao: 'nada' }
  // O dinheiro voltou (ou pode voltar): não é entrada. No plano que ainda
  // espera, a equipe precisa saber — agendar cobraria as parcelas de um
  // acordo desfeito. No que já andou, quem cuida é o estorno (charge.refunded).
  if (a.devolvido > 0 || a.contestado) return esperando ? { acao: 'alertar', tipo: 'entrada_devolvida' } : { acao: 'nada' }
  if (a.comFatura) {
    if (a.noLivro) return esperando ? { acao: 'seguir' } : { acao: 'nada' }
    // Fora do livro: num plano encerrado é dinheiro de um acordo que acabou;
    // em quem já tem entrada (registrada, ou o plano já anda) é a segunda.
    if (encerrado) return { acao: 'alertar', tipo: 'entrada_em_plano_encerrado' }
    if (!esperando || a.entradaRegistrada) return { acao: 'alertar', tipo: 'entrada_em_dobro' }
    return { acao: 'seguir' }
  }
  // Sem fatura (parcelamento antigo): a entrada não vai ao livro, então não
  // há como saber se é reenvio. O que espera segue; o encerrado avisa.
  if (esperando) return { acao: 'seguir' }
  return encerrado ? { acao: 'alertar', tipo: 'entrada_em_plano_encerrado' } : { acao: 'nada' }
}

/** As sessões de Checkout deste plano. A paga pode não ser a última gerada. */
export async function sessoesDoPlano(stripe: Stripe, customer: string, planId: string): Promise<Stripe.Checkout.Session[]> {
  const lista = await stripe.checkout.sessions.list({ customer, limit: 100 })
  return (lista.data || []).filter(s => s.metadata?.planId === planId)
}

/** Forma do pagamento para o livro: ACH, financiado (Klarna) ou cartão. */
export function metodoDoTipo(tipo: string | null | undefined): 'ach' | 'external' | 'card' {
  return tipo === 'us_bank_account' ? 'ach' : tipo === 'klarna' ? 'external' : 'card'
}
