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
  ehIntervalo, diaValido, proximaCobranca,
  situacaoDoContrato, mudancasDoContrato, type Intervalo,
} from '@/lib/contrato-recorrente'

export const dynamic = 'force-dynamic'

const COLUNAS = 'id, client_id, description, amount, interval, day_of_month, start_date, end_date, auto_charge, next_run, active'

/** O estado que vai para a trilha — só o que descreve o acordo. */
const retrato = (p: any) => ({
  description: p.description, amount: Number(p.amount), interval: p.interval,
  day_of_month: p.day_of_month, start_date: p.start_date, end_date: p.end_date,
  auto_charge: p.auto_charge, next_run: p.next_run, active: p.active,
})

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

  return NextResponse.json({
    plans: (planos || [])
      // O contrato de uma empresa que o escopo esconde nao aparece aqui.
      .filter((p: any) => !escopo.ocultos.has(p.client_id))
      .map((p: any) => ({
        ...p,
        cliente: p.clients?.business_name || p.clients?.name || '—',
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
  })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const perms = await permissoesFinanceiro(auth.userId)
  if (!perms.receber) {
    return NextResponse.json({ error: 'Criar contrato é de gerente ou sócio.' }, { status: 403 })
  }

  const b = await req.json()
  const valor = Math.round((Number(b.amount) || 0) * 100) / 100
  const dia = diaValido(b.dayOfMonth)
  const inicio = b.startDate || dataDaFirma()

  if (!b.clientId) return NextResponse.json({ error: 'Escolha o cliente.' }, { status: 400 })
  // Escopo por TIPO: o assistente fica em pessoa fisica. Esta rota ficou
  // fora do funil canAccessClient quando o escopo foi criado.
  if (!(await canAccessClient(auth, b.clientId)))
    return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })
  if (!String(b.description || '').trim()) return NextResponse.json({ error: 'Descreva o serviço do contrato.' }, { status: 400 })
  if (valor <= 0) return NextResponse.json({ error: 'Informe o valor mensal.' }, { status: 400 })
  const interval: Intervalo = ehIntervalo(b.interval) ? b.interval : 'monthly'

  const { error } = await serviceDb().from('recurring_plans').insert({
    client_id: b.clientId,
    description: String(b.description).trim(),
    amount: valor,
    interval,
    day_of_month: dia,
    start_date: inicio,
    auto_charge: !!b.autoCharge,
    payment_method_id: b.paymentMethodId || null,
    // A conta respeita o INTERVALO e o dia do ESCRITORIO -- ver
    // lib/contrato-recorrente.ts, que tem os dois defeitos antigos escritos.
    next_run: proximaCobranca(dia, inicio, interval),
    active: true,
  })
  if (error) {
    // O gatilho do banco recusa auto-cobrança sem cartão/ACH salvo
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({
    ok: true,
    message: `Contrato criado · próxima cobrança dia ${dia}`,
  })
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
  if (!perms.receber) {
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
    previous_state: retrato(plano),
    new_state: { ...retrato(plano), ...upd },
  })
  if (errTrilha) {
    return NextResponse.json({
      error: `A alteração NÃO foi feita: não deu para gravar a trilha (${errTrilha.message}). `
        + 'Se a mensagem fala de relação inexistente, falta rodar sql/contrato-recorrente-auditoria-v1.sql.',
    }, { status: 500 })
  }

  const { error } = await db.from('recurring_plans').update(upd).eq('id', plano.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({
    ok: true,
    message: mensagem,
    // Zero é informação: a tela precisa poder dizer O QUE mudou, senão
    // "atualizado" não distingue o que foi feito do que não foi.
    campos: Object.keys(upd),
    proxima: (upd.next_run as string) ?? plano.next_run,
  })
}
