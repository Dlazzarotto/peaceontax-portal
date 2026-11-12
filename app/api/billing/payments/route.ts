// /api/billing/payments
//
// POST { invoiceId, amount, method, reference?, receivedAt?, financier? }
//   → registra o recebimento. O saldo e a situação da fatura são
//     atualizados pelo próprio banco (gatilho).
//
// Só quem tem autorização para receber (nível de gerente/sócio, ou
// autorização individual dada pelo sócio em Settings → Users).
//
// Sozinho, só CARTÃO e ZELLE — os dois que deixam rastro fora do sistema
// (Stripe e extrato do banco). Qualquer outra forma, dinheiro em espécie à
// frente, pede a senha de um gerente ou sócio. Como o sócio agora pode
// autorizar `receber` a quem também emite, sem esta trava a mesma pessoa
// emitiria por $500, receberia em espécie e registraria $300.
// Ver lib/recebimento-aprovacao.ts.
// PAGAMENTO PARCIAL É ACEITO em qualquer forma de pagamento.
//
// Aqui havia o oposto escrito, atribuindo ao banco uma recusa de valor
// parcial que ele nunca fez: o gatilho `atualiza_saldo_da_fatura` não valida
// nada, só recalcula `paid_total` e marca a fatura como `partial`. A entrada
// de $250 numa fatura de $1.000 entra e deixa saldo de $750 — que é o que o
// parcelamento usa. O gatilho agora está versionado em
// sql/gatilho-saldo-da-fatura-v1.sql: schema que só existe no banco vira
// folclore, e foi exatamente o que aconteceu com esta linha.
//
// A regra de "à vista" que EXISTE é outra: parcelamento exige cartão ou ACH
// como forma esperada (app/api/billing/invoices), porque o Stripe não debita
// dinheiro automaticamente. Nada a ver com valor parcial.
//
// Fatura com cobrança automática no Stripe (mensalidade ou parcelamento):
// o recebimento manual (Zelle, dinheiro…) tem de mexer na cobrança, senão o
// Stripe cobra de novo.
//   1. mensalidade: só o saldo inteiro → a invoice do Stripe é marcada como
//      paga fora dele e o débito para;
//   2. parcelamento (decisão do sócio, 11/2026 — lib/recebimento-parcelado.ts,
//      com teste): quem recebe ESCOLHE a parcela (`parcela` no corpo); ela
//      leva o valor e NÃO é debitada no mês dela; o que passar dela abate do
//      FIM do cronograma, da última para trás; o que faltar fica nela. O
//      `amount` de cada parcela passa a ser o que falta cobrar, e o webhook
//      abate cada cobrança do Stripe no rascunho (`invoice.created`). Antes
//      só entrava o valor exato da próxima parcela, e o débito daquele mês
//      acontecia mesmo assim — o Stripe cobrava "uma a menos" só no fim;
//   3. parcelamento: o saldo inteiro → quitação antecipada: cancela o débito,
//      liquida as parcelas restantes e conclui o plano.
// A alocação fica na trilha do plano com o id do recebimento: o ESTORNO dele
// devolve a cada parcela o que ele cobria — pela diferença, porque o Stripe
// pode ter debitado alguma delas depois — e diz quanto receber por fora
// quando o Stripe não volta a cobrar (estornoNaParcela).

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { getAuth, serviceDb, canAccessClient } from '@/lib/api-auth'
import { permissoesFinanceiro, RECUSA } from '@/lib/billing-perms'
import { parcelamentoVivo, encerrarParcelamento, STATUS_VIVOS } from '@/lib/parcelamento'
import {
  alocarRecebimento, primeiraCobrancaDo, emAberto, estornoNaParcela, cobrancaNoStripe, type DecisaoDoRecebimento,
} from '@/lib/recebimento-parcelado'
import { recontarParcelas } from '@/lib/parcela-stripe'
import { achEmTransito, diasEmTransito, avisoDeBaixaComAchEmTransito, limparAchEmTransito } from '@/lib/ach-transito'
import { exigeAprovacao, podeAprovar, notaDaAprovacao, AVISO } from '@/lib/recebimento-aprovacao'
import { getStaffLevel } from '@/lib/staff-perms'
import { normalizar as normalizarCodigo, formatoValido as codigoBemFormado,
         RECUSA as RECUSA_CODIGO, type MotivoDaRecusa } from '@/lib/codigo-autorizacao'

