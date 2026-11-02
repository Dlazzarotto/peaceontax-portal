// /api/billing/contratos — o contrato recorrente num lugar só (payment_plans)
//
// GET                                → contratos + clientes + serviços + podeContrato
// POST  { clientId, kind?, forma, interval, dayOfMonth, startDate, dueDays,
//         itens, desconto, includedTransactions?, overageRate? }   → cria (rascunho)
// PATCH { id, action }
//   'editar'   { itens, desconto, dueDays?, motivo, password } → vale da PRÓXIMA cobrança
//   'ativar'   {}                                  → fatura: a rotina diária passa a emitir
//   'link'     {}                                  → débito: o link do cadastro no Stripe
//   'pausar' | 'retomar'  { motivo? }
//   'encerrar' { motivo, password }                → não volta
//
// Decisão do sócio: os PLANOS (ficha do cliente) e os CONTRATOS RECORRENTES
// (Financeiro) eram dois cadastros do mesmo acordo — os planos cobravam e
// eram um valor só; os contratos tinham a regra certa e nunca cobraram. O
// motor que fica é o dos planos (as assinaturas ativas vivem nele, e elas
// continuam cobrando); a regra que fica é a dos contratos
// (lib/contrato-recorrente.ts e lib/contrato-unico.ts).
//
// Mexer em contrato é de SÓCIO OU GERENTE, por nível (decisão do sócio): a
// concessão individual de `receber` não basta — com ela, um assistente
// passava a definir quanto a carteira paga todo mês. Editar e encerrar pedem
// SENHA e MOTIVO (princípio 3), e a trilha (`plan_audit`) é gravada ANTES:
// se ela falhar, a alteração não acontece (princípio 2). Mudar o intervalo ou
// a forma de cobrar não existe: é encerrar e criar outro (decisão do sócio).
//
// O ESCOPO POR TIPO vale em todo verbo: `isStaff` diz QUEM chama, e
// `canAccessClient` diz QUAL cliente. As rotas antigas dos planos
// (/api/plans/pause e /checkout) não conferiam — bastava o id.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth, serviceDb, canAccessClient, clientesOcultos } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { colunaAusente } from '@/lib/caixa-firma'
import { dataDaFirma } from '@/lib/dia-da-firma'
import { FILTRO_ATIVO } from '@/lib/catalogo-precos'
import { criarSessaoDoPlano, stripeClient } from '@/lib/plan-checkout'
import {
  ehIntervalo, diaValido, prazoValido, vencimentoDaCobranca, montarContrato,
  type Intervalo,
} from '@/lib/contrato-recorrente'
import {
  ehFormaDeCobranca, cobrancaAPartirDe, decidirEdicao, valorMensalEquivalente,
  recorrenciaDoStripe,
} from '@/lib/contrato-unico'

export const dynamic = 'force-dynamic'

const MIGRACAO = 'Falta rodar sql/contrato-unico-v1.sql e sql/contrato-unico-funcao-v1.sql no Supabase.'
// Uma linha só, de propósito: concatenada com `+`, a string perde o tipo literal
// e o supabase-js não consegue mais ler as colunas do `select` (ParserError).
const COLUNAS = 'id, client_id, kind, status, description, monthly_amount, discount, due_days, billing_interval, collection_method, due_day, start_date, end_date, next_charge_date, stripe_subscription_id, stripe_schedule_id, stripe_session_id, included_transactions, overage_rate, migrated_from, created_by, created_at'
const KINDS = ['bookkeeping', 'monthly']
const VIVOS = ['draft', 'awaiting_setup', 'awaiting_entry', 'active', 'paused', 'payment_failed']

const podeMexerEmContrato = (nivel: string) => nivel === 'owner' || nivel === 'manager'
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

/** Situação para a tela, em uma palavra que a equipe entende. */
function situacao(status: string): string {
  switch (status) {
    case 'draft': return 'rascunho'
    case 'awaiting_setup': case 'awaiting_entry': return 'aguardando o cliente'
    case 'active': return 'ativo'
    case 'paused': return 'pausado'
    case 'payment_failed': return 'débito falhou'
    case 'completed': return 'concluído'
    case 'cancelled': return 'encerrado'
    default: return status
  }
}

