// lib/emissao-contratos.ts — a rotina diária dos contratos POR FATURA
//
// Quem chama: /api/cron/contratos (Vercel, todo dia). QUANDO e QUANTO se
// cobra é decidirEmissao (lib/contrato-unico.ts, puro, com teste); aqui fica
// só o banco: ler os contratos, emitir a fatura, avisar o cliente e andar a
// régua UM passo.
//
// O contrato por DÉBITO não passa por aqui: quem cobra é a assinatura do
// Stripe, e a fatura dele nasce no webhook (invoice.finalized).
//
// Três garantias, porque isto roda sozinho e mexe na carteira inteira:
//   1. Uma fatura por contrato e por período. Antes de numerar, procura o
//      par (plano, competência); o índice único do banco segura a corrida de
//      duas rodadas simultâneas (23505 = outra rodada já emitiu).
//   2. A régua anda com a condição do valor lido (`next_charge_date = data`):
//      duas rodadas juntas não pulam um período.
//   3. Nada falha calado. O que não emite por defeito do contrato (valor que
//      não bate com as linhas, sem linhas, sem data) vira alerta à equipe,
//      um por contrato por dia — e a resposta da rotina diz cada caso.

// Import relativo e o aviso por PARÂMETRO: o módulo não carrega e-mail nem
// Stripe, e o teste (testes/emissao-contratos.mts) roda com um banco falso.
import { decidirEmissao, rotuloDoPeriodo } from './contrato-unico.ts'

/** Quem avisa o cliente da fatura emitida (na rota: avisarClienteDaFatura). */
export type Avisar = (db: any, inv: any) => Promise<{ email: boolean; motivo?: string }>

const COLUNAS = 'id, client_id, kind, status, description, monthly_amount, discount, due_days, billing_interval, collection_method, due_day, start_date, end_date, next_charge_date, created_by, clients(name, business_name)'

type Linha = { planId: string; cliente: string }

export interface ResultadoDaRotina {
  hoje: string
  dry: boolean
  alvo: number
  emitidas: (Linha & { numero: string; total: number; competencia: string; email: boolean; motivoEmail?: string | null })[]
  jaEmitidas: (Linha & { competencia: string })[]
  encerrados: Linha[]
  recusados: (Linha & { motivo: string })[]
  falhas: (Linha & { motivo: string })[]
}

const nome = (p: any) => p.clients?.business_name || p.clients?.name || '—'

/** As linhas de vários contratos, em blocos; o erro viaja (contrato "sem linhas" não é o mesmo que consulta que falhou). */
async function linhasDosContratos(db: any, ids: string[]) {
  const porPlano = new Map<string, any[]>()
  for (let k = 0; k < ids.length; k += 100) {
    const { data, error } = await db.from('payment_plan_items')
      .select('plan_id, service_id, description, quantity, unit_price, sort_order')
      .in('plan_id', ids.slice(k, k + 100)).order('sort_order').order('created_at')
    if (error) throw new Error(`Linhas dos contratos: ${error.message}`)
    for (const i of data || []) {
      const lista = porPlano.get(i.plan_id)
      if (lista) lista.push(i); else porPlano.set(i.plan_id, [i])
    }
  }
  return porPlano
}

/** Um alerta por contrato por dia — a trilha do plano é a memória, como em planos-parados. */
async function alertarUmaVez(db: any, p: any, hoje: string, motivo: string) {
  const { count, error } = await db.from('plan_audit')
    .select('id', { count: 'exact', head: true })
    .eq('plan_id', p.id).eq('action', 'emission_refused')
    .gte('created_at', `${hoje}T00:00:00Z`)
  if (error || (count ?? 0) > 0) return
  await db.from('plan_alerts').insert({
    plan_id: p.id, client_id: p.client_id, type: 'contrato_nao_emitido',
    message: `🧾 A fatura do contrato "${p.description || 'recorrente'}" de ${nome(p)} NÃO foi emitida: ${motivo}. Abra Financeiro → Contratos.`,
  }).then(() => null, () => null)
  await db.from('plan_audit').insert({
    plan_id: p.id, action: 'emission_refused', snapshot: { motivo, proxima: p.next_charge_date },
  }).then(() => null, () => null)
}

/** Anda a régua UM passo, só se ninguém andou antes (a condição é o valor lido). */
async function andarARegua(db: any, p: any, de: string, para: string) {
  const { error } = await db.from('payment_plans')
    .update({ next_charge_date: para, updated_at: new Date().toISOString() })
    .eq('id', p.id).eq('next_charge_date', de)
  return error ? `a fatura saiu, mas a próxima data não foi gravada (${error.message}) — a rotina de amanhã acha a fatura e acerta` : null
}

