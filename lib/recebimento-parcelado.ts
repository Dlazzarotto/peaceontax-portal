// lib/recebimento-parcelado.ts — o recebimento por fora numa fatura parcelada.
//
// Decisão do sócio (11/2026), que substitui a regra de 10/2026 ("só a parcela
// exata da vez ou o saldo inteiro, e o Stripe cobra UMA A MENOS no fim"):
//
//   1. Quem recebe ESCOLHE a parcela que está sendo paga.
//   2. A parcela paga por fora NÃO é debitada no mês dela. Na regra antiga o
//      débito daquele mês acontecia mesmo assim (ia para a parcela seguinte) e
//      só a ÚLTIMA deixava de ser cobrada — o cliente que pagava em Zelle era
//      debitado no cartão no mesmo mês.
//   3. Pagou A MAIS: o excedente abate do FIM — da última parcela para trás.
//      Deve $350, paga $500: a parcela escolhida fica paga e a última passa de
//      $350 a $200.
//   4. Pagou A MENOS: abate da própria parcela escolhida.
//   5. Cada débito do Stripe sai com o que FALTA da parcela daquele período —
//      faltando $10 na última, o débito é de $10.
//
// O `amount` de cada linha de `invoice_installments` passa a ser O QUE FALTA
// cobrar dela. É o que o aviso de 3 dias, o portal e a impressão já leem, e é
// o que o webhook usa para abater a cobrança do período no `invoice.created`
// (lib/parcela-stripe.ts). A soma das parcelas em aberto continua igual ao
// saldo da fatura.
//
// Três recusas, todas por causa do Stripe, e todas dizendo o que fazer:
//   · parcela com cobrança JÁ EMITIDA no Stripe (o débito está em andamento ou
//     falhou) só sai inteira: o valor de uma invoice finalizada não muda;
//   · a PRIMEIRA cobrança do agendamento sai sem rascunho (o Stripe a finaliza
//     na hora), então não há como abater dela: também só sai inteira;
//   · nenhuma parcela pode ficar com menos de US$ 0,50 a cobrar — o Stripe não
//     cobra abaixo disso.
//
// Puro: a rota busca o cronograma e chama; a tela chama a MESMA função para
// mostrar antes o que vai acontecer. Em CENTAVOS. testes/recebimento-parcelado.mts.

import { PAGA_ANTES_DO_AGENDAMENTO, STATUS_AMARRAVEIS } from './parcela-stripe.ts'
import { STATUS_VIVOS } from './parcelamento.ts'

/** Mínimo que o Stripe cobra, em centavos (lib/cronograma-parcelas.ts). */
export const MINIMO_CENTAVOS = 50

/** A parcela ainda não foi recebida: o Stripe vai cobrar, ou cobrou e falhou. */
export const STATUS_EM_ABERTO = ['scheduled', 'failed'] as const

export interface ParcelaDoCronograma {
  seq: number
  amount: number | string
  status: string
  stripe_invoice?: string | null
  due_date?: string | null
}

export interface MudancaNaParcela {
  seq: number
  /** O que faltava cobrar nesta parcela, em dólar. */
  de: number
  /** O que falta depois deste recebimento. Zero = quitada. */
  para: number
  statusAntes: string
  quitada: boolean
  /** Cobrança do Stripe JÁ emitida para a parcela quitada: sai da linha (paga fora dele). */
  stripeInvoice: string | null
}

export type DecisaoDoRecebimento =
  | { tipo: 'quitacao' }
  | { tipo: 'recusa'; motivo: string }
  | { tipo: 'alocacao'; escolhida: number; mudancas: MudancaNaParcela[]; resumo: string[] }

const centavos = (v: unknown): number => {
  const n = Math.round(Number(v) * 100)
  return Number.isFinite(n) ? n : 0
}
const dolar = (c: number) => `$${(c / 100).toFixed(2)}`
const dataUS = (d?: string | null) => {
  const [y, m, dia] = String(d || '').slice(0, 10).split('-')
  return y && m && dia ? ` (${m}/${dia}/${y})` : ''
}

export const emAberto = (p: { status: string }) => (STATUS_EM_ABERTO as readonly string[]).includes(String(p.status))
/**
 * A cobrança do Stripe amarrada à parcela, ou null. A marca de "paga antes do
 * agendamento" NÃO é cobrança: é a parcela que ficou FORA do agendamento — se
 * um estorno a reabrir, ela se recebe por fora, sem Stripe nenhum no caminho.
 */