export const dynamic = 'force-dynamic'

const MANUAIS = ['zelle', 'venmo', 'cash', 'check', 'wire', 'external', 'other']

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)

  const invoiceId = req.nextUrl.searchParams.get('invoiceId')
  if (!invoiceId) return NextResponse.json({ error: 'invoiceId obrigatório' }, { status: 400 })

  const db = serviceDb()
  const [{ data, error }, { data: inv, error: errInv }, { data: falhas, error: errFalhas }, plano] = await Promise.all([
    db.from('invoice_payments')
      .select('id, amount, method, reference, received_at, stripe_object')
      .eq('invoice_id', invoiceId).order('received_at', { ascending: false }),
    db.from('invoices').select('client_id, stripe_invoice, status, total, paid_total').eq('id', invoiceId).maybeSingle(),
    db.from('invoice_installments').select('seq, amount, last_error, attempts')
      .eq('invoice_id', invoiceId).eq('status', 'failed').order('seq'),
    // Parcelamento vivo: é ELE (e não a stripe_invoice da fatura) que diz
    // "cobrança automática" num parcelamento — as invoices do Stripe ficam
    // nas PARCELAS. Tela e trava decidem pela mesma pergunta.
    parcelamentoVivo(db, invoiceId),
  ])
  if (error)     return NextResponse.json({ error: error.message }, { status: 500 })
  // Sem a fatura, `aberta` sairia false e a tela esconderia "cobrar de novo"
  // como se a fatura estivesse quitada. Sem as parcelas, a que falhou some.
  if (errInv)    return NextResponse.json({ error: `Fatura: ${errInv.message}` }, { status: 500 })
  if (errFalhas) return NextResponse.json({ error: `Parcelas: ${errFalhas.message}` }, { status: 500 })
  // isStaff diz QUEM chama; QUAL cliente é canAccessClient. A rota de
  // recebimentos não conferia: a lista de pagamentos de uma empresa saía a
  // quem não pode abri-la, pelo id da fatura.
  if (inv && !(await canAccessClient(auth, inv.client_id))) {
    return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })
  }

  // O cronograma inteiro: a tela lista as parcelas, quem recebe clica na que
  // está sendo paga e vê ANTES o que vai acontecer — pela MESMA função que a
  // rota usa no POST (alocarRecebimento). Tela e trava não podem discordar.
  let cronograma: any[] = []
  let parcelas: { total: number; pagas: number } | null = null
  let primeiraCobranca: number | null = null
  if (plano) {
    const { data: linhas, error: errLinhas } = await db.from('invoice_installments')
      .select('seq, amount, status, stripe_invoice, due_date').eq('invoice_id', invoiceId).order('seq')
    if (errLinhas) return NextResponse.json({ error: `Cronograma: ${errLinhas.message}` }, { status: 500 })
    cronograma = linhas || []
    parcelas = { total: Number(plano.installments || 0), pagas: cronograma.filter((l: any) => l.status === 'paid').length }
    primeiraCobranca = primeiraCobrancaDo(cronograma, !!(plano.stripe_schedule_id || plano.stripe_subscription_id))
  }
  const proxima = cronograma.find(emAberto) || null

  // Situação da cobrança automática, para a tela mostrar o que pode ser feito
  const aberta = !!inv && !['paid', 'void', 'draft'].includes(inv.status)
  const cobranca = {
    automatica: !!inv?.stripe_invoice || (falhas || []).length > 0 || !!plano,
    parcelado: !!plano,
    falhas: (falhas || []).map((f: any) => ({ seq: f.seq, valor: Number(f.amount), motivo: f.last_error, tentativas: f.attempts })),
    proxima: proxima
      ? { seq: proxima.seq, valor: Number(proxima.amount), status: proxima.status, noStripe: !!proxima.stripe_invoice }
      : null,
    parcelas,
    // Para a tela listar e mostrar a alocação antes de gravar.
    cronograma: cronograma.map((l: any) => ({
      seq: l.seq, amount: Number(l.amount), status: l.status, due_date: l.due_date,
      // A marca de 'paga antes do agendamento' não é cobrança (cobrancaNoStripe).
      stripe_invoice: cobrancaNoStripe(l) ? 'emitida' : null,
    })),
    primeiraCobranca,
    // A entrada ainda não entrou: ela não se recebe por aqui (o cliente a paga
    // pelo link do portal, e é esse pagamento que põe as parcelas a cobrar). O
    // que se registrar aqui vai para as PARCELAS — a tela avisa, para ninguém
    // lançar a entrada como se fosse a parcela 1.
    esperandoEntrada: plano?.status === 'awaiting_entry',
    podeCobrarDeNovo: aberta && (!!inv?.stripe_invoice || (falhas || []).length > 0),
  }
  return NextResponse.json({ payments: data || [], perms, cobranca })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)

  const b = await req.json()

  // ── Estorno ──
  // A trava daqui e `estornar`, e SO ela. Antes havia um `!perms.receber`
  // cobrindo o POST inteiro, acima deste ponto: quem recebesse a autorizacao
  // de estornar sem a de receber via o botao Estornar na tela e levava 403 --
  // a autorizacao por pessoa existe justamente para separar as duas coisas.
  if (b.action === 'refund') {
    if (!perms.estornar) return NextResponse.json({ error: RECUSA.estornar }, { status: 403 })
    if (!b.paymentId) return NextResponse.json({ error: 'paymentId obrigatório' }, { status: 400 })

    const dbR = serviceDb()
    const { data: pag } = await dbR.from('invoice_payments')
      .select('*').eq('id', b.paymentId).single()
    if (!pag) return NextResponse.json({ error: 'Pagamento não encontrado' }, { status: 404 })
    if (!(await canAccessClient(auth, pag.client_id))) {
      return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })
    }

    const motivo = String(b.reason || '').trim()

    // Sócio estorna direto; gerente confirma com senha e justifica
    if (perms.nivel === 'manager') {
      if (motivo.length < 5) {
        return NextResponse.json({ error: 'Descreva o motivo do estorno (mínimo 5 caracteres).' }, { status: 400 })
      }
      if (!b.password) return NextResponse.json({ error: 'Confirme com a sua senha.' }, { status: 400 })

      const { data: quem } = await dbR.auth.admin.getUserById(auth.userId)
      const email = quem?.user?.email
      if (!email) return NextResponse.json({ error: 'Não foi possível identificar seu login.' }, { status: 400 })

      const sbAuth = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      )
      const { error: pwErr } = await sbAuth.auth.signInWithPassword({
        email, password: String(b.password).trim(),
      })
      if (pwErr) {
        const m = pwErr.message || ''
        if (/rate|too many|429/i.test(m)) {
          return NextResponse.json({ error: 'Muitas tentativas. Aguarde 1 minuto.' }, { status: 429 })
        }
        return NextResponse.json({ error: `Senha não confere para ${email}.` }, { status: 401 })
      }
    }

    // UM passo, no banco (sql/recebimento-seguro-v1.sql).
    //
    // Antes eram dois: gravar o rastro com o erro DESCARTADO
    // (`.then(() => null, () => null)`) e depois apagar o recebimento. Se o
    // rastro falhasse, o dinheiro sumia sem registro -- o oposto do princípio
    // 2, e o oposto do que lib/estorno-stripe.ts já fazia certo. E eram dois
    // passos: dois estornos simultâneos do mesmo recebimento gravavam DOIS
    // rastros.
    // Na função, o `delete ... returning` trava a linha (o segundo pedido
    // recebe `ja_estornado`) e, se o rastro falhar, a transação volta atrás e
    // o recebimento FICA. A regra deixou de depender de quem escreve a rota.
    const { data: estorno, error: errEstorno } = await dbR.rpc('estornar_recebimento', {
      p_payment_id:   b.paymentId,
      p_reason:       motivo || 'estorno pelo sócio',
      p_performed_by: auth.userId,
      p_staff_level:  perms.nivel,
    })
    if (errEstorno) {
      return NextResponse.json({
        error: `O estorno NÃO foi feito e o recebimento continua lançado: ${errEstorno.message}`,
      }, { status: 500 })
    }
    const r0 = Array.isArray(estorno) ? estorno[0] : estorno
    if (!r0?.ok) {
      return NextResponse.json({
        error: r0?.motivo === 'ja_estornado'
          ? 'Este recebimento já foi estornado.'
          : 'Não foi possível estornar este recebimento.',
      }, { status: 409 })
    }

    await dbR.from('invoice_audit').insert({
      invoice_id: pag.invoice_id, action: 'payment_reversed', performed_by: auth.userId,
      staff_level: perms.nivel, reason: motivo || null,
      previous: { amount: pag.amount, method: pag.method },
    }).then(() => null, () => null)

    const avisoStripe = pag.stripe_object
      ? ' ⚠️ Este pagamento veio do Stripe: a devolução do dinheiro ao cliente precisa ser feita no painel do Stripe (Refund).'
      : ''
    // Recebimento por fora numa fatura parcelada mexeu no cronograma (parcela
    // quitada, fim abatido): o estorno DESFAZ isso, senão o Stripe deixaria
    // de cobrar um dinheiro que não entrou.
    const notaCronograma = await desfazerAlocacao(dbR, String(b.paymentId), pag.invoice_id, auth.userId)
    return NextResponse.json({
      ok: true,
      message: `Estorno de $${Number(pag.amount).toFixed(2)} registrado. A fatura voltou a ficar em aberto.${avisoStripe}${notaCronograma}`,
    })
  }

  const valor = Math.round((Number(b.amount) || 0) * 100) / 100
  if (!b.invoiceId) return NextResponse.json({ error: 'invoiceId obrigatório' }, { status: 400 })
  if (valor <= 0) return NextResponse.json({ error: 'Informe o valor recebido.' }, { status: 400 })

  const method = String(b.method || '')
  if (!['card', 'ach', ...MANUAIS].includes(method)) {
    return NextResponse.json({ error: 'Forma de pagamento inválida.' }, { status: 400 })
  }

  const db = serviceDb()
  const { data: inv } = await db.from('invoices')
    .select('id, client_id, number, doc_type, total, paid_total, status, stripe_invoice, ach_desde, ach_valor')
    .eq('id', b.invoiceId).single()
  if (!inv) return NextResponse.json({ error: 'Fatura não encontrada' }, { status: 404 })
  if (inv.status === 'void') return NextResponse.json({ error: 'Fatura cancelada não recebe pagamento.' }, { status: 409 })
  if (!(await canAccessClient(auth, inv.client_id))) {
    return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })
  }
  // Quem recebe é a FATURA. Recebimento lançado num orçamento entrava no livro
  // pendurado num documento que ninguém cobra, e o orçamento ficava "pago" sem
  // nunca ter virado fatura. Aprovado, ele vira fatura (Virar fatura).
  if (inv.doc_type === 'estimate') {
    return NextResponse.json({ error: `${inv.number} é orçamento: use Virar fatura e receba na fatura.` }, { status: 409 })
  }

  // Débito em conta a caminho: receber por fora agora vira baixa EM DOBRO
  // quando o banco confirmar. Não se proíbe — o cliente pode ter cancelado o
  // débito e pago por Zelle —, mas ninguém dá baixa sem saber disso.
  const transito = achEmTransito(inv)
  if (transito && b.confirmarComAch !== true) {
    const dias = diasEmTransito(transito.desde)
    return NextResponse.json({
      error: avisoDeBaixaComAchEmTransito(inv.number, transito, dias),
      precisaConfirmarAch: true, achValor: transito.valor, achDias: dias,
    }, { status: 409 })
  }

  const saldo = Math.round((Number(inv.total) - Number(inv.paid_total)) * 100) / 100
  if (valor > saldo + 0.005) {
    return NextResponse.json({
      error: `Valor acima do saldo desta fatura ($${saldo.toFixed(2)}).`,
    }, { status: 400 })
  }

  const iguais = (a: number, c: number) => Math.abs(a - c) < 0.005
  const stripeMensal: string | null = (inv as any).stripe_invoice || null

  // Parcelamento em andamento nesta fatura? (lib/parcelamento: a mesma
  // pergunta em todos os caminhos, e sem maybeSingle() — dois planos na
  // mesma fatura davam erro e a fatura passava como se não tivesse nenhum)
  const plano = await parcelamentoVivo(db, inv.id)

  // O que o recebimento faz no parcelamento — a decisão é pura
  // (lib/recebimento-parcelado.ts, com teste) e a tela mostrou a MESMA antes.
  let cronograma: any[] = []
  let decisao: DecisaoDoRecebimento | null = null
  if (plano) {
    const { data: linhas, error: errLinhas } = await db.from('invoice_installments')
      .select('id, seq, amount, status, stripe_invoice, due_date').eq('invoice_id', inv.id).order('seq')
    if (errLinhas) return NextResponse.json({ error: `Cronograma: ${errLinhas.message}` }, { status: 500 })
    cronograma = linhas || []
    const escolhida = b.parcela == null || b.parcela === '' ? null : Number(b.parcela)
    decisao = alocarRecebimento({
      parcelas: cronograma, valor, saldo, escolhida,
      primeiraCobranca: primeiraCobrancaDo(cronograma, !!(plano.stripe_schedule_id || plano.stripe_subscription_id)),
    })
    if (decisao.tipo === 'recusa') return NextResponse.json({ error: decisao.motivo }, { status: 409 })
  }
  const quitacao = decisao?.tipo === 'quitacao'
  const alocacao = decisao?.tipo === 'alocacao' ? decisao : null
  if (!plano && stripeMensal && !iguais(valor, saldo)) {
    return NextResponse.json({
      error: `Esta fatura de mensalidade está na cobrança automática do Stripe. Recebimento manual só do saldo inteiro ($${saldo.toFixed(2)}): assim ela sai da linha de cobrança e o débito não acontece.`,
    }, { status: 409 })
  }

  // Daqui para baixo entra DINHEIRO: a chave e `receber`. Conferida antes de
  // qualquer gravacao e depois do caminho de estorno, que tem chave propria.
  if (!perms.receber) return NextResponse.json({ error: RECUSA.receber }, { status: 403 })

  // ── Forma fora de cartão/Zelle: aprovação de gerente ou sócio ──
  // Fica por último de propósito: não se manda buscar um gerente para depois
  // a fatura ser recusada por outro motivo.
  // Dois caminhos provam o MESMO fato — "um gerente ou sócio autorizou isto":
  //
  //   CÓDIGO (preferido): o gerente abre a aba Autorização no próprio login,
  //     dita o número, e ele vale para UMA cobrança. Senha de terceiro nunca
  //     é digitada na máquina do balcão, e o limite de tentativas de login do
  //     Supabase — 40 atendimentos/dia do mesmo IP na temporada — não entra
  //     no caminho.
  //   SENHA (reserva): serve quando quem aprova é quem está operando, e
  //     evita travar o balcão se a aba estiver fora do ar.
  //
  // A trilha guarda QUAL dos dois foi usado: sem isso, "aprovado por X" não
  // diz se X estava presente ou se emprestou a senha.
  let aprovador: { email: string; userId: string; via: 'codigo' | 'senha' } | null = null
  if (exigeAprovacao(method)) {
    const codigo = normalizarCodigo(b.approvalCode)

    if (codigo) {
      if (!codigoBemFormado(codigo)) {
        return NextResponse.json({ error: RECUSA_CODIGO.formato, precisaAprovacao: true }, { status: 400 })
      }
      const { data: r, error: errCod } = await db.rpc('consumir_codigo_de_autorizacao', {
        p_codigo: codigo, p_usado_por: auth.userId,
        p_invoice_id: inv.id, p_valor: valor, p_forma: method,
      })
      if (errCod) {
        const faltaFn = /consumir_codigo_de_autorizacao/.test(errCod.message)
        return NextResponse.json({
          error: faltaFn
            ? 'Os códigos de autorização ainda não estão instalados — rode sql/codigo-de-autorizacao-v1.sql.'
            : `Não foi possível validar o código: ${errCod.message}`,
          precisaAprovacao: true,
        }, { status: 500 })
      }
      const linha = Array.isArray(r) ? r[0] : r
      if (!linha?.ok) {
        const motivo = (linha?.motivo || 'nao_encontrado') as MotivoDaRecusa
        return NextResponse.json({
          error: RECUSA_CODIGO[motivo] || RECUSA_CODIGO.nao_encontrado,
          precisaAprovacao: true,
        }, { status: 403 })
      }
      // O código já foi QUEIMADO pela função. Se o nível de quem o emitiu
      // mudou nesses minutos, o recebimento não passa — e o código não
      // volta, de propósito: quem gerou pede outro a quem pode.
      if (!podeAprovar(await getStaffLevel(String(linha.emitido_por)))) {
        return NextResponse.json({ error: RECUSA_CODIGO.nivel, precisaAprovacao: true }, { status: 403 })
      }
      const { data: quemAprovou } = await db.auth.admin.getUserById(String(linha.emitido_por))
      aprovador = {
        userId: String(linha.emitido_por),
        email: quemAprovou?.user?.email || '(sem e-mail)',
        via: 'codigo',
      }
    } else {

    const emailAp = String(b.approverEmail || '').trim().toLowerCase()
    const senhaAp = String(b.approverPassword || '')
    if (!emailAp || !senhaAp) {
      return NextResponse.json({ error: AVISO.falta(method), precisaAprovacao: true }, { status: 400 })
    }
    const sbAp = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
    const { data: sessao, error: apErr } = await sbAp.auth.signInWithPassword({
      email: emailAp, password: senhaAp,
    })
    if (apErr || !sessao?.user) {
      const m = apErr?.message || ''
      if (/rate|too many|429/i.test(m)) {
        return NextResponse.json({ error: AVISO.tentativas, precisaAprovacao: true }, { status: 429 })
      }
      return NextResponse.json({ error: AVISO.senha(emailAp), precisaAprovacao: true }, { status: 401 })
    }
    // Senha certa não basta: tem de ser gerente ou sócio.
    if (!podeAprovar(await getStaffLevel(sessao.user.id))) {
      return NextResponse.json({ error: AVISO.nivel, precisaAprovacao: true }, { status: 403 })
    }
    aprovador = { email: emailAp, userId: sessao.user.id, via: 'senha' }
    }
  }

  const { data: pagamento, error } = await db.from('invoice_payments').insert({
    invoice_id: inv.id,
    client_id: inv.client_id,
    amount: valor,
    method,
    reference: b.reference || null,
    financier: method === 'external' ? (b.financier || null) : null,
    received_at: b.receivedAt ? new Date(b.receivedAt).toISOString() : new Date().toISOString(),
    created_by: auth.userId,
  }).select('id').single()
  if (error) {
    // Não há validação de valor no banco (ver o cabeçalho): o que chega aqui
    // é erro de escrita mesmo — coluna, tipo, permissão. Repassar a mensagem
    // crua é melhor que inventar uma explicação.
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  await db.from('invoice_audit').insert({
    invoice_id: inv.id, action: 'payment', performed_by: auth.userId,
    staff_level: perms.nivel,
    // Quem aprovou fica na trilha da fatura: sem isso a aprovação acontece
    // e não sobra prova de que aconteceu.
    reason: aprovador ? notaDaAprovacao(aprovador.email, valor, method) : null,
    next: {
      amount: valor, method, comAchEmTransito: !!transito,
      ...(aprovador ? {
        aprovadoPor: aprovador.userId,
        aprovadorEmail: aprovador.email,
        // Código ou senha: diz se quem autorizou estava presente ou não.
        aprovadoVia: aprovador.via,
      } : {}),
    },
  }).then(() => null, () => null)

  // A equipe confirmou a baixa sabendo do débito a caminho: o trânsito acabou
  // aqui. Se o ACH cair depois assim mesmo, chega como recebimento novo e o
  // saldo acusa — e é o que se quer, em vez de ficar marcado para sempre.
  if (transito) {
    await limparAchEmTransito(db, inv.id)
    await db.from('invoice_audit').insert({
      invoice_id: inv.id, action: 'ach_descartado', performed_by: auth.userId,
      staff_level: perms.nivel,
      reason: `Recebimento manual registrado com débito de $${transito.valor.toFixed(2)} ainda em trânsito.`,
      next: { valor: transito.valor, desde: transito.desde },
    }).then(() => null, () => null)
  }

  let notaQuitacao = ''
  if (plano && quitacao) {
    const r = await encerrarParcelamento(db, stripeCli(), plano, inv.id,
      { motivo: 'quitacao', performedBy: auth.userId })
    notaQuitacao = r.nota
  }
  else if (plano && alocacao) notaQuitacao = await aplicarAlocacao(db, plano, alocacao, cronograma, inv.id, auth.userId, String(pagamento?.id || ''), valor)
  else if (!plano && stripeMensal) notaQuitacao = await tirarDaLinha(stripeMensal)
    ? ' · saiu da linha de cobrança do Stripe'
    : ' · ATENÇÃO: não consegui avisar o Stripe — marque a invoice como paga fora dele no painel, senão o débito acontece'

  const restante = Math.round((saldo - valor) * 100) / 100
  return NextResponse.json({
    ok: true,
    message: (restante > 0
      ? `Recebido $${valor.toFixed(2)} em ${inv.number} · saldo $${restante.toFixed(2)}`
      : `${inv.number} quitada com $${valor.toFixed(2)}`) + notaQuitacao,
  })
}