/** As linhas de vários contratos — uma consulta, e o erro viaja. */
async function itensDosPlanos(db: any, ids: string[]) {
  const porPlano = new Map<string, any[]>()
  if (!ids.length) return { porPlano, erro: null as string | null }
  for (let k = 0; k < ids.length; k += 100) {
    const { data, error } = await db.from('payment_plan_items')
      .select('id, plan_id, service_id, description, quantity, unit_price, sort_order')
      .in('plan_id', ids.slice(k, k + 100)).order('sort_order').order('created_at')
    // Consulta que falha não vira "contrato sem itens": salvar dali apagaria o acordo.
    if (error) return { porPlano, erro: /payment_plan_items/.test(error.message) && /exist|find/i.test(error.message) ? MIGRACAO : `Itens dos contratos: ${error.message}` }
    for (const i of data || []) {
      const lista = porPlano.get(i.plan_id)
      if (lista) lista.push(i); else porPlano.set(i.plan_id, [i])
    }
  }
  return { porPlano, erro: null }
}

/** O acordo inteiro, itens inclusive — sem as linhas, a trilha diria que o valor mudou e não por quê. */
const retrato = (p: any, itens: any[]) => ({
  description: p.description, valor: Number(p.monthly_amount), desconto: Number(p.discount || 0),
  prazo: Number(p.due_days || 0), intervalo: p.billing_interval, forma: p.collection_method,
  dia: p.due_day, inicio: p.start_date, fim: p.end_date, status: p.status, proxima: p.next_charge_date,
  itens: (itens || []).map((i: any) => ({ d: i.description, q: Number(i.quantity), p: Number(i.unit_price) })),
})

/** Trocar as linhas é UMA operação, no banco, que recalcula o valor (salvar_itens_do_plano). */
async function gravarItens(db: any, planId: string, montado: { itens: any[]; desconto: number }, servicos: (string | null)[] = []) {
  const { data, error } = await db.rpc('salvar_itens_do_plano', {
    p_plan_id: planId,
    p_itens: montado.itens.map((i, ord) => ({
      service_id: servicos[ord] || null, description: i.description, quantity: i.quantity, unit_price: i.unit_price, ord,
    })),
    p_discount: montado.desconto,
  })
  if (error) {
    const m = error.message || ''
    if (/desconto_maior_que_itens/.test(m)) return 'O desconto é maior ou igual à soma dos itens.'
    if (/salvar_itens_do_plano/.test(m) && /does not exist|not find/i.test(m)) return MIGRACAO
    return `Não foi possível gravar os itens: ${m}`
  }
  if (data && data.ok === false) {
    return data.erro === 'sem_itens' ? 'O contrato precisa de pelo menos um item.'
      : data.erro === 'nao_e_contrato' ? 'Parcelamento não se edita aqui.'
      : `Não foi possível gravar os itens: ${data.erro}`
  }
  return null
}

/** Senha da PRÓPRIA pessoa: o padrão da casa para ação sensível. */
async function conferirSenha(db: any, userId: string, senha: unknown) {
  const { data: quem } = await db.auth.admin.getUserById(userId)
  const email = quem?.user?.email
  if (!email) return 'Não foi possível identificar seu login.'
  const sbAuth = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { error } = await sbAuth.auth.signInWithPassword({ email, password: String(senha || '').trim() })
  if (!error) return null
  if (/rate|too many|429/i.test(error.message || '')) return 'Muitas tentativas. Aguarde 1 minuto.'
  return `Senha não confere para ${email}.`
}

/** A trilha ANTES da mudança; devolve o erro — e a rota recusa. */
async function trilha(db: any, plano: any, acao: string, userId: string, motivo: string | null, snapshot: unknown) {
  const { error } = await db.from('plan_audit').insert({
    plan_id: plano.id, action: acao, performed_by: userId, reason: motivo, snapshot,
  })
  return error ? `A alteração NÃO foi feita: não deu para gravar a trilha (${error.message}).` : null
}