export const cobrancaNoStripe = (p: { stripe_invoice?: string | null }): string | null =>
  p.stripe_invoice && p.stripe_invoice !== PAGA_ANTES_DO_AGENDAMENTO ? String(p.stripe_invoice) : null
/** Em aberto e com cobrança JÁ emitida no Stripe — o valor dela lá não muda mais. */
export const emitida = (p: { status: string; stripe_invoice?: string | null }) => emAberto(p) && !!cobrancaNoStripe(p)

/**
 * Abate `resto` (centavos) das parcelas em aberto, da ÚLTIMA para trás,
 * pulando `exceto`. Parcela já emitida no Stripe só é abatida INTEIRA (ou é
 * pulada). Mexe em `falta` e devolve o que não coube.
 */
export function abaterDoFim(
  abertas: ParcelaDoCronograma[], falta: Map<number, number>, resto: number, exceto: number | null,
): number {
  for (const p of [...abertas].sort((a, b) => b.seq - a.seq)) {
    if (resto <= 0) break
    if (p.seq === exceto) continue
    const r = falta.get(p.seq) || 0
    if (r <= 0) continue
    if (emitida(p)) {
      if (resto >= r) { falta.set(p.seq, 0); resto -= r }
      continue
    }
    const d = Math.min(resto, r)
    falta.set(p.seq, r - d)
    resto -= d
  }
  return resto
}

