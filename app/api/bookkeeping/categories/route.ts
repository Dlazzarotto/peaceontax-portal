// GET  /api/bookkeeping/categories — lista (equipe)
// POST /api/bookkeeping/categories { name, kind, parent? } — cria (manager/owner)
//   parent: nome de categoria existente do MESMO kind → sub-conta "Pai: Filho"

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const todas = req.nextUrl.searchParams.get('all') === '1'
  let q = serviceDb()
    .from('bookkeeping_categories')
    .select('id, name, kind, active')
  if (!todas) q = q.eq('active', true)
  const { data, error } = await q.order('kind').order('name')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Quantos lançamentos usam cada conta — é o que diz se dá para apagar
  const uso: Record<string, number> = {}
  const db = serviceDb()
  for (let i = 0; ; i += 10000) {
    const { data: pag } = await db.from('bank_transactions')
      .select('category').not('category', 'is', null)
      .range(i, i + 9999)
    if (!pag || pag.length === 0) break
    for (const t of pag) {
      const c = String((t as any).category)
      uso[c] = (uso[c] || 0) + 1
    }
    if (pag.length < 10000) break
  }

  return NextResponse.json({
    categories: (data || []).map((c: any) => ({ ...c, usos: uso[c.name] || 0 })),
  })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return NextResponse.json({ error: 'Somente manager/owner criam categorias' }, { status: 403 })
  }

  const { name, kind, parent } = await req.json()
  let clean = String(name || '').trim()
  if (clean.length < 2 || clean.length > 60) return NextResponse.json({ error: 'Nome: 2 a 60 caracteres' }, { status: 400 })
  if (!['income','cogs','expense','other_income','other_expense','liability','asset','non_pnl'].includes(kind)) return NextResponse.json({ error: 'Tipo inválido' }, { status: 400 })
  if (clean.includes(':')) return NextResponse.json({ error: 'Não use ":" no nome — ele é reservado para sub-contas' }, { status: 400 })

  const db = serviceDb()
  const parentClean = String(parent || '').trim()
  if (parentClean) {
    const { data: parentCat } = await db.from('bookkeeping_categories')
      .select('name, kind').eq('name', parentClean).eq('active', true).single()
    if (!parentCat) return NextResponse.json({ error: 'Categoria-mãe não encontrada' }, { status: 400 })
    if (parentCat.kind !== kind) return NextResponse.json({ error: `A sub-conta deve ser do mesmo tipo da mãe (${parentCat.kind})` }, { status: 400 })
    if (parentClean.includes(':')) return NextResponse.json({ error: 'Só um nível de sub-conta (a mãe já é sub)' }, { status: 400 })
    clean = `${parentClean}: ${clean}`   // padrão QuickBooks "Pai: Filho"
  }

  const { error } = await db.from('bookkeeping_categories').insert({ name: clean, kind })
  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'Categoria já existe' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

