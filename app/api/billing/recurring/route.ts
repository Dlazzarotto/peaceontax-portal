// /api/billing/recurring — contratos recorrentes (bookkeeping mensal etc.)
//
// GET                                  → contratos + clientes + serviços
// POST   { clientId, description, amount, interval, dayOfMonth, startDate, autoCharge }
// PATCH  { id, action }
//          'edit'   { description?, amount?, interval?, dayOfMonth?, startDate?,
//                     autoCharge?, motivo, password }
//          'end'    { motivo, password }     → encerra: grava end_date, não volta
//          'pause'  { }                      → suspende, reversível
//          'resume' { }
//
// Criar/editar contrato é de gerente ou sócio: define quanto o cliente
// paga todo mês. Cobrança automática exige cartão/ACH salvo (trava no banco).
//
// EDITAR PEDE SENHA E MOTIVO, E DEIXA TRILHA (princípio 3 e princípio 2).
// Antes não pedia nada: trocava valor, dia e cobrança automática sem rastro,
// enquanto editar uma FATURA — documento único — exige as três coisas. O
// contrato merece mais, não menos: a fatura erra uma vez, o contrato erra
// todo mês. A trilha é `recurring_plan_audit`
// (sql/contrato-recorrente-auditoria-v1.sql) e é gravada ANTES da alteração:
// se ela falhar, a edição é RECUSADA.
//
// PAUSAR/REATIVAR fica em um clique, sem senha: é reversível e não muda o
// acordo. Ainda assim vai para a trilha — quem parou a cobrança e quando é
// pergunta que aparece.
//
// O ESCOPO POR TIPO vale aqui. O POST já passava por `canAccessClient`; o
// PATCH NÃO passava — bastava mandar o `id` de um contrato de empresa.
// `isStaff` diz QUEM chama, não QUAL cliente.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth, serviceDb, canAccessClient, clientesOcultos } from '@/lib/api-auth'
import { permissoesFinanceiro } from '@/lib/billing-perms'
import { dataDaFirma } from '@/lib/dia-da-firma'
import {
  ehIntervalo, diaValido, proximaCobranca, prazoValido, vencimentoDaCobranca,
  situacaoDoContrato, mudancasDoContrato, montarContrato, type Intervalo,
} from '@/lib/contrato-recorrente'

export const dynamic = 'force-dynamic'

const COLUNAS = 'id, client_id, description, amount, discount, due_days, interval, day_of_month, start_date, end_date, auto_charge, next_run, active'

// CRIAR E MEXER EM CONTRATO É DE SÓCIO OU GERENTE, POR NÍVEL — decisão do
// sócio. A trava era `perms.receber`, que gerente e sócio têm por nível MAS
// que também pode ser concedida a uma pessoa específica (`staff_grants`).
// Com a concessão, um assistente passava a definir quanto a carteira paga
// todo mês. Nível é a base; aqui a base é o piso, não o chão.
const podeMexerEmContrato = (nivel: string) => nivel === 'owner' || nivel === 'manager'

/** O estado que vai para a trilha — o acordo inteiro, itens inclusive: sem
 *  as linhas, a trilha diria que o total mudou e não por quê. */
const retrato = (p: any, itens?: any[]) => ({
  description: p.description, amount: Number(p.amount),
  discount: Number(p.discount || 0), due_days: Number(p.due_days || 0),
  interval: p.interval, day_of_month: p.day_of_month,
  start_date: p.start_date, end_date: p.end_date,
  auto_charge: p.auto_charge, next_run: p.next_run, active: p.active,
  ...(itens ? { itens: itens.map(i => ({ d: i.description, q: Number(i.quantity), p: Number(i.unit_price) })) } : {}),
})

/** As linhas de vários contratos de uma vez — uma consulta, não N. */
async function itensDosPlanos(db: any, ids: string[]) {
  const porPlano = new Map<string, any[]>()
  if (ids.length === 0) return { porPlano, erro: null as string | null }
  const { data, error } = await db.from('recurring_plan_items')
    .select('id, plan_id, description, quantity, unit_price, sort_order')
    .in('plan_id', ids).order('sort_order').order('created_at')
  // Consulta que falha nao pode virar 'contrato sem itens': na tela isso e
  // uma AFIRMACAO -- 'este acordo nao tem nada' -- e salvar dali apagaria
  // o que estava. E o mesmo defeito que a edicao de fatura ja teve aqui.
  if (error) return { porPlano, erro: `Itens dos contratos: ${error.message}` }
  for (const i of data || []) {
    const lista = porPlano.get(i.plan_id)
    if (lista) lista.push(i); else porPlano.set(i.plan_id, [i])
  }
  return { porPlano, erro: null }
}

