// /api/bookkeeping/payees
//
// GET    ?clientId=            → fornecedores/clientes com uso real
//                                (quantos lançamentos, total, conta mais usada)
// GET    ?all=1                → lista geral (Listas → Fornecedores e clientes):
//                                escopo do cadastro, conta contábil e regra que
//                                classifica cada nome, mais as listas de apoio
//                                (clientes e plano de contas) para os seletores
// POST   { clientId, name, type }                 → cria/atualiza
// PATCH  { id | clientId+name, newName?, type?, category?, scope?, targetClientId? }
//          scope    → 'global' (vale para todos os clientes) ou 'client'
//          category → conta contábil: reclassifica os lançamentos em aberto
//                     deste payee e passa a valer na regra que o classifica
//          newName  → renomeia o payee nos lançamentos também
// DELETE ?id=  ou  ?clientId=&name=  (&limpar=1)
//          remove do cadastro; com limpar=1 apaga o payee dos lançamentos
//
// Registro aprovado nunca é alterado por aqui — só o que aguarda aprovação.
// Cadastro geral (sem cliente) vale para todos: só manager/owner mexe nele.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'

export const dynamic = 'force-dynamic'

const chave = (v: unknown) => String(v ?? '').trim().toLowerCase()

// No ilike, % e _ são curinga. Nome de fornecedor é texto literal: sem escapar,
// "100% Auto" casaria com meia lista e "A_B" com "AXB".
const literal = (v: string) => v.replace(/[\\%_]/g, (m) => '\\' + m)

// Regra que manda no nome: a do próprio cliente ganha da geral.
function regraDoPayee(regras: any[], nome: string, dono: string | null) {
  const iguais = regras.filter(r => chave(r.payee) === chave(nome))
  return iguais.find(r => dono && r.client_id === dono)
    || iguais.find(r => r.client_id === null)
    || null
}