// PATCH /api/bookkeeping/categories { id, name?, kind?, active? }
//
// Renomear propaga para os lançamentos e para as regras que usam a conta —
// senão o livro fica apontando para um nome que não existe mais.
// Sub-contas ("Pai: Filho") acompanham a mãe.
export async function PATCH(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return NextResponse.json({ error: 'Somente sócio ou gerente altera o plano de contas.' }, { status: 403 })
  }

  const b = await req.json()
  if (!b.id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: atual } = await db.from('bookkeeping_categories')
    .select('id, name, kind, active').eq('id', b.id).single()
  if (!atual) return NextResponse.json({ error: 'Conta não encontrada' }, { status: 404 })

  // Desativar: só quando ninguém está usando
  if (b.active === false) {
    const { count } = await db.from('bank_transactions')
      .select('id', { count: 'exact', head: true }).eq('category', atual.name)
    if ((count ?? 0) > 0) {
      return NextResponse.json({
        error: `Esta conta está em ${count} lançamento(s). Reclassifique-os antes de desativar.`,
      }, { status: 409 })
    }
    const { error } = await db.from('bookkeeping_categories')
      .update({ active: false }).eq('id', b.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, message: `"${atual.name}" desativada.` })
  }

  if (b.active === true) {
    await db.from('bookkeeping_categories').update({ active: true }).eq('id', b.id)
    return NextResponse.json({ ok: true, message: `"${atual.name}" reativada.` })
  }

  const upd: Record<string, unknown> = {}
  let novoNome = atual.name

  if (b.name !== undefined) {
    const limpo = String(b.name).trim()
    if (limpo.length < 2 || limpo.length > 60) {
      return NextResponse.json({ error: 'Nome: 2 a 60 caracteres' }, { status: 400 })
    }
    // Mantém o prefixo da mãe quando for sub-conta
    const prefixo = atual.name.includes(':') ? atual.name.split(':')[0].trim() + ': ' : ''
    novoNome = prefixo + limpo.replace(/^.*:\s*/, '')
    if (novoNome !== atual.name) upd.name = novoNome
  }
  if (b.kind !== undefined) {
    if (!['income','cogs','expense','other_income','other_expense','liability','asset','non_pnl'].includes(b.kind)) {
      return NextResponse.json({ error: 'Tipo inválido' }, { status: 400 })
    }
    upd.kind = b.kind
  }
  if (Object.keys(upd).length === 0) {
    return NextResponse.json({ error: 'Nada para alterar.' }, { status: 400 })
  }

  const { error } = await db.from('bookkeeping_categories').update(upd).eq('id', b.id)
  if (error) {
    if ((error as any).code === '23505') return NextResponse.json({ error: 'Já existe uma conta com esse nome.' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let lancamentos = 0, regras = 0, subcontas = 0
  if (upd.name) {
    const { data: t } = await db.from('bank_transactions')
      .update({ category: novoNome, updated_at: new Date().toISOString() })
      .eq('category', atual.name).select('id')
    lancamentos = (t || []).length

    const { data: r } = await db.from('bookkeeping_rules')
      .update({ category: novoNome }).eq('category', atual.name).select('id')
    regras = (r || []).length

    // Sub-contas acompanham a mãe
    if (!atual.name.includes(':')) {
      const { data: filhas } = await db.from('bookkeeping_categories')
        .select('id, name').like('name', `${atual.name}: %`)
      for (const f of (filhas || [])) {
        const nomeFilha = String((f as any).name).replace(`${atual.name}: `, `${novoNome}: `)
        await db.from('bookkeeping_categories').update({ name: nomeFilha }).eq('id', (f as any).id)
        await db.from('bank_transactions').update({ category: nomeFilha }).eq('category', (f as any).name)
        await db.from('bookkeeping_rules').update({ category: nomeFilha }).eq('category', (f as any).name)
        subcontas++
      }
    }
  }

  return NextResponse.json({
    ok: true, name: novoNome,
    message: `Conta atualizada${upd.name ? ` para "${novoNome}"` : ''}`
      + (lancamentos ? ` · ${lancamentos} lançamento(s) atualizados` : '')
      + (regras ? ` · ${regras} regra(s)` : '')
      + (subcontas ? ` · ${subcontas} sub-conta(s)` : ''),
  })
}

// DELETE /api/bookkeeping/categories?id=...&moveTo=<nome da conta destino>
//
// Apaga de vez. Se a conta estiver em uso, exige o destino: os lançamentos
// e as regras são movidos para lá antes de apagar — nada fica órfão.
export async function DELETE(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return NextResponse.json({ error: 'Somente sócio ou gerente apaga contas do plano.' }, { status: 403 })
  }

  const id = req.nextUrl.searchParams.get('id')
  const moveTo = (req.nextUrl.searchParams.get('moveTo') || '').trim()
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: alvo } = await db.from('bookkeeping_categories')
    .select('id, name, kind').eq('id', id).single()
  if (!alvo) return NextResponse.json({ error: 'Conta não encontrada' }, { status: 404 })

  // Sub-contas impedem: apague ou mova as filhas antes
  const { data: filhas } = await db.from('bookkeeping_categories')
    .select('id').like('name', `${alvo.name}: %`)
  if ((filhas || []).length > 0) {
    return NextResponse.json({
      error: `"${alvo.name}" tem ${(filhas || []).length} sub-conta(s). Apague ou mova as sub-contas primeiro.`,
    }, { status: 409 })
  }

  const { count } = await db.from('bank_transactions')
    .select('id', { count: 'exact', head: true }).eq('category', alvo.name)
  const emUso = count ?? 0

  if (emUso > 0 && !moveTo) {
    return NextResponse.json({
      error: `"${alvo.name}" está em ${emUso} lançamento(s). Escolha para qual conta mover antes de apagar.`,
      emUso,
    }, { status: 409 })
  }

  let movidos = 0, regras = 0
  if (emUso > 0) {
    const { data: destino } = await db.from('bookkeeping_categories')
      .select('name, kind').eq('name', moveTo).single()
    if (!destino) return NextResponse.json({ error: 'Conta de destino não encontrada' }, { status: 400 })
    if (destino.kind !== alvo.kind) {
      return NextResponse.json({
        error: `A conta de destino é de outro grupo (${destino.kind}). Escolha uma do mesmo grupo para não distorcer os relatórios.`,
      }, { status: 400 })
    }
    const { data: t } = await db.from('bank_transactions')
      .update({ category: moveTo, updated_at: new Date().toISOString() })
      .eq('category', alvo.name).select('id')
    movidos = (t || []).length
  }

  const { data: r } = await db.from('bookkeeping_rules')
    .update({ category: moveTo || null }).eq('category', alvo.name).select('id')
  regras = (r || []).length

  const { error } = await db.from('bookkeeping_categories').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    message: `"${alvo.name}" apagada`
      + (movidos ? ` · ${movidos} lançamento(s) movidos para "${moveTo}"` : '')
      + (regras ? ` · ${regras} regra(s) ajustadas` : ''),
  })
}