export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)

  const db = serviceDb()
  const [{ data: planos, error }, { data: clients, error: errClientes }, escopo] = await Promise.all([
    db.from('recurring_plans')
      .select(`${COLUNAS}, clients(business_name, name)`)
      .order('active', { ascending: false })
      .order('next_run'),
    db.from('clients').select('id, business_name, name').eq('active', true).order('name'),
    clientesOcultos(auth),
  ])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  // Lista de clientes que falha viraria seletor vazio -- 'nao ha cliente'
  // quando o que houve foi erro de consulta.
  if (errClientes) return NextResponse.json({ error: `Clientes: ${errClientes.message}` }, { status: 500 })
  if (escopo.erro) return NextResponse.json({ error: escopo.erro }, { status: 500 })

  const hoje = dataDaFirma()

  // O contrato de uma empresa que o escopo esconde nao aparece aqui.
  const visiveis = (planos || []).filter((p: any) => !escopo.ocultos.has(p.client_id))
  const { porPlano, erro: errItens } = await itensDosPlanos(db, visiveis.map((p: any) => p.id))
  if (errItens) return NextResponse.json({ error: errItens }, { status: 500 })

  return NextResponse.json({
    plans: visiveis
      .map((p: any) => ({
        ...p,
        cliente: p.clients?.business_name || p.clients?.name || '—',
        itens: porPlano.get(p.id) || [],
        // O vencimento da cobranca do mes: emite no dia, vence N dias
        // depois. Em DIAS e nao em dia do mes -- 'emite no 25 e vence no
        // 10' faria o vencimento cair ANTES da emissao.
        vencimento: p.next_run ? vencimentoDaCobranca(String(p.next_run).slice(0, 10), p.due_days) : null,
        situacao: situacaoDoContrato(p, hoje),
        // A DATA PASSOU E O CONTRATO CONTINUA ATIVO. Quem gera a fatura
        // teria movido o `next_run`; como ele nao andou, nada gerou. E o
        // unico sinal honesto que a tela pode dar sem adivinhar o que
        // existe (ou nao) do lado do banco.
        atrasado: situacaoDoContrato(p, hoje) === 'ativo'
          && !!p.next_run && String(p.next_run).slice(0, 10) < hoje,
      })),
    // Mesmo escopo do POST: sem `verEmpresas`, empresa nao entra na lista.
    clients: (clients || [])
      .filter((c: any) => !escopo.ocultos.has(c.id))
      .map((c: any) => ({ id: c.id, nome: c.business_name || c.name })),
    hoje,
    perms,
    // A TELA PEDE A MESMA CHAVE QUE A ROTA EXIGE, e aqui ela nem escolhe:
    // o servidor manda a resposta pronta. Botao e trava em arquivos
    // diferentes foi a falha de metodo que custou mais caro neste projeto.
    podeContrato: podeMexerEmContrato(perms.nivel),
  })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  if (!podeMexerEmContrato(perms.nivel)) {
    return NextResponse.json({ error: 'Criar contrato é de gerente ou sócio.' }, { status: 403 })
  }

  const b = await req.json()
  const dia = diaValido(b.dayOfMonth)
  const inicio = b.startDate || dataDaFirma()

  if (!b.clientId) return NextResponse.json({ error: 'Escolha o cliente.' }, { status: 400 })
  // Escopo por TIPO: o assistente fica em pessoa fisica. Esta rota ficou
  // fora do funil canAccessClient quando o escopo foi criado.
  if (!(await canAccessClient(auth, b.clientId)))
    return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })

  // O contrato e o MOLDE DE UMA FATURA: itens, desconto e vencimento. O
  // total e o resumo sao DERIVADOS das linhas -- um total digitado a parte
  // deixaria o cabecalho discordar delas.
  const montado = montarContrato({ itens: b.itens, desconto: b.desconto })
  if ('erro' in montado) return NextResponse.json({ error: montado.erro }, { status: 400 })

  const interval: Intervalo = ehIntervalo(b.interval) ? b.interval : 'monthly'
  const db = serviceDb()

  const { data: criado, error } = await db.from('recurring_plans').insert({
    client_id: b.clientId,
    description: montado.resumo,
    amount: montado.total,
    discount: montado.desconto,
    due_days: prazoValido(b.dueDays),
    interval,
    day_of_month: dia,
    start_date: inicio,
    auto_charge: !!b.autoCharge,
    payment_method_id: b.paymentMethodId || null,
    // A conta respeita o INTERVALO e o dia do ESCRITORIO -- ver
    // lib/contrato-recorrente.ts, que tem os dois defeitos antigos escritos.
    next_run: proximaCobranca(dia, inicio, interval),
    active: true,
  }).select('id').maybeSingle()
  if (error) {
    // O gatilho do banco recusa auto-cobrança sem cartão/ACH salvo
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  if (!criado?.id) return NextResponse.json({ error: 'O contrato não foi criado.' }, { status: 500 })

  const erroItens = await gravarItens(db, criado.id, montado)
  if (erroItens) {
    // Contrato sem linha nenhuma e um acordo vazio: desfaz, em vez de
    // deixar um registro pela metade que ninguem entende depois.
    await db.from('recurring_plans').delete().eq('id', criado.id)
    return NextResponse.json({ error: erroItens }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    message: `Contrato criado · ${montado.itens.length} item(ns) · próxima cobrança dia ${dia}`,
  })
}