export async function emitirFaturasDosContratos(db: any, opts: { hoje: string; dry?: boolean; avisar: Avisar }): Promise<ResultadoDaRotina> {
  const { hoje } = opts
  const dry = !!opts.dry
  const r: ResultadoDaRotina = { hoje, dry, alvo: 0, emitidas: [], jaEmitidas: [], encerrados: [], recusados: [], falhas: [] }

  // Ativos por fatura com a data vencida, com o fim já chegado, ou sem data
  // (este último é defeito: vira alerta, não silêncio).
  const { data: planos, error } = await db.from('payment_plans').select(COLUNAS)
    .in('kind', ['bookkeeping', 'monthly']).eq('collection_method', 'fatura').eq('status', 'active')
    .or(`next_charge_date.lte.${hoje},end_date.lte.${hoje},next_charge_date.is.null`)
    .order('next_charge_date', { ascending: true, nullsFirst: true })
  if (error) throw new Error(`Contratos: ${error.message}`)
  r.alvo = (planos || []).length
  if (!r.alvo) return r

  const porPlano = await linhasDosContratos(db, planos.map((p: any) => p.id))

  for (const p of planos as any[]) {
    const cliente = nome(p)
    const d = decidirEmissao(p, porPlano.get(p.id) || [], hoje)

    if (d.emitir === false) {
      if (d.encerrar) {
        if (dry) { r.encerrados.push({ planId: p.id, cliente }); continue }
        // A trilha ANTES (princípio 2); falhou, não encerra.
        const { error: errT } = await db.from('plan_audit').insert({
          plan_id: p.id, action: 'completed', snapshot: { fim: p.end_date, proxima: p.next_charge_date, origem: 'rotina' },
        })
        if (errT) { r.falhas.push({ planId: p.id, cliente, motivo: `não encerrou: trilha recusada (${errT.message})` }); continue }
        const { error: errU } = await db.from('payment_plans')
          .update({ status: 'completed', updated_at: new Date().toISOString() })
          .eq('id', p.id).eq('status', 'active')
        if (errU) r.falhas.push({ planId: p.id, cliente, motivo: `não encerrou: ${errU.message}` })
        else r.encerrados.push({ planId: p.id, cliente })
        continue
      }
      if (d.motivo === 'ainda não é o dia') continue
      r.recusados.push({ planId: p.id, cliente, motivo: d.motivo })
      if (!dry) await alertarUmaVez(db, p, hoje, d.motivo)
      continue
    }

    const data = String(p.next_charge_date).slice(0, 10)

    // 1. O período já tem fatura? (a da rodada anterior que não andou a
    //    régua, ou uma emitida à mão para este contrato)
    const { data: existente, error: errEx } = await db.from('invoices')
      .select('id, number').eq('plan_id', p.id).eq('competencia', d.competencia).limit(1).maybeSingle()
    if (errEx) { r.falhas.push({ planId: p.id, cliente, motivo: `não deu para conferir o período: ${errEx.message}` }); continue }
    if (existente) {
      r.jaEmitidas.push({ planId: p.id, cliente, competencia: d.competencia })
      if (!dry) {
        const e = await andarARegua(db, p, data, d.seguinte)
        if (e) r.falhas.push({ planId: p.id, cliente, motivo: e })
      }
      continue
    }

    if (dry) {
      r.emitidas.push({ planId: p.id, cliente, numero: '(simulação)', total: d.total, competencia: d.competencia, email: false })
      continue
    }

    // 2. Número do banco (a mesma função atômica da tela e do webhook).
    const { data: num, error: errNum } = await db.rpc('next_invoice_number', { p_kind: 'invoice' })
    if (errNum || !num) { r.falhas.push({ planId: p.id, cliente, motivo: `numeração: ${errNum?.message || 'sem número'}` }); continue }

    const periodo = rotuloDoPeriodo(d.competencia, p.billing_interval)
    const { data: inv, error: errInv } = await db.from('invoices').insert({
      client_id: p.client_id, doc_type: 'invoice', number: num, status: 'sent',
      issue_date: d.emissao, due_date: d.vencimento,
      subtotal: d.bruto, discount: d.desconto, total: d.total,
      payment_plan: 'full', expected_method: null,
      notes: `Contrato recorrente — ${periodo}.`,
      plan_id: p.id, competencia: d.competencia,
      created_by: p.created_by,
    }).select('id, number, client_id, total, paid_total, due_date, doc_type, payment_plan').single()
    if (errInv) {
      // Outra rodada emitiu o mesmo período no meio do caminho: o índice
      // único segurou. O número reservado fica sem uso — é o preço de não
      // emitir duas.
      if (errInv.code === '23505') {
        r.jaEmitidas.push({ planId: p.id, cliente, competencia: d.competencia })
        const e = await andarARegua(db, p, data, d.seguinte)
        if (e) r.falhas.push({ planId: p.id, cliente, motivo: e })
      } else {
        r.falhas.push({ planId: p.id, cliente, motivo: `fatura: ${errInv.message}` })
      }
      continue
    }

    const { error: errItens } = await db.from('invoice_items').insert(d.linhas.map((l, sort) => ({
      invoice_id: inv.id, service_id: l.service_id, description: l.description,
      qty: l.qty, unit_price: l.unit_price, amount: l.amount, sort,
    })))
    if (errItens) {
      // Fatura sem itens com o total é pior que fatura nenhuma (o impresso
      // mostraria um valor sem dizer de quê). Acabou de nascer, sem
      // pagamento: desfaz e tenta de novo amanhã.
      await db.from('invoices').delete().eq('id', inv.id)
      r.falhas.push({ planId: p.id, cliente, motivo: `itens: ${errItens.message}` })
      continue
    }

    const errRegua = await andarARegua(db, p, data, d.seguinte)
    if (errRegua) r.falhas.push({ planId: p.id, cliente, motivo: errRegua })

    // 3. O cliente fica sabendo (portal e e-mail); o resultado vai para a
    //    trilha da fatura — e-mail que não sai diz por quê.
    const aviso = await opts.avisar(db, inv).catch((e: any) => ({ email: false, motivo: `o aviso falhou: ${e?.message || e}` }))
    await db.from('invoice_audit').insert({
      invoice_id: inv.id, action: 'recurring_invoiced',
      next: {
        planId: p.id, competencia: d.competencia, periodo, valor: d.total, origem: 'rotina',
        ultima: d.ultima, email: aviso.email, motivo: aviso.motivo || null,
      },
    }).then(() => null, () => null)

    r.emitidas.push({
      planId: p.id, cliente, numero: inv.number, total: d.total, competencia: d.competencia,
      email: aviso.email, motivoEmail: aviso.motivo || null,
    })
  }
  return r
}