export function alocarRecebimento(p: {
  parcelas: ParcelaDoCronograma[]
  valor: unknown
  saldo: unknown
  /** A parcela clicada. Sem ela, a primeira em aberto. */
  escolhida?: number | null
  /**
   * A parcela que será a PRIMEIRA cobrança do agendamento no Stripe, quando
   * ele ainda não cobrou nenhuma: ela não passa por rascunho, então não se
   * abate — só se recebe inteira.
   */
  primeiraCobranca?: number | null
}): DecisaoDoRecebimento {
  const valor = centavos(p.valor)
  const saldo = centavos(p.saldo)
  if (valor <= 0) return { tipo: 'recusa', motivo: 'Informe o valor recebido.' }
  if (valor > saldo) return { tipo: 'recusa', motivo: `Valor acima do saldo desta fatura (${dolar(saldo)}).` }
  if (valor === saldo) return { tipo: 'quitacao' }

  const abertas = (p.parcelas || []).filter(emAberto).sort((a, b) => a.seq - b.seq)
  if (!abertas.length) {
    return { tipo: 'recusa', motivo: `Esta fatura parcelada não tem parcela em aberto no cronograma. Recebimento só do saldo inteiro (${dolar(saldo)}).` }
  }
  const alvo = p.escolhida == null ? abertas[0] : abertas.find(x => x.seq === Number(p.escolhida))
  if (!alvo) return { tipo: 'recusa', motivo: `A parcela ${p.escolhida} não está em aberto: escolha uma das parcelas em aberto.` }

  const falta = new Map<number, number>(abertas.map(x => [x.seq, centavos(x.amount)]))
  const antes = new Map(falta)

  // 1. A parcela escolhida.
  const naAlvo = Math.min(valor, falta.get(alvo.seq) || 0)
  if (emitida(alvo) && naAlvo < (falta.get(alvo.seq) || 0)) {
    return {
      tipo: 'recusa',
      motivo: `A parcela ${alvo.seq} já tem cobrança emitida no Stripe, e o valor de uma cobrança emitida não muda: receba os ${dolar(antes.get(alvo.seq)!)} da parcela inteiros — ou mais, que o excedente abate do fim${alvo.status === 'failed' ? ' —, ou use Cobrar novamente' : ''}.`,
    }
  }
  falta.set(alvo.seq, (falta.get(alvo.seq) || 0) - naAlvo)

  // 2. O excedente, da última para trás.
  const sobra = abaterDoFim(abertas, falta, valor - naAlvo, alvo.seq)
  if (sobra > 0) {
    // Ou o valor passa do que as parcelas em aberto somam (o cronograma não
    // cobre o saldo inteiro — entrada ainda não paga, por exemplo), ou o que
    // sobrou só caberia em parcela já emitida, que só se abate inteira.
    const travou = abertas.some(x => x.seq !== alvo.seq && emitida(x) && (falta.get(x.seq) || 0) > 0)
    return {
      tipo: 'recusa',
      motivo: `Sobram ${dolar(sobra)} que não cabem nas parcelas em aberto${travou ? ' (parcela com cobrança já emitida no Stripe só se abate inteira)' : ''}. Receba ${dolar(saldo)} (quita a fatura) ou no máximo ${dolar(valor - sobra)}.`,
    }
  }

  // 3. Nenhuma parcela abaixo do mínimo do Stripe.
  for (const x of abertas) {
    const r = falta.get(x.seq) || 0
    if (r > 0 && r < MINIMO_CENTAVOS) {
      const quita = valor + r
      const ate = valor - (MINIMO_CENTAVOS - r)
      return {
        tipo: 'recusa',
        motivo: `A parcela ${x.seq} ficaria com ${dolar(r)} a cobrar — abaixo de ${dolar(MINIMO_CENTAVOS)}, o mínimo que o Stripe cobra. Receba ${dolar(quita)} (quita a parcela ${x.seq})${ate > 0 ? ` ou no máximo ${dolar(ate)}` : ''}.`,
      }
    }
  }

  // 4. A primeira cobrança do agendamento não passa por rascunho.
  if (p.primeiraCobranca != null) {
    const s = Number(p.primeiraCobranca)
    const r = falta.get(s)
    if (r != null && r > 0 && r < (antes.get(s) || 0)) {
      return {
        tipo: 'recusa',
        motivo: `A parcela ${s} vai ser a primeira cobrança do Stripe neste parcelamento, e essa o Stripe debita sem dar tempo de abater. Receba a parcela ${s} inteira (${dolar(antes.get(s)!)}) — o excedente abate do fim —, ou escolha outra parcela.`,
      }
    }
  }

  const mudancas: MudancaNaParcela[] = []
  for (const x of abertas) {
    const de = antes.get(x.seq) || 0
    const para = falta.get(x.seq) || 0
    if (de === para) continue
    mudancas.push({
      seq: x.seq, de: de / 100, para: para / 100, statusAntes: String(x.status),
      quitada: para === 0, stripeInvoice: para === 0 && emitida(x) ? cobrancaNoStripe(x) : null,
    })
  }

  const resumo: string[] = []
  for (const m of mudancas) {
    const x = abertas.find(a => a.seq === m.seq)!
    const quando = dataUS(x.due_date)
    if (m.seq === alvo.seq) {
      resumo.push(m.quitada
        ? `Parcela ${m.seq}${quando}: ${dolar(Math.round(m.de * 100))} — quitada${m.stripeInvoice ? ' (a cobrança dela no Stripe sai da linha)' : '; o Stripe não debita esta parcela'}`
        : `Parcela ${m.seq}${quando}: recebidos ${dolar(Math.round((m.de - m.para) * 100))}; o Stripe debita só os ${dolar(Math.round(m.para * 100))} que faltam`)
    } else {
      resumo.push(m.quitada
        ? `Parcela ${m.seq}${quando}: ${dolar(Math.round(m.de * 100))} — quitada com o excedente`
        : `Parcela ${m.seq}${quando}: ${dolar(Math.round(m.de * 100))} → ${dolar(Math.round(m.para * 100))} (abatidos ${dolar(Math.round((m.de - m.para) * 100))})`)
    }
  }
  return { tipo: 'alocacao', escolhida: alvo.seq, mudancas, resumo }
}

/**
 * A parcela que vai receber a PRIMEIRA cobrança do agendamento, enquanto o
 * Stripe ainda não cobrou nenhuma — ou null, se já cobrou. É a de menor número
 * ainda sem cobrança (a mesma regra da amarração, lib/parcela-stripe.ts). A
 * primeira cobrança não passa por rascunho, então ela não pode ser abatida.
 *
 * `agendado`: o plano JÁ tem agendamento (ou assinatura) no Stripe. Sem ele —
 * esperando a entrada ou o cadastro do cartão —, as fases ainda vão nascer do
 * cronograma, com o valor já abatido de cada parcela: não há o que recusar.
 */
export function primeiraCobrancaDo(parcelas: ParcelaDoCronograma[], agendado: boolean): number | null {
  if (!agendado) return null
  const comCobranca = (parcelas || []).some(p => !!cobrancaNoStripe(p))
  if (comCobranca) return null
  const livres = (parcelas || [])
    .filter(p => !p.stripe_invoice && (STATUS_AMARRAVEIS as readonly string[]).includes(String(p.status)))
    .sort((a, b) => a.seq - b.seq)
  return livres.length ? livres[0].seq : null
}