/**
 * Trocar as linhas e UMA operacao, no banco (`salvar_itens_do_contrato`).
 * Apagar e inserir em duas idas deixaria o contrato SEM NENHUMA LINHA se a
 * segunda falhasse -- o acordo com o cliente apagado por uma falha de rede.
 * E o total que vale e recalculado LA DENTRO: numero vindo do navegador nao
 * define quanto o cliente paga.
 */
async function gravarItens(db: any, planId: string, montado: { itens: any[]; desconto: number }) {
  const { data, error } = await db.rpc('salvar_itens_do_contrato', {
    p_plan_id: planId,
    p_itens: montado.itens.map((i, ord) => ({
      description: i.description, quantity: i.quantity, unit_price: i.unit_price, ord,
    })),
    p_discount: montado.desconto,
  })
  if (error) {
    const m = error.message || ''
    if (/desconto_maior_que_itens/.test(m)) return 'O desconto é maior ou igual à soma dos itens.'
    if (/salvar_itens_do_contrato/.test(m) && /does not exist|not find/i.test(m)) {
      return 'Falta rodar sql/contrato-recorrente-itens-v1.sql e sql/contrato-recorrente-itens-funcao-v1.sql no Supabase.'
    }
    return `Não foi possível gravar os itens: ${m}`
  }
  if (data && data.ok === false) {
    return data.erro === 'sem_itens' ? 'O contrato precisa de pelo menos um item.'
      : data.erro === 'contrato_inexistente' ? 'Contrato não encontrado.'
      : `Não foi possível gravar os itens: ${data.erro}`
  }
  return null
}