const stripeCli = () => new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' as Stripe.LatestApiVersion })

/** Invoice do Stripe marcada como paga fora dele: para de tentar cobrar. */
async function tirarDaLinha(stripeInvoice: string): Promise<boolean> {
  const stripe = stripeCli()
  try { await stripe.invoices.pay(stripeInvoice, { paid_out_of_band: true }); return true }
  catch (e) {
    console.error('paid_out_of_band:', (e as Error).message)
    // Antes de alarmar, pergunta ao Stripe em que pé ela está. Paga ou anulada
    // já não debita nada (a parcela reaberta por um estorno fica amarrada a
    // uma cobrança assim); em RASCUNHO, o invoice.finalized a encontra com a
    // parcela paga e a anula antes do débito. Só a aberta que não saiu da
    // linha é motivo de aviso.
    try {
      const st = (await stripe.invoices.retrieve(stripeInvoice)).status
      return st === 'paid' || st === 'void' || st === 'draft'
    } catch { return false }
  }
}

/**
 * Aplica no cronograma o que o recebimento decidiu (lib/recebimento-parcelado.ts):
 * parcela quitada → `paid` (guarda o valor que tinha); parcela abatida → o
 * `amount` passa a ser o que falta. O Stripe acompanha sozinho: cada cobrança
 * do período é abatida no rascunho pelo webhook. Só a parcela quitada que JÁ
 * tinha cobrança emitida (em andamento ou falhada) precisa de aviso agora:
 * ela sai da linha como paga fora do Stripe.
 *
 * A trilha (com o id do recebimento) vem ANTES: é por ela que o estorno
 * desfaz. `paid_installments` é RECONTADO, nunca incrementado.
 */