/**
 * Quanto abater da cobrança do Stripe de um período, em centavos: o que ela
 * cobra menos o que FALTA da parcela dela. Nunca negativo — se a parcela tem
 * mais a cobrar que a cobrança (não deveria: o valor só diminui), o abatimento
 * é zero e quem chama avisa.
 */
export function abatimentoDaCobranca(p: { cobrancaCentavos: number; parcela: { amount: unknown; status: string } }): number {
  const falta = p.parcela.status === 'paid' ? 0 : centavos(p.parcela.amount)
  return Math.max(0, Math.round(p.cobrancaCentavos) - falta)
}

/**
 * A linha da aba Parcelamentos oferece "Receber parcela"? É a MESMA pergunta
 * que faz o quadro de recebimento tratar a fatura como parcelada
 * (`parcelamentoVivo`, lib/parcelamento.ts): plano vivo, com fatura emitida e
 * com saldo. Antes o recebimento só existia na lista de faturas, e quem
 * cuidava do parcelamento não achava onde dar baixa na parcela. Decidido no
 * servidor e mandado pronto (`podeReceber`) — a tela não recalcula. Plano
 * encerrado não oferece: o saldo de uma fatura cujo parcelamento acabou se
 * recebe como fatura comum.
 */
export function podeReceberNoParcelamento(p: {
  status: string
  temFatura: boolean
  statusDaFatura?: string | null
  saldo: unknown
}): boolean {
  if (!p.temFatura) return false
  if (!(STATUS_VIVOS as readonly string[]).includes(String(p.status))) return false
  if (['draft', 'void', 'paid'].includes(String(p.statusDaFatura ?? ''))) return false
  return centavos(p.saldo) > 0
}

/**
 * O débito do Stripe contra o que FALTA da parcela do período, em centavos.
 *   · exato   — a parcela fica paga;
 *   · excesso — o abatimento do rascunho não aconteceu: a parcela fica paga e
 *               o excedente abate do fim (como o pagamento a mais por fora);
 *   · falta   — debitou MENOS do que falta: um estorno devolveu à parcela um
 *               valor que a cobrança do período já tinha abatido (ou o saldo
 *               de crédito do cliente no Stripe pagou parte). A parcela NÃO
 *               fica paga: fica em aberto com o resto, que se recebe por fora.
 *               Marcar paga sumiria com esse resto — a fatura ficaria com
 *               saldo e nenhuma parcela para recebê-lo.
 */
export type DebitoNaParcela =
  | { tipo: 'exato' }
  | { tipo: 'excesso'; excesso: number }
  | { tipo: 'falta'; resto: number }

export function debitoNaParcela(p: { faltaCentavos: number; pagoCentavos: number }): DebitoNaParcela {
  const falta = Math.round(p.faltaCentavos)
  const pago = Math.round(p.pagoCentavos)
  if (pago > falta) return { tipo: 'excesso', excesso: pago - falta }
  if (pago < falta) return { tipo: 'falta', resto: falta - pago }
  return { tipo: 'exato' }
}

/**
 * Desfaz, numa parcela, o que UM recebimento pôs nela — pela DIFERENÇA, nunca
 * voltando ao valor antigo: depois do recebimento, outro recebimento ou um
 * débito do Stripe pode ter mexido na mesma parcela, e voltar ao valor antigo
 * apagaria isso (ou recusaria desfazer, deixando a fatura com saldo sem
 * parcela que o receba).
 *   · parcela em aberto → soma de volta o que este recebimento abateu dela;
 *   · parcela paga      → reabre com o que este recebimento cobria nela.
 * Assim a soma das parcelas em aberto sobe exatamente o valor estornado.
 *
 * `porFora`: a parcela já tem cobrança no Stripe (ou ficou fora do
 * agendamento). Essa cobrança saiu — ou sai — com o abatimento, e o Stripe não
 * aumenta cobrança: o que voltou para a parcela se recebe POR FORA.
 */
export function estornoNaParcela(p: {
  linha: { amount: unknown; status: string; stripe_invoice?: string | null }
  mudanca: { de: unknown; para: unknown }
}): { amount: number; reabre: boolean; porFora: boolean; devolvido: number } | null {
  const devolvido = centavos(p.mudanca.de) - centavos(p.mudanca.para)
  if (devolvido <= 0) return null
  const aberta = emAberto(p.linha)
  const amount = (aberta ? centavos(p.linha.amount) + devolvido : devolvido) / 100
  return { amount, reabre: !aberta, porFora: !!p.linha.stripe_invoice, devolvido: devolvido / 100 }
}