/** Senha da PRÓPRIA pessoa: o padrão da casa para ação sensível. */
async function conferirSenha(db: any, userId: string, senha: unknown) {
  const { data: quem } = await db.auth.admin.getUserById(userId)
  const email = quem?.user?.email
  if (!email) return 'Não foi possível identificar seu login.'
  const sbAuth = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
  const { error } = await sbAuth.auth.signInWithPassword({ email, password: String(senha || '').trim() })
  if (!error) return null
  const m = error.message || ''
  if (/rate|too many|429/i.test(m)) return 'Muitas tentativas. Aguarde 1 minuto.'
  return `Senha não confere para ${email}.`
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  if (!podeMexerEmContrato(perms.nivel)) {
    return NextResponse.json({ error: 'Alterar contrato é de gerente ou sócio.' }, { status: 403 })
  }

  const b = await req.json().catch(() => ({} as any))
  if (!b.id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const acao = String(b.action || '')
  if (!['edit', 'end', 'pause', 'resume'].includes(acao)) {
    return NextResponse.json({ error: 'Ação desconhecida.' }, { status: 400 })
  }

  const db = serviceDb()
  const { data: plano, error: errPlano } = await db.from('recurring_plans')
    .select(COLUNAS).eq('id', b.id).maybeSingle()
  // Consulta que falha nao pode virar 'contrato nao encontrado': uma diz
  // para procurar o contrato, a outra para procurar o defeito.
  if (errPlano) return NextResponse.json({ error: `Não foi possível ler o contrato: ${errPlano.message}` }, { status: 500 })
  if (!plano) return NextResponse.json({ error: 'Contrato não encontrado.' }, { status: 404 })

  // isStaff diz QUEM chama; canAccessClient diz QUAL cliente. O PATCH nao
  // conferia o dono -- bastava o id de um contrato de empresa.
  if (!(await canAccessClient(auth, plano.client_id))) {
    return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })
  }

  // As linhas ANTES da mudanca: a trilha sem elas diria que o total mudou
  // e nao por que.
  const { porPlano, erro: errItens } = await itensDosPlanos(db, [plano.id])
  if (errItens) return NextResponse.json({ error: errItens }, { status: 500 })
  const itensAntes = porPlano.get(plano.id) || []

  const hoje = dataDaFirma()
  const situacao = situacaoDoContrato(plano, hoje)
  if (situacao === 'encerrado') {
    return NextResponse.json({
      error: `Este contrato foi encerrado em ${String(plano.end_date).slice(0, 10)}. Contrato encerrado não volta — crie um novo.`,
    }, { status: 409 })
  }

  let upd: Record<string, unknown> = {}
  let motivo = String(b.motivo || '').trim()
  let mensagem = ''
  let novosItens: { itens: any[]; desconto: number; total: number; resumo: string } | null = null

  if (acao === 'pause' || acao === 'resume') {
    const querAtivo = acao === 'resume'
    if (!!plano.active === querAtivo) {
      return NextResponse.json({ error: querAtivo ? 'Este contrato já está ativo.' : 'Este contrato já está pausado.' }, { status: 409 })
    }
    upd = { active: querAtivo }
    // Reativar com a data vencida refaz a régua a partir de hoje; sem isto
    // o contrato voltaria já atrasado, com a data velha.
    if (querAtivo) {
      upd.next_run = proximaCobranca(plano.day_of_month, String(plano.start_date || hoje), plano.interval as Intervalo, hoje)
    }
    motivo = motivo || (querAtivo ? 'reativado pela tela' : 'pausado pela tela')
    mensagem = querAtivo ? 'Contrato reativado.' : 'Contrato pausado — não gera mais cobrança.'
  } else {
    // edit e end: senha e motivo.
    if (motivo.length < 5) {
      return NextResponse.json({
        error: acao === 'end'
          ? 'Descreva por que o contrato está sendo encerrado (mínimo 5 caracteres). Fica na trilha.'
          : 'Descreva o que está mudando e por quê (mínimo 5 caracteres). Fica na trilha.',
      }, { status: 400 })
    }
    if (!b.password) return NextResponse.json({ error: 'Confirme com a sua senha.' }, { status: 400 })

    if (acao === 'edit') {
      const m = mudancasDoContrato(plano, b)
      if (m.erro) return NextResponse.json({ error: m.erro }, { status: 400 })

      // Itens e desconto andam JUNTOS: o total e o resumo saem da lista, e
      // mudar so o desconto muda o total do mesmo jeito.
      if (b.itens !== undefined) {
        const mont = montarContrato({ itens: b.itens, desconto: b.desconto ?? plano.discount })
        if ('erro' in mont) return NextResponse.json({ error: mont.erro }, { status: 400 })
        novosItens = mont
        const mudouLinha = JSON.stringify(itensAntes.map((i: any) => [String(i.description), Number(i.quantity), Number(i.unit_price)]))
          !== JSON.stringify(mont.itens.map(i => [i.description, i.quantity, i.unit_price]))
        const mudouDesconto = Math.round(Number(plano.discount || 0) * 100) !== Math.round(mont.desconto * 100)
        if (mudouLinha) m.campos.push('itens' as any)
        if (mudouDesconto) m.campos.push('desconto' as any)
        if (!mudouLinha && !mudouDesconto) novosItens = null
      }

      if (b.dueDays !== undefined) {
        const prazo = prazoValido(b.dueDays)
        if (prazo !== Number(plano.due_days || 0)) {
          m.update.due_days = prazo
          m.campos.push('dueDays' as any)
        }
      }

      if (m.campos.length === 0) {
        return NextResponse.json({ error: 'Nada mudou — os valores enviados são os que já estão gravados.' }, { status: 400 })
      }
      upd = m.update
      // A régua é ancorada no início: mexeu em dia, início ou intervalo, a
      // próxima data tem de ser recalculada. Sem isto, trocar o dia para 5
      // deixava a próxima cobrança na data antiga, em silêncio.
      if (m.campos.some(c => c === 'dayOfMonth' || c === 'startDate' || c === 'interval')) {
        upd.next_run = proximaCobranca(
          (upd.day_of_month as number) ?? plano.day_of_month,
          String(upd.start_date ?? plano.start_date ?? hoje),
          (upd.interval as Intervalo) ?? (plano.interval as Intervalo),
          hoje,
        )
      }
      mensagem = 'Contrato atualizado.'
    } else {
      // Encerrar PRESERVA (princípio 2): grava a data do fim e desliga, o
      // registro inteiro fica. Apagar contrato seria perder o histórico de
      // quanto esse cliente pagou e por quê.
      upd = { active: false, end_date: hoje }
      mensagem = `Contrato encerrado em ${hoje}.`
    }

    const erroSenha = await conferirSenha(db, auth.userId, b.password)
    if (erroSenha) {
      return NextResponse.json({ error: erroSenha }, { status: /Muitas/.test(erroSenha) ? 429 : 401 })
    }
  }

  // A TRILHA VEM PRIMEIRO. Mudança sem rastro é pior que mudança não feita
  // (princípio 2), então se o insert falhar a alteração é recusada. O preço
  // é que uma linha de trilha pode sobrar se o update seguinte falhar —
  // esse lado é o barato, e o erro do update é devolvido.
  const acaoTrilha = acao === 'edit' ? 'edited' : acao === 'end' ? 'ended' : acao === 'pause' ? 'paused' : 'resumed'
  const { error: errTrilha } = await db.from('recurring_plan_audit').insert({
    plan_id: plano.id,
    client_id: plano.client_id,
    action: acaoTrilha,
    performed_by: auth.userId,
    staff_level: perms.nivel,
    reason: motivo,
    previous_state: retrato(plano, itensAntes),
    new_state: {
      ...retrato(plano, itensAntes), ...upd,
      ...(novosItens ? {
        itens: novosItens.itens.map(i => ({ d: i.description, q: i.quantity, p: i.unit_price })),
        amount: novosItens.total, discount: novosItens.desconto, description: novosItens.resumo,
      } : {}),
    },
  })
  if (errTrilha) {
    return NextResponse.json({
      error: `A alteração NÃO foi feita: não deu para gravar a trilha (${errTrilha.message}). `
        + 'Se a mensagem fala de relação inexistente, falta rodar sql/contrato-recorrente-auditoria-v1.sql.',
    }, { status: 500 })
  }

  // As LINHAS primeiro: a RPC recalcula total, desconto e resumo no banco,
  // e e ela que pode recusar (desconto maior que a soma). Falhando aqui, as
  // colunas escalares nem chegam a mudar.
  if (novosItens) {
    const erroGravar = await gravarItens(db, plano.id, novosItens)
    if (erroGravar) return NextResponse.json({ error: erroGravar }, { status: 400 })
  }

  const { error } = Object.keys(upd).length
    ? await db.from('recurring_plans').update(upd).eq('id', plano.id)
    : { error: null }
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({
    ok: true,
    message: mensagem,
    total: novosItens ? novosItens.total : Number(plano.amount),
    // Zero é informação: a tela precisa poder dizer O QUE mudou, senão
    // "atualizado" não distingue o que foi feito do que não foi.
    campos: Object.keys(upd),
    proxima: (upd.next_run as string) ?? plano.next_run,
  })
}