export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const nivel = await getStaffLevel(auth.userId)

  const db = serviceDb()
  const [{ data: planos, error }, { data: clients, error: errClientes }, { data: servicos, error: errServicos }, escopo] =
    await Promise.all([
      db.from('payment_plans').select(`${COLUNAS}, clients(business_name, name)`)
        .in('kind', KINDS).order('created_at', { ascending: false }),
      db.from('clients').select('id, business_name, name, type').eq('active', true).order('name'),
      db.from('pricing_items').select('id, label, amount, kind').or(FILTRO_ATIVO).order('sort').order('label'),
      clientesOcultos(auth),
    ])
  if (error) {
    return NextResponse.json({ error: colunaAusente(error) ? MIGRACAO : error.message }, { status: colunaAusente(error) ? 409 : 500 })
  }
  if (errClientes) return NextResponse.json({ error: `Clientes: ${errClientes.message}` }, { status: 500 })
  if (errServicos) return NextResponse.json({ error: `Catálogo de serviços: ${errServicos.message}` }, { status: 500 })
  if (escopo.erro) return NextResponse.json({ error: escopo.erro }, { status: 500 })

  const hoje = dataDaFirma()
  // O contrato de uma empresa que o escopo esconde não aparece aqui.
  const visiveis = (planos || []).filter((p: any) => !escopo.ocultos.has(p.client_id))
  const { porPlano, erro: errItens } = await itensDosPlanos(db, visiveis.map((p: any) => p.id))
  if (errItens) return NextResponse.json({ error: errItens }, { status: errItens === MIGRACAO ? 409 : 500 })

  return NextResponse.json({
    // Os ids do Stripe ficam no servidor: a tela recebe a resposta pronta
    // (temAssinatura), como na aba de Parcelamentos.
    contratos: visiveis.map(({ stripe_subscription_id, stripe_schedule_id, stripe_session_id, ...p }: any) => ({
      ...p,
      temAssinatura: !!(stripe_subscription_id || stripe_schedule_id),
      linkPendente: !!stripe_session_id,
      cliente: p.clients?.business_name || p.clients?.name || '—',
      itens: porPlano.get(p.id) || [],
      situacao: situacao(p.status),
      mensalEquivalente: valorMensalEquivalente(p.monthly_amount, p.billing_interval),
      // Por fatura: emite no dia e vence N dias depois (em DIAS, não em dia do mês).
      vencimento: p.collection_method === 'fatura' && p.next_charge_date
        ? vencimentoDaCobranca(String(p.next_charge_date).slice(0, 10), p.due_days) : null,
      // A data passou com o contrato ATIVO por fatura: a rotina diária não
      // rodou (ou recusou). Sinal honesto, sem adivinhar.
      atrasado: p.collection_method === 'fatura' && p.status === 'active'
        && !!p.next_charge_date && String(p.next_charge_date).slice(0, 10) < hoje,
    })),
    // O tipo vai junto: o contrato de empresa pede o cargo de quem assina.
    clients: (clients || []).filter((c: any) => !escopo.ocultos.has(c.id))
      .map((c: any) => ({ id: c.id, nome: c.business_name || c.name, tipo: c.type })),
    services: (servicos || []).map((x: any) => ({ id: x.id, nome: x.label, preco: Number(x.amount) || 0, kind: x.kind })),
    hoje,
    // A tela não decide: recebe pronto, da MESMA função que trava as escritas.
    podeContrato: podeMexerEmContrato(nivel),
  })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  if (!podeMexerEmContrato(await getStaffLevel(auth.userId))) {
    return NextResponse.json({ error: 'Criar contrato é de gerente ou sócio.' }, { status: 403 })
  }

  const b = await req.json().catch(() => ({} as any))
  if (!b.clientId) return NextResponse.json({ error: 'Escolha o cliente.' }, { status: 400 })
  if (!(await canAccessClient(auth, b.clientId))) return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })

  const kind = b.kind === 'bookkeeping' ? 'bookkeeping' : 'monthly'
  if (!ehFormaDeCobranca(b.forma)) return NextResponse.json({ error: 'Escolha como cobrar: débito automático ou fatura.' }, { status: 400 })
  const intervalo: Intervalo = ehIntervalo(b.interval) ? b.interval : 'monthly'
  // A franquia do bookkeeping é MENSAL (lib/excedente-transacoes.ts): num
  // trimestral, o excedente não teria com o que comparar.
  if (kind === 'bookkeeping' && intervalo !== 'monthly') {
    return NextResponse.json({ error: 'Bookkeeping é mensal: a franquia de transações é por mês.' }, { status: 400 })
  }
  let incluidas: number | null = null
  if (kind === 'bookkeeping') {
    incluidas = Number(b.includedTransactions)
    if (!incluidas || incluidas < 1 || incluidas > 100000) {
      return NextResponse.json({ error: 'Informe quantas transações por mês estão incluídas no contrato.' }, { status: 400 })
    }
  }

  const montado = montarContrato({ itens: b.itens, desconto: b.desconto })
  if ('erro' in montado) return NextResponse.json({ error: montado.erro }, { status: 400 })
  const servicos = (Array.isArray(b.itens) ? b.itens : [])
    .filter((l: any) => String(l?.description ?? '').trim())
    .map((l: any) => (l?.serviceId ? String(l.serviceId) : null))

  const dia = diaValido(b.dayOfMonth)
  const inicio = String(b.startDate || '').slice(0, 10) || dataDaFirma()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio)) return NextResponse.json({ error: 'Data de início inválida.' }, { status: 400 })
  const excedente = kind === 'bookkeeping' ? Number(b.overageRate ?? 1.25) : null
  if (excedente !== null && !(Number.isFinite(excedente) && excedente >= 0 && excedente <= 1000)) {
    return NextResponse.json({ error: 'Valor do excedente por transação inválido.' }, { status: 400 })
  }
  const db = serviceDb()

  // O mesmo acordo duas vezes é a mesma cobrança duas vezes.
  const { data: iguais, error: errIguais } = await db.from('payment_plans')
    .select('id, description').eq('client_id', b.clientId).in('kind', KINDS).in('status', VIVOS)
  if (errIguais) return NextResponse.json({ error: errIguais.message }, { status: 500 })
  const jaTem = (iguais || []).find((x: any) => String(x.description || '').trim().toLowerCase() === montado.resumo.trim().toLowerCase())
  if (jaTem) {
    return NextResponse.json({ error: `Este cliente já tem um contrato de "${montado.resumo}". Encerre o existente ou mude os itens.` }, { status: 409 })
  }

  const { data: criado, error } = await db.from('payment_plans').insert({
    client_id: b.clientId, kind, status: 'draft',
    description: montado.resumo, monthly_amount: montado.total, discount: montado.desconto,
    due_days: b.forma === 'fatura' ? prazoValido(b.dueDays) : 0,
    billing_interval: intervalo, collection_method: b.forma,
    due_day: dia, start_date: inicio,
    included_transactions: incluidas,
    overage_rate: excedente,
    created_by: auth.userId,
  }).select('id').maybeSingle()
  if (error) return NextResponse.json({ error: colunaAusente(error) ? MIGRACAO : error.message }, { status: colunaAusente(error) ? 409 : 400 })
  if (!criado?.id) return NextResponse.json({ error: 'O contrato não foi criado.' }, { status: 500 })

  const erroItens = await gravarItens(db, criado.id, montado, servicos)
  if (erroItens) {
    // Contrato sem linha é um acordo vazio: desfaz em vez de deixar pela metade.
    await db.from('payment_plans').delete().eq('id', criado.id)
    return NextResponse.json({ error: erroItens }, { status: erroItens === MIGRACAO ? 409 : 500 })
  }
  await db.from('plan_audit').insert({
    plan_id: criado.id, action: 'created', performed_by: auth.userId,
    snapshot: { itens: montado.itens, desconto: montado.desconto, total: montado.total, forma: b.forma, intervalo, dia, inicio },
  }).then(() => null, () => null)

  const primeira = cobrancaAPartirDe(dia, inicio, intervalo, dataDaFirma())
  return NextResponse.json({
    ok: true, id: criado.id,
    message: b.forma === 'fatura'
      ? `Contrato criado em rascunho. Ative para começar: a primeira fatura sairia em ${primeira}.`
      : 'Contrato criado em rascunho. Mande o contrato (DocuSign) e o link do débito ao cliente.',
  })
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  if (!podeMexerEmContrato(await getStaffLevel(auth.userId))) {
    return NextResponse.json({ error: 'Alterar contrato é de gerente ou sócio.' }, { status: 403 })
  }

  const b = await req.json().catch(() => ({} as any))
  if (!b.id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })
  const acao = String(b.action || '')
  if (!['editar', 'ativar', 'link', 'pausar', 'retomar', 'encerrar'].includes(acao)) {
    return NextResponse.json({ error: 'Ação desconhecida.' }, { status: 400 })
  }

  const db = serviceDb()
  const { data: plano, error: errPlano } = await db.from('payment_plans')
    .select(`${COLUNAS}, clients(name, email, language)`).eq('id', b.id).maybeSingle()
  if (errPlano) return NextResponse.json({ error: colunaAusente(errPlano) ? MIGRACAO : `Não foi possível ler o contrato: ${errPlano.message}` }, { status: 500 })
  if (!plano || !KINDS.includes(plano.kind)) return NextResponse.json({ error: 'Contrato não encontrado.' }, { status: 404 })
  if (!(await canAccessClient(auth, plano.client_id))) return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })
  if (['cancelled', 'completed'].includes(plano.status)) {
    return NextResponse.json({ error: 'Contrato encerrado não volta — crie um novo.' }, { status: 409 })
  }

  const hoje = dataDaFirma()
  const { porPlano, erro: errItens } = await itensDosPlanos(db, [plano.id])
  if (errItens) return NextResponse.json({ error: errItens }, { status: 500 })
  const itensAntes = porPlano.get(plano.id) || []
  const motivo = String(b.motivo || '').trim()

  // ── Débito: o link do cadastro no Stripe ──
  if (acao === 'link') {
    if (plano.collection_method !== 'debito') return NextResponse.json({ error: 'Contrato por fatura não tem cadastro de débito.' }, { status: 400 })
    if (!['draft', 'awaiting_setup'].includes(plano.status)) {
      return NextResponse.json({ error: `Contrato ${situacao(plano.status)} não gera link novo.` }, { status: 409 })
    }
    try {
      const { url } = await criarSessaoDoPlano(db, stripeClient(), plano, { origem: 'equipe', performedBy: auth.userId })
      return NextResponse.json({ ok: true, url, message: 'Link do débito gerado — vale 24 horas. Copie e envie ao cliente.' })
    } catch (e) {
      return NextResponse.json({ error: `Stripe: ${(e as Error).message}` }, { status: 500 })
    }
  }

  // ── Fatura: ativar (a rotina diária passa a emitir) ──
  if (acao === 'ativar') {
    if (plano.collection_method !== 'fatura') {
      return NextResponse.json({ error: 'No débito, o contrato ativa quando o cliente cadastra o débito pelo link.' }, { status: 400 })
    }
    if (plano.status !== 'draft') return NextResponse.json({ error: `Contrato ${situacao(plano.status)}: ative só o rascunho (pausado se retoma).` }, { status: 409 })
    const inicio = String(plano.start_date || hoje).slice(0, 10)
    const proxima = cobrancaAPartirDe(plano.due_day, inicio, plano.billing_interval, hoje)
    const errT = await trilha(db, plano, 'activated', auth.userId, motivo || null, { antes: retrato(plano, itensAntes), proxima })
    if (errT) return NextResponse.json({ error: errT }, { status: 500 })
    const { error } = await db.from('payment_plans').update({
      status: 'active', start_date: inicio, next_charge_date: proxima,
      // o contrato trazido do módulo antigo pode não ter autor: a fatura leva quem ativou
      created_by: plano.created_by || auth.userId, updated_at: new Date().toISOString(),
    }).eq('id', plano.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, message: `Contrato ativo: a primeira fatura sai em ${proxima}, com vencimento ${vencimentoDaCobranca(proxima, plano.due_days)}.` })
  }

  // ── Pausar / retomar ──
  if (acao === 'pausar' || acao === 'retomar') {
    const pausar = acao === 'pausar'
    if (pausar && !['active', 'payment_failed'].includes(plano.status)) {
      return NextResponse.json({ error: `Contrato ${situacao(plano.status)} não se pausa.` }, { status: 409 })
    }
    if (!pausar && plano.status !== 'paused') return NextResponse.json({ error: 'O contrato não está pausado.' }, { status: 409 })
    const upd: Record<string, unknown> = { status: pausar ? 'paused' : 'active', updated_at: new Date().toISOString() }
    // Retomar refaz a régua a partir de HOJE: o período parado não se cobra.
    if (!pausar && plano.collection_method === 'fatura') {
      upd.next_charge_date = cobrancaAPartirDe(plano.due_day, plano.start_date || hoje, plano.billing_interval, hoje)
    }
    const errT = await trilha(db, plano, pausar ? 'paused' : 'resumed', auth.userId,
      motivo || (pausar ? 'pausado pela tela' : 'retomado pela tela'), { antes: retrato(plano, itensAntes), depois: upd })
    if (errT) return NextResponse.json({ error: errT }, { status: 500 })
    if (plano.collection_method === 'debito') {
      if (!plano.stripe_subscription_id) return NextResponse.json({ error: 'O débito ainda não foi cadastrado no Stripe.' }, { status: 409 })
      try {
        // 'void': o que o Stripe gerar durante a pausa é anulado — nada é cobrado
        await stripeClient().subscriptions.update(plano.stripe_subscription_id, {
          pause_collection: pausar ? { behavior: 'void' } : (null as any),
        })
      } catch (e) {
        return NextResponse.json({ error: `Stripe: ${(e as Error).message}` }, { status: 500 })
      }
    }
    const { error } = await db.from('payment_plans').update(upd).eq('id', plano.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, message: pausar ? 'Contrato pausado — não cobra até retomar.' : `Contrato retomado${upd.next_charge_date ? `: próxima cobrança em ${upd.next_charge_date}` : ''}.` })
  }

  // ── Editar e encerrar: senha e motivo ──
  if (motivo.length < 5) {
    return NextResponse.json({
      error: acao === 'encerrar'
        ? 'Descreva por que o contrato está sendo encerrado (mínimo 5 caracteres). Fica na trilha.'
        : 'Descreva o que está mudando e por quê (mínimo 5 caracteres). Fica na trilha.',
    }, { status: 400 })
  }
  if (!b.password) return NextResponse.json({ error: 'Confirme com a sua senha.' }, { status: 400 })

  if (acao === 'encerrar') {
    const erroSenha = await conferirSenha(db, auth.userId, b.password)
    if (erroSenha) return NextResponse.json({ error: erroSenha }, { status: /Muitas/.test(erroSenha) ? 429 : 401 })
    const errT = await trilha(db, plano, 'cancelled', auth.userId, motivo, { antes: retrato(plano, itensAntes), fim: hoje })
    if (errT) return NextResponse.json({ error: errT }, { status: 500 })
    if (plano.collection_method === 'debito') {
      const stripe = stripeClient()
      try {
        // Encerrar aqui e o Stripe seguir debitando é o pior dos mundos — a
        // rota antiga engolia este erro. Já cancelada no Stripe, segue.
        if (plano.stripe_schedule_id) await stripe.subscriptionSchedules.cancel(plano.stripe_schedule_id)
        else if (plano.stripe_subscription_id) await stripe.subscriptions.cancel(plano.stripe_subscription_id)
      } catch (e) {
        const m = (e as Error).message || ''
        if (!/canceled|cancelled|No such/i.test(m)) {
          return NextResponse.json({ error: `O Stripe não cancelou a assinatura — o contrato continua ativo. ${m}` }, { status: 500 })
        }
      }
      // O link de cadastro que ficou com o cliente deixa de valer.
      if (plano.stripe_session_id && plano.status === 'awaiting_setup') {
        await stripe.checkout.sessions.expire(plano.stripe_session_id).catch(() => null)
      }
    }
    const { error } = await db.from('payment_plans').update({
      status: 'cancelled', end_date: hoje, cancel_reason: motivo, updated_at: new Date().toISOString(),
    }).eq('id', plano.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, message: `Contrato encerrado em ${hoje}.` })
  }

  // ── Editar: itens, desconto e prazo, valendo da PRÓXIMA cobrança ──
  const pode = decidirEdicao(plano)
  if (pode.ok === false) return NextResponse.json({ error: pode.erro }, { status: pode.status })
  if (b.interval !== undefined || b.forma !== undefined || b.dayOfMonth !== undefined) {
    return NextResponse.json({ error: 'Intervalo, dia e forma de cobrar não mudam: encerre e crie outro contrato.' }, { status: 400 })
  }
  const montado = montarContrato({ itens: b.itens, desconto: b.desconto ?? plano.discount })
  if ('erro' in montado) return NextResponse.json({ error: montado.erro }, { status: 400 })
  const servicos = (Array.isArray(b.itens) ? b.itens : [])
    .filter((l: any) => String(l?.description ?? '').trim())
    .map((l: any) => (l?.serviceId || l?.service_id ? String(l.serviceId || l.service_id) : null))

  const mudouLinhas = JSON.stringify(itensAntes.map((i: any) => [String(i.description), Number(i.quantity), Number(i.unit_price)]))
    !== JSON.stringify(montado.itens.map(i => [i.description, i.quantity, i.unit_price]))
  const mudouDesconto = Math.round(Number(plano.discount || 0) * 100) !== Math.round(montado.desconto * 100)
  const prazo = b.dueDays !== undefined && plano.collection_method === 'fatura' ? prazoValido(b.dueDays) : Number(plano.due_days || 0)
  const mudouPrazo = prazo !== Number(plano.due_days || 0)
  if (!mudouLinhas && !mudouDesconto && !mudouPrazo) {
    return NextResponse.json({ error: 'Nada mudou — os valores enviados são os que já estão gravados.' }, { status: 400 })
  }
  const erroSenha = await conferirSenha(db, auth.userId, b.password)
  if (erroSenha) return NextResponse.json({ error: erroSenha }, { status: /Muitas/.test(erroSenha) ? 429 : 401 })

  const valorAntes = round2(plano.monthly_amount)
  const mudaValor = Math.round(montado.total * 100) !== Math.round(valorAntes * 100)
  const errT = await trilha(db, plano, 'edited', auth.userId, motivo, {
    antes: retrato(plano, itensAntes),
    depois: { itens: montado.itens.map(i => ({ d: i.description, q: i.quantity, p: i.unit_price })), desconto: montado.desconto, valor: montado.total, prazo },
  })
  if (errT) return NextResponse.json({ error: errT }, { status: 500 })

  // Débito ATIVO: o preço da assinatura muda no Stripe ANTES de gravar as
  // linhas — se o Stripe recusar, nada muda aqui. Sem proporcional: vale da
  // próxima cobrança (decisão do sócio). Se gravar falhar depois, o Stripe
  // volta ao valor antigo.
  const stripe = pode.mudaStripe && mudaValor ? stripeClient() : null
  let precoAntigo: { item: string; produto: string } | null = null
  if (stripe) {
    try {
      const sub = await stripe.subscriptions.retrieve(plano.stripe_subscription_id)
      const item = sub.items.data[0]
      const produto = typeof item?.price?.product === 'string' ? item.price.product : (item?.price?.product as any)?.id
      if (!item || !produto) return NextResponse.json({ error: 'A assinatura no Stripe não tem o item do preço — confira no painel do Stripe.' }, { status: 409 })
      await stripe.subscriptions.update(sub.id, {
        items: [{ id: item.id, price_data: { currency: 'usd', product: produto, unit_amount: Math.round(montado.total * 100), recurring: recorrenciaDoStripe(plano.billing_interval) } }],
        proration_behavior: 'none',
      })
      precoAntigo = { item: item.id, produto }
    } catch (e) {
      return NextResponse.json({ error: `O Stripe não aceitou o valor novo — nada mudou. ${(e as Error).message}` }, { status: 500 })
    }
  }

  const erroGravar = mudouLinhas || mudouDesconto ? await gravarItens(db, plano.id, montado, servicos) : null
  if (erroGravar) {
    if (stripe && precoAntigo) {
      await stripe.subscriptions.update(plano.stripe_subscription_id, {
        items: [{ id: precoAntigo.item, price_data: { currency: 'usd', product: precoAntigo.produto, unit_amount: Math.round(valorAntes * 100), recurring: recorrenciaDoStripe(plano.billing_interval) } }],
        proration_behavior: 'none',
      }).catch(() => null)
    }
    return NextResponse.json({ error: erroGravar }, { status: 400 })
  }

  const upd: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (mudouPrazo) upd.due_days = prazo
  // O cliente com o link do cadastro na mão autorizaria o valor VELHO: o
  // link deixa de valer, e a equipe gera outro.
  if (pode.refazLink) {
    upd.status = 'draft'
    upd.stripe_session_id = null
    if (plano.stripe_session_id) await stripeClient().checkout.sessions.expire(plano.stripe_session_id).catch(() => null)
  }
  const { error } = await db.from('payment_plans').update(upd).eq('id', plano.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  const quando = plano.next_charge_date ? ` a partir da próxima cobrança (${String(plano.next_charge_date).slice(0, 10)})` : ''
  return NextResponse.json({
    ok: true, total: montado.total,
    message: `Contrato atualizado${mudaValor ? `: ${valorAntes.toFixed(2)} → ${montado.total.toFixed(2)}` : ''}${quando}.`
      + (pode.refazLink ? ' O link de cadastro anterior deixou de valer — gere outro.' : '')
      + (stripe ? ' O preço da assinatura no Stripe mudou, sem cobrança proporcional.' : ''),
  })
}