async function aplicarAlocacao(
  db: any, plano: any, alocacao: Extract<DecisaoDoRecebimento, { tipo: 'alocacao' }>,
  cronograma: any[], invoiceId: string, userId: string, pagamentoId: string, valor: number,
): Promise<string> {
  const { error: errTrilha } = await db.from('plan_audit').insert({
    plan_id: plano.id, action: 'installment_allocation', performed_by: userId,
    snapshot: { pagamento: pagamentoId, fatura: invoiceId, valor, escolhida: alocacao.escolhida, mudancas: alocacao.mudancas },
  })
  const agora = new Date().toISOString()
  const falhas: string[] = []
  for (const m of alocacao.mudancas) {
    const linha = cronograma.find((l: any) => Number(l.seq) === m.seq)
    if (!linha) { falhas.push(`parcela ${m.seq}`); continue }
    const { error } = await db.from('invoice_installments')
      .update(m.quitada ? { status: 'paid', paid_at: agora } : { amount: m.para })
      .eq('id', linha.id)
    if (error) falhas.push(`parcela ${m.seq} (${error.message})`)
  }
  let stripeOk = true
  for (const m of alocacao.mudancas) {
    if (m.quitada && m.stripeInvoice) stripeOk = (await tirarDaLinha(m.stripeInvoice)) && stripeOk
  }
  const pagas = await recontarParcelas(db, { ...plano, invoice_id: invoiceId })
  const concluiu = pagas >= Number(plano.installments)
  const aindaFalha = cronograma.some((l: any) => l.status === 'failed' && !alocacao.mudancas.some(m => m.seq === Number(l.seq) && m.quitada))
  await db.from('payment_plans').update({
    paid_installments: pagas,
    status: concluiu ? 'completed' : (plano.status === 'payment_failed' && !aindaFalha ? 'active' : plano.status),
    updated_at: agora,
  }).eq('id', plano.id)
  if (concluiu) {
    try {
      // Sem crédito proporcional: o padrão do cancelamento de agendamento é
      // creditar ao cliente, no Stripe, a parte não usada do período — um
      // desconto escondido na próxima cobrança dele (lib/parcelamento.ts).
      if (plano.stripe_schedule_id) await stripeCli().subscriptionSchedules.cancel(plano.stripe_schedule_id, { invoice_now: false, prorate: false })
      else if (plano.stripe_subscription_id) await stripeCli().subscriptions.cancel(plano.stripe_subscription_id)
    } catch (e) { stripeOk = false; console.error('encerrar plano:', (e as Error).message) }
  }
  return ' · ' + alocacao.resumo.join(' · ')
    + (falhas.length ? ` · ⚠️ NÃO consegui ajustar ${falhas.join(', ')} no cronograma — confira antes do próximo débito` : '')
    + (stripeOk ? '' : ' · ⚠️ o Stripe não foi avisado — marque a cobrança como paga fora dele no painel')
    + (errTrilha ? ' · ⚠️ a trilha deste recebimento não foi gravada: se ele for estornado, o cronograma terá de ser acertado à mão' : '')
    + (concluiu ? ' · parcelamento concluído' : '')
}