async function todasTransacoes(db: any, clientId: string) {
  const linhas: any[] = []
  for (let i = 0; ; i += 10000) {
    const { data } = await db.from('bank_transactions')
      .select('payee, category, amount, status')
      .eq('client_id', clientId)
      .not('payee', 'is', null)
      .range(i, i + 9999)
    if (!data || data.length === 0) break
    linhas.push(...data)
    if (data.length < 10000) break
  }
  return linhas
}

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const clientId = req.nextUrl.searchParams.get('clientId')

  // Lista geral (tela Listas → Fornecedores e clientes): todos os clientes
  if (!clientId && req.nextUrl.searchParams.get('all') === '1') {
    const dbAll = serviceDb()
    const [cadastro, clientes, regras, contas] = await Promise.all([
      dbAll.from('payees')
        .select('id, name, type, client_id, clients(business_name, name)')
        .eq('active', true).order('name').limit(5000),
      dbAll.from('clients').select('id, name, business_name').eq('active', true).order('name'),
      dbAll.from('bookkeeping_rules').select('id, name, client_id, payee, category')
        .not('payee', 'is', null).limit(5000),
      dbAll.from('bookkeeping_categories').select('name, kind').eq('active', true).order('kind').order('name'),
    ])
    if (cadastro.error) return NextResponse.json({ error: cadastro.error.message }, { status: 500 })

    const listaRegras = regras.data || []
    const nivel = await getStaffLevel(auth.userId)

    return NextResponse.json({
      payees: (cadastro.data || []).map((p: any) => {
        const dono: string | null = p.client_id ?? null
        const regra = regraDoPayee(listaRegras, p.name, dono)
        return {
          id: p.id, name: p.name, type: p.type, clientId: dono,
          cliente: dono ? (p.clients?.business_name || p.clients?.name || '—') : 'Todos os clientes',
          escopo: dono ? 'client' : 'global',
          conta: regra?.category ?? null,
          regraId: regra?.id ?? null,
          regraNome: regra?.name ?? null,
          regraEscopo: regra ? (regra.client_id ? 'client' : 'global') : null,
        }
      }),
      clientes: (clientes.data || []).map((c: any) => ({ id: c.id, nome: c.business_name || c.name })),
      contas: (contas.data || []).map((c: any) => ({ name: c.name, kind: c.kind })),
      podeEscopo: nivel === 'owner' || nivel === 'manager',
    })
  }

  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const { data, error } = await db.from('payees')
    .select('id, name, type').eq('client_id', clientId).eq('active', true)
    .order('type').order('name')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Uso real de cada payee
  const linhas = await todasTransacoes(db, clientId)
  const uso = new Map<string, { total: number; soma: number; aprovados: number; contas: Record<string, number> }>()
  for (const t of linhas) {
    const k = chave(t.payee)
    if (!uso.has(k)) uso.set(k, { total: 0, soma: 0, aprovados: 0, contas: {} })
    const u = uso.get(k)!
    u.total++
    u.soma += Number(t.amount) || 0
    if (t.status === 'approved' || t.status === 'reviewed') u.aprovados++
    if (t.category) u.contas[t.category] = (u.contas[t.category] || 0) + 1
  }

  const payees = (data || []).map((p: any) => {
    const u = uso.get(chave(p.name))
    const contaMaisUsada = u
      ? Object.entries(u.contas).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      : null
    return {
      ...p,
      total: u?.total ?? 0,
      soma: u ? Math.round(u.soma * 100) / 100 : 0,
      aprovados: u?.aprovados ?? 0,
      contaMaisUsada,
      contasDiferentes: u ? Object.keys(u.contas).length : 0,
    }
  })

  return NextResponse.json({ payees })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const { clientId, name, type } = await req.json()
  const clean = String(name || '').trim()
  if (!clientId || clean.length < 2) return NextResponse.json({ error: 'clientId e name obrigatórios' }, { status: 400 })
  if (!['vendor', 'customer'].includes(type)) return NextResponse.json({ error: 'type: vendor ou customer' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const { error } = await serviceDb().from('payees')
    .upsert({ client_id: clientId, name: clean, type }, { onConflict: 'client_id,name' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const b = await req.json()
  const db = serviceDb()

  // Endereço do cadastro: id (preferido) ou clientId+name (compatibilidade).
  // Pelo id o fornecedor geral (sem cliente) também é editável — antes a rota
  // exigia clientId e recusava justamente quem precisava sair de "geral".
  let alvo: any = null
  if (b.id) {
    const { data } = await db.from('payees')
      .select('id, name, type, client_id').eq('id', b.id).maybeSingle()
    alvo = data
  } else if (b.clientId && String(b.name || '').trim()) {
    const { data } = await db.from('payees')
      .select('id, name, type, client_id')
      .eq('client_id', b.clientId).ilike('name', literal(String(b.name).trim())).maybeSingle()
    alvo = data
  }
  if (!alvo) return NextResponse.json({ error: 'Fornecedor não encontrado no cadastro.' }, { status: 404 })

  const nome = String(alvo.name).trim()
  const donoAtual: string | null = alvo.client_id ?? null

  const nivel = await getStaffLevel(auth.userId)
  const ehManager = nivel === 'owner' || nivel === 'manager'
  if (donoAtual) {
    if (!(await canAccessClient(auth, donoAtual))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
  } else if (!ehManager) {
    return NextResponse.json({ error: 'Fornecedor geral vale para todos os clientes — só gerente ou sócio altera.' }, { status: 403 })
  }

  const { newName, type, category } = b
  const partes: string[] = []
  let dono = donoAtual

  // ── Escopo: geral (todos os clientes) × de um cliente só ──
  if (b.scope !== undefined) {
    const paraGlobal = b.scope === 'global'
    const destino: string | null = paraGlobal ? null : (b.targetClientId || b.clientId || donoAtual)
    if (!paraGlobal && !destino) {
      return NextResponse.json({ error: 'Escolha o cliente do fornecedor.' }, { status: 400 })
    }
    if (destino !== donoAtual) {
      if (!ehManager) {
        return NextResponse.json({ error: 'Trocar o escopo do fornecedor é de gerente ou sócio.' }, { status: 403 })
      }
      if (destino && !(await canAccessClient(auth, destino))) {
        return NextResponse.json({ error: 'Sem acesso ao cliente de destino' }, { status: 403 })
      }
      // O mesmo nome não pode existir duas vezes no escopo de destino
      let dup = db.from('payees').select('id').neq('id', alvo.id).ilike('name', literal(nome))
      dup = destino ? dup.eq('client_id', destino) : dup.is('client_id', null)
      const { data: jaTem } = await dup.limit(1)
      if (jaTem && jaTem.length) {
        return NextResponse.json({
          error: `Já existe "${nome}" ${destino ? 'nesse cliente' : 'na lista geral'}. Renomeie ou apague um dos dois antes de mover.`,
        }, { status: 409 })
      }
      const { error: erroEscopo } = await db.from('payees')
        .update({ client_id: destino }).eq('id', alvo.id)
      if (erroEscopo) {
        return NextResponse.json({
          error: `Não foi possível trocar o escopo: ${erroEscopo.message}`
            + (destino ? '' : ' — se a coluna client_id ainda não aceita nulo, rode sql/payees-escopo-v1.sql no Supabase.'),
        }, { status: 500 })
      }
      dono = destino
      partes.push(destino
        ? 'agora é só deste cliente (os lançamentos dos outros clientes com esse nome continuam como estão)'
        : 'agora vale para todos os clientes')
    }
  }

  // ── Conta contábil do fornecedor ──
  if (category) {
    const { data: cat } = await db.from('bookkeeping_categories')
      .select('name').eq('name', category).eq('active', true).maybeSingle()
    if (!cat) return NextResponse.json({ error: 'Conta não encontrada no plano de contas.' }, { status: 400 })

    let mov = db.from('bank_transactions')
      .update({
        category, category_confidence: 100, categorized_by: 'staff',
        status: 'auto', updated_at: new Date().toISOString(),
      })
      .ilike('payee', literal(nome)).in('status', ['pending', 'auto'])
    if (dono) mov = mov.eq('client_id', dono)
    const { data: mudou } = await mov.select('id')

    let cont = db.from('bank_transactions')
      .select('id', { count: 'exact', head: true })
      .ilike('payee', literal(nome)).in('status', ['approved', 'reviewed'])
    if (dono) cont = cont.eq('client_id', dono)
    const { count: aprovados } = await cont

    partes.push(`${(mudou || []).length} lançamento(s) movidos para "${category}"`)
    if ((aprovados ?? 0) > 0) {
      partes.push(`${aprovados} já no registro não foram tocados (use a reclassificação com senha)`)
    }

    // A regra é o que classifica as próximas importações — sem isso a conta
    // voltaria sozinha no próximo extrato.
    const { data: regras } = await db.from('bookkeeping_rules')
      .select('id, name, client_id, payee, category').ilike('payee', literal(nome))
    const regra = regraDoPayee(regras || [], nome, dono)
    if (regra && regra.category !== category) {
      await db.from('bookkeeping_rules').update({ category }).eq('id', regra.id)
      partes.push(`a regra "${regra.name || nome}" passou a classificar em "${category}"`)
    } else if (!regra) {
      partes.push('não há regra para este nome — crie uma no bookkeeping do cliente para valer nas próximas importações')
    }
  }

  if (type && ['vendor', 'customer'].includes(type)) {
    await db.from('payees').update({ type }).eq('id', alvo.id)
    partes.push(`tipo alterado para ${type === 'vendor' ? 'Vendor' : 'Customer'}`)
  }

  if (newName && String(newName).trim() && String(newName).trim() !== nome) {
    const novo = String(newName).trim()
    let dup = db.from('payees').select('id').neq('id', alvo.id).ilike('name', literal(novo))
    dup = dono ? dup.eq('client_id', dono) : dup.is('client_id', null)
    const { data: jaTem } = await dup.limit(1)
    if (jaTem && jaTem.length) {
      return NextResponse.json({ error: `Já existe "${novo}" nesse escopo.` }, { status: 409 })
    }
    await db.from('payees').update({ name: novo }).eq('id', alvo.id)

    let ren = db.from('bank_transactions')
      .update({ payee: novo, updated_at: new Date().toISOString() }).ilike('payee', literal(nome))
    if (dono) ren = ren.eq('client_id', dono)
    const { data: renomeados } = await ren.select('id')

    let regr = db.from('bookkeeping_rules').update({ payee: novo }).ilike('payee', literal(nome))
    if (dono) regr = regr.eq('client_id', dono)
    await regr

    partes.push(`renomeado para "${novo}" em ${(renomeados || []).length} lançamento(s)`)
  }

  if (partes.length === 0) return NextResponse.json({ error: 'Nada para alterar.' }, { status: 400 })
  return NextResponse.json({ ok: true, message: partes.join(' · ') })
}

export async function DELETE(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const id = sp.get('id')
  const limpar = sp.get('limpar') === '1'
  const db = serviceDb()

  let alvo: any = null
  if (id) {
    const { data } = await db.from('payees').select('id, name, client_id').eq('id', id).maybeSingle()
    alvo = data
  } else {
    const clientId = sp.get('clientId')
    const busca = (sp.get('name') || '').trim()
    if (!clientId || !busca) return NextResponse.json({ error: 'id ou clientId+name obrigatórios' }, { status: 400 })
    const { data } = await db.from('payees').select('id, name, client_id')
      .eq('client_id', clientId).ilike('name', literal(busca)).maybeSingle()
    alvo = data
  }
  if (!alvo) return NextResponse.json({ error: 'Fornecedor não encontrado no cadastro.' }, { status: 404 })

  const nome = String(alvo.name).trim()
  const dono: string | null = alvo.client_id ?? null
  if (dono) {
    if (!(await canAccessClient(auth, dono))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
  } else {
    const nivel = await getStaffLevel(auth.userId)
    if (nivel !== 'owner' && nivel !== 'manager') {
      return NextResponse.json({ error: 'Fornecedor geral vale para todos os clientes — só gerente ou sócio apaga.' }, { status: 403 })
    }
  }

  let cont = db.from('bank_transactions').select('id', { count: 'exact', head: true }).ilike('payee', literal(nome))
  if (dono) cont = cont.eq('client_id', dono)
  const { count } = await cont

  if ((count ?? 0) > 0 && !limpar) {
    return NextResponse.json({
      error: `"${nome}" está em ${count} lançamento(s). Confirme se quer apagar também o nome deles.`,
      emUso: count,
    }, { status: 409 })
  }

  let limpos = 0
  if (limpar && (count ?? 0) > 0) {
    let lim = db.from('bank_transactions')
      .update({ payee: null, updated_at: new Date().toISOString() })
      .ilike('payee', literal(nome)).in('status', ['pending', 'auto'])
    if (dono) lim = lim.eq('client_id', dono)
    const { data } = await lim.select('id')
    limpos = (data || []).length
  }

  const { error } = await db.from('payees').delete().eq('id', alvo.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    message: `"${nome}" removido do cadastro`
      + (limpos ? ` · nome apagado de ${limpos} lançamento(s) em aberto` : ''),
  })
}