/**
 * Estorno de um recebimento que mexeu no cronograma: cada parcela volta a
 * dever o que ESTE recebimento cobria nela — pela diferença, não pelo valor
 * antigo (`estornoNaParcela`, lib/recebimento-parcelado.ts). Depois do
 * recebimento o Stripe pode ter debitado a parcela abatida, ou outro
 * recebimento mexido nela; voltar ao valor antigo apagaria isso, e recusar
 * deixaria a fatura com saldo sem parcela que o receba (a tela recusaria
 * receber justamente o que o aviso manda cobrar).
 *
 * O Stripe só DIMINUI cobrança: parcela cuja cobrança do período já existe,
 * a que ficou fora do agendamento e qualquer uma de plano encerrado não voltam
 * a ser debitadas — o que voltou para elas se recebe por fora, e o aviso diz
 * quanto, parcela a parcela.
 */
async function desfazerAlocacao(db: any, pagamentoId: string, invoiceId: string, userId: string): Promise<string> {
  const { data: trilhas, error } = await db.from('plan_audit')
    .select('id, plan_id, snapshot').eq('action', 'installment_allocation').eq('snapshot->>pagamento', pagamentoId)
  if (error) return ` · ⚠️ não consegui ler o que este recebimento mudou no parcelamento (${error.message}) — confira o cronograma`
  if (!trilhas?.length) return ''
  const avisos: string[] = []
  const desfeitas: number[] = []
  const porFora: string[] = []
  for (const t of trilhas) {
    const { data: plano, error: errPlano } = await db.from('payment_plans')
      .select('id, installments, paid_installments, status').eq('id', t.plan_id).maybeSingle()
    if (errPlano) avisos.push(`plano: ${errPlano.message}`)
    // Plano encerrado não tem régua no Stripe: nada do que voltar será debitado.
    const semRegua = !!plano && !(STATUS_VIVOS as readonly string[]).includes(String(plano.status))
    for (const m of (t.snapshot?.mudancas || []) as any[]) {
      const { data: linha, error: e } = await db.from('invoice_installments')
        .select('id, seq, amount, status, stripe_invoice').eq('invoice_id', invoiceId).eq('seq', m.seq).maybeSingle()
      if (e || !linha) { avisos.push(`parcela ${m.seq}: ${e?.message || 'não encontrada'} — devolva $${(Number(m.de) - Number(m.para)).toFixed(2)} a ela à mão`); continue }
      const est = estornoNaParcela({ linha, mudanca: m })
      if (!est) continue
      const { error: eu } = await db.from('invoice_installments')
        .update(est.reabre ? { amount: est.amount, status: 'scheduled', paid_at: null } : { amount: est.amount })
        .eq('id', linha.id)
      if (eu) { avisos.push(`parcela ${m.seq}: ${eu.message} — devolva $${est.devolvido.toFixed(2)} a ela à mão`); continue }
      desfeitas.push(m.seq)
      if (est.porFora || semRegua) porFora.push(`$${est.devolvido.toFixed(2)} da parcela ${m.seq}`)
    }
    if (plano) {
      const pagas = await recontarParcelas(db, { ...plano, invoice_id: invoiceId })
      await db.from('payment_plans').update({ paid_installments: pagas, updated_at: new Date().toISOString() }).eq('id', plano.id)
    }
    await db.from('plan_audit').insert({
      plan_id: t.plan_id, action: 'installment_allocation_reverted', performed_by: userId,
      snapshot: { pagamento: pagamentoId, desfeitas, porFora, avisos },
    }).then(() => null, () => null)
  }
  return (desfeitas.length ? ` · parcelas ${desfeitas.join(', ')} voltaram a dever o que este recebimento cobria` : '')
    + (porFora.length ? ` · ⚠️ o Stripe não volta a debitar isto — receba por fora: ${porFora.join(', ')}` : '')
    + (avisos.length ? ` · ⚠️ ${avisos.join(' · ')}` : '')
}
