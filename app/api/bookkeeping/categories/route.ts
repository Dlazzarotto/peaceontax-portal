// GET  /api/bookkeeping/categories — lista (equipe); com ?all=1 traz também as
//      inativas, o uso de cada conta (lançamentos e regras) e a marca do 1099
//      (tela Plano de contas)
// POST /api/bookkeeping/categories { name, kind, parent? } — cria (manager/owner)
//   parent: nome de categoria existente do MESMO kind → sub-conta "Pai: Filho"
// PATCH { id, nome?, kind?, mae?, form1099?, motivo?, senha? } — edita (manager/owner)
//   nome: sem a mãe · mae: nome da conta-mãe, ou null para conta principal ·
//   form1099: 'NEC' | 'MISC' | null — o botão do 1099 de cada conta de despesa
//   (lib/relatorio-1099.ts).
// PATCH { id, active, motivo? } — desativa (só sem lançamento e sem regra) ou reativa
// DELETE ?id=…&moveTo=<conta destino>, corpo { motivo? } — apaga, movendo
//   lançamentos, regras e contas a pagar para o destino (manager/owner)
//
// O QUE PODE e o que cada mudança leva junto é de lib/plano-de-contas.ts — a
// tela chama as mesmas funções para mostrar antes. A GRAVAÇÃO é uma transação
// no banco (sql/plano-de-contas-edicao-funcao-v1.sql): conta, sub-contas,
// lançamentos, regras, contas a pagar e trilha, juntos ou nenhum. O
// lançamento guarda o NOME da conta e o P&L trata nome fora do plano como
// despesa — um renomear pela metade, como o desta rota antes, mandava a
// receita da conta antiga para as despesas de todos os clientes.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { todasAsLinhas } from '@/lib/paginar'
import { colunaAusente } from '@/lib/caixa-firma'
import {
  planoDaEdicao, planoDaRemocao, recusaDaDesativacao, filhasDe, recusaDoNome,
  chaveDaConta, ehGrupoDoPlano, MOTIVO_MINIMO, type ContaDoPlano,
} from '@/lib/plano-de-contas'

const COLUNAS = 'id, name, kind, active'
const MIGRACAO_1099 = 'sql/plano-de-contas-1099-v1.sql'
const MIGRACAO_EDICAO = 'sql/plano-de-contas-edicao-v1.sql e sql/plano-de-contas-edicao-funcao-v1.sql'

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const todas = req.nextUrl.searchParams.get('all') === '1'
  const db = serviceDb()
  const ler = (colunas: string) => {
    let q = db.from('bookkeeping_categories').select(colunas)
    if (!todas) q = q.eq('active', true)
    return q.order('kind').order('name')
  }
  // A marca do 1099 só vai para a tela do plano de contas. A lista curta
  // (classificação, conciliação) não depende dela: coluna nova num select de
  // que a mesa de trabalho depende é risco entre o deploy e a migração.
  let { data, error } = await ler(todas ? `${COLUNAS}, form_1099` : COLUNAS)
  let semColuna1099 = false
  if (error && todas && colunaAusente(error)) {
    semColuna1099 = true
    ;({ data, error } = await ler(COLUNAS))
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (!todas) return NextResponse.json({ categories: data || [] })

  // Quantos lançamentos e quantas regras usam cada conta — é o que diz se dá
  // para desativar e se apagar pede destino. Em páginas de 1000: o laço
  // anterior pedia 10000 por vez, o PostgREST devolvia 1000 e o laço parava
  // achando que tinha acabado. Conta usada além do milésimo lançamento
  // aparecia como "sem uso".
  const [lanc, reg] = await Promise.all([
    todasAsLinhas<{ category: string }>(() =>
      db.from('bank_transactions').select('category').not('category', 'is', null)),
    todasAsLinhas<{ category: string }>(() =>
      db.from('bookkeeping_rules').select('category').not('category', 'is', null)),
  ])
  if (lanc.error) return NextResponse.json({ error: `Não foi possível contar o uso das contas: ${lanc.error.message}` }, { status: 500 })
  if (reg.error) return NextResponse.json({ error: `Não foi possível contar as regras das contas: ${reg.error.message}` }, { status: 500 })
  const contar = (linhas: { category: string }[]) => {
    const n: Record<string, number> = {}
    for (const t of linhas) n[String(t.category)] = (n[String(t.category)] || 0) + 1
    return n
  }
  const uso = contar(lanc.data)
  const regras = contar(reg.data)

  return NextResponse.json({
    categories: (data || []).map((c: any) => ({ ...c, usos: uso[c.name] || 0, regras: regras[c.name] || 0 })),
    ...(semColuna1099 ? { semColuna1099: true, migracao1099: MIGRACAO_1099 } : {}),
  })
}

/** Só sócio ou gerente mexe no plano de contas. */
async function daGerencia(acao: string): Promise<{ userId: string } | NextResponse> {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return NextResponse.json({ error: `Somente sócio ou gerente ${acao}.` }, { status: 403 })
  }
  return { userId: auth.userId }
}

/** O plano inteiro, para conferir mãe, sub-contas e nome repetido. */
async function lerPlano(db: any): Promise<{ contas: ContaDoPlano[]; semColuna1099: boolean; error: string | null }> {
  let r = await todasAsLinhas<ContaDoPlano>(() => db.from('bookkeeping_categories').select(`${COLUNAS}, form_1099`))
  let semColuna1099 = false
  if (r.error && colunaAusente(r.error)) {
    semColuna1099 = true
    r = await todasAsLinhas<ContaDoPlano>(() => db.from('bookkeeping_categories').select(COLUNAS))
  }
  if (r.error) return { contas: [], semColuna1099, error: r.error.message }
  return {
    contas: r.data.map(c => ({ ...c, id: String(c.id), active: c.active !== false })),
    semColuna1099, error: null,
  }
}

/** Lançamentos e regras de cada nome. Contagem que falha é erro, nunca zero. */
async function contarUso(db: any, nomes: string[]): Promise<{ lancamentos: Record<string, number>; regras: Record<string, number>; error: string | null }> {
  const lancamentos: Record<string, number> = {}
  const regras: Record<string, number> = {}
  for (const nome of nomes) {
    const [t, r] = await Promise.all([
      db.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('category', nome),
      db.from('bookkeeping_rules').select('id', { count: 'exact', head: true }).eq('category', nome),
    ])
    if (t.error) return { lancamentos, regras, error: `Não foi possível contar os lançamentos de "${nome}": ${t.error.message}` }
    if (r.error) return { lancamentos, regras, error: `Não foi possível contar as regras de "${nome}": ${r.error.message}` }
    lancamentos[nome] = t.count ?? 0
    regras[nome] = r.count ?? 0
  }
  return { lancamentos, regras, error: null }
}

/** Mudar o grupo de conta em uso reescreve relatórios passados: senha de quem muda. */
async function conferirSenha(userId: string, senha: unknown): Promise<NextResponse | null> {
  if (!String(senha || '').trim()) {
    return NextResponse.json({ error: 'Confirme com a sua senha: mudar o grupo de uma conta em uso muda os relatórios de anos passados.' }, { status: 400 })
  }
  const { data: quem } = await serviceDb().auth.admin.getUserById(userId)
  const email = quem?.user?.email
  if (!email) return NextResponse.json({ error: 'Não foi possível identificar seu login.' }, { status: 400 })
  const sbAuth = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { error } = await sbAuth.auth.signInWithPassword({ email, password: String(senha).trim() })
  if (error) {
    if (/rate|too many|429/i.test(error.message || '')) {
      return NextResponse.json({ error: 'Muitas tentativas. Aguarde 1 minuto.' }, { status: 429 })
    }
    return NextResponse.json({ error: `Senha não confere para ${email}.` }, { status: 401 })
  }
  return null
}

/** O que a função do banco recusou, dito para quem está na tela. */
const RECUSA_DO_BANCO: Record<string, string> = {
  pedido_incompleto:      'Pedido incompleto.',
  grupo_invalido:         'Grupo inválido.',
  formulario_invalido:    'Só conta de despesa vai para o 1099, e o formulário é NEC ou MISC.',
  conta_inexistente:      'Conta não encontrada — ela pode ter acabado de ser apagada.',
  mudou_no_meio:          'A conta mudou enquanto você editava (outra pessoa mexeu nela). Nada foi gravado: recarregue a página e confira antes de salvar.',
  nome_malformado:        'Nome inválido para sub-conta: use só a conta-mãe e o nome.',
  mae_e_a_propria:        'Uma conta não pode ser sub-conta dela mesma.',
  mae_inexistente:        'A conta-mãe não existe mais. Recarregue a página.',
  mae_inativa:            'A conta-mãe está inativa. Reative-a ou escolha outra.',
  grupo_diferente_da_mae: 'A sub-conta fica no grupo da conta-mãe.',
  tem_subcontas:          'A conta tem sub-contas: mova ou apague as sub-contas primeiro.',
  nome_repetido:          'Já existe uma conta com esse nome.',
  nome_repetido_na_filha: 'Uma das sub-contas ficaria com o nome de uma conta que já existe.',
  motivo_obrigatorio:     `A conta passou a ter lançamentos: escreva o motivo (mínimo ${MOTIVO_MINIMO} caracteres).`,
  sem_mudanca:            'A conta já está assim.',
  destino_e_a_propria:    'A conta de destino é a própria conta.',
  destino_inexistente:    'A conta de destino não existe mais. Recarregue a página.',
  destino_de_outro_grupo: 'A conta de destino é de outro grupo.',
  destino_inativo:        'A conta de destino está inativa.',
}

/** Erro da chamada (não da regra): função ausente é migração pendente; o resto, atômico, não gravou nada. */
function erroDaChamada(error: any, funcao: string): NextResponse {
  const m = String(error?.message || '')
  if (m.includes(funcao) && /does not exist|not find|schema cache/i.test(m)) {
    return NextResponse.json({ error: `Esta mudança precisa das migrações ${MIGRACAO_EDICAO}. Rode no SQL Editor (ou pelo workflow Migrações do banco) e tente de novo.` }, { status: 409 })
  }
  return NextResponse.json({ error: `Nada foi gravado (a mudança é tudo ou nada): ${m}` }, { status: 500 })
}

export async function POST(req: NextRequest) {
  const quem = await daGerencia('criam contas no plano')
  if (quem instanceof NextResponse) return quem

  const { name, kind, parent } = await req.json()
  let clean = String(name || '').trim()
  const recusaNome = recusaDoNome(clean)
  if (recusaNome) return NextResponse.json({ error: recusaNome }, { status: 400 })
  if (!ehGrupoDoPlano(kind)) return NextResponse.json({ error: 'Tipo inválido' }, { status: 400 })

  const db = serviceDb()
  const { contas, error: errPlano } = await lerPlano(db)
  if (errPlano) return NextResponse.json({ error: `Não foi possível ler o plano de contas: ${errPlano}` }, { status: 500 })

  const parentClean = String(parent || '').trim()
  if (parentClean) {
    const parentCat = contas.find(c => c.name === parentClean && c.active)
    if (!parentCat) return NextResponse.json({ error: 'Categoria-mãe não encontrada' }, { status: 400 })
    if (parentCat.kind !== kind) return NextResponse.json({ error: `A sub-conta deve ser do mesmo tipo da mãe (${parentCat.kind})` }, { status: 400 })
    if (parentClean.includes(':')) return NextResponse.json({ error: 'Só um nível de sub-conta (a mãe já é sub)' }, { status: 400 })
    clean = `${parentClean}: ${clean}`   // padrão QuickBooks "Pai: Filho"
  }

  // Mesma conta escrita de outro jeito ("office supplies" ao lado de "Office
  // Supplies") divide o P&L de todos os clientes em duas linhas que parecem uma.
  const igual = contas.find(c => chaveDaConta(c.name) === chaveDaConta(clean))
  if (igual) return NextResponse.json({ error: `Categoria já existe: "${igual.name}"` }, { status: 409 })

  const { error } = await db.from('bookkeeping_categories').insert({ name: clean, kind })
  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'Categoria já existe' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

// PATCH: editar (nome, grupo, mãe, 1099) ou desativar/reativar.
export async function PATCH(req: NextRequest) {
  const quem = await daGerencia('altera o plano de contas')
  if (quem instanceof NextResponse) return quem

  const b = await req.json()
  if (!b.id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { contas, semColuna1099, error: errPlano } = await lerPlano(db)
  if (errPlano) return NextResponse.json({ error: `Não foi possível ler o plano de contas: ${errPlano}` }, { status: 500 })
  const conta = contas.find(c => c.id === String(b.id))
  if (!conta) return NextResponse.json({ error: 'Conta não encontrada' }, { status: 404 })
  const motivo = String(b.motivo || '').trim()

  // ── Desativar / reativar ───────────────────────────────────────────────
  if (b.active === true || b.active === false) {
    if (b.active === false) {
      const uso = await contarUso(db, [conta.name])
      if (uso.error) return NextResponse.json({ error: uso.error }, { status: 500 })
      const recusa = recusaDaDesativacao(conta, uso.lancamentos[conta.name], uso.regras[conta.name])
      if (recusa) return NextResponse.json({ error: recusa }, { status: 409 })
    }
    const { data, error } = await db.rpc('situacao_da_conta_do_plano', {
      p_id: conta.id, p_nome_atual: conta.name, p_ativa: b.active, p_ator: quem.userId, p_motivo: motivo || null,
    })
    if (error) return erroDaChamada(error, 'situacao_da_conta_do_plano')
    if (!data?.ok) {
      const e = String(data?.erro || '')
      const msg = e === 'em_uso'
        ? `A conta passou a ser usada (${data.lancamentos} lançamento(s), ${data.regras} regra(s)). Nada foi alterado.`
        : RECUSA_DO_BANCO[e] || `Nada foi alterado (${e}).`
      return NextResponse.json({ error: msg }, { status: 409 })
    }
    return NextResponse.json({ ok: true, message: `"${conta.name}" ${b.active ? 'reativada' : 'desativada'}.` })
  }

  // ── Editar ─────────────────────────────────────────────────────────────
  if (semColuna1099) {
    return NextResponse.json({ error: `Editar o plano de contas precisa da migração ${MIGRACAO_1099} (e de ${MIGRACAO_EDICAO}). Rode no SQL Editor e tente de novo.` }, { status: 409 })
  }
  const uso = await contarUso(db, [conta.name, ...filhasDe(conta, contas).map(f => f.name)])
  if (uso.error) return NextResponse.json({ error: uso.error }, { status: 500 })

  const plano = planoDaEdicao({
    conta,
    pedido: { nome: b.nome ?? b.name, kind: b.kind, mae: b.mae, form1099: b.form1099 },
    plano: contas,
    usos: uso.lancamentos,
  })
  if (plano.ok === false) return NextResponse.json({ error: plano.erro }, { status: plano.status })

  if (plano.exigeMotivo && motivo.length < MOTIVO_MINIMO) {
    return NextResponse.json({
      error: `A conta tem ${plano.lancamentos} lançamento(s): a mudança alcança o livro de todos os clientes. Escreva o motivo (mínimo ${MOTIVO_MINIMO} caracteres).`,
      exigeMotivo: true, exigeSenha: plano.exigeSenha,
    }, { status: 400 })
  }
  if (plano.exigeSenha) {
    const recusa = await conferirSenha(quem.userId, b.senha)
    if (recusa) return recusa
  }

  const { data, error } = await db.rpc('editar_conta_do_plano', {
    p_id: conta.id, p_nome_atual: conta.name, p_nome: plano.nome, p_kind: plano.kind,
    p_form_1099: plano.form1099, p_ator: quem.userId, p_motivo: motivo || null,
  })
  if (error) {
    if ((error as any).code === '23505') return NextResponse.json({ error: 'Já existe uma conta com esse nome. Nada foi gravado.' }, { status: 409 })
    return erroDaChamada(error, 'editar_conta_do_plano')
  }
  if (!data?.ok) {
    return NextResponse.json({ error: RECUSA_DO_BANCO[String(data?.erro)] || `Nada foi gravado (${data?.erro}).` }, { status: 409 })
  }

  const alcance = [
    data.lancamentos ? `${data.lancamentos} lançamento(s) com o nome novo` : '',
    plano.mudouGrupo && data.alcance ? `${data.alcance} lançamento(s) no grupo novo` : '',
    data.regras ? `${data.regras} regra(s)` : '',
    data.contas_a_pagar ? `${data.contas_a_pagar} conta(s) a pagar` : '',
    data.subcontas ? `${data.subcontas} sub-conta(s)` : '',
  ].filter(Boolean)
  return NextResponse.json({
    ok: true, name: plano.nome,
    message: `Conta atualizada — ${plano.resumo}` + (alcance.length ? ` · ${alcance.join(' · ')}` : ''),
  })
}

// DELETE ?id=...&moveTo=<nome da conta destino>, corpo { motivo? }
//
// Apaga de vez. Conta em uso (lançamento ou regra) exige o destino: tudo vai
// para lá antes de apagar — nada fica com o nome de uma conta que sumiu.
export async function DELETE(req: NextRequest) {
  const quem = await daGerencia('apaga contas do plano')
  if (quem instanceof NextResponse) return quem

  const id = req.nextUrl.searchParams.get('id')
  const moveTo = (req.nextUrl.searchParams.get('moveTo') || '').trim()
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })
  let corpo: any = {}
  try { corpo = await req.json() } catch { corpo = {} }
  const motivo = String(corpo?.motivo || '').trim()

  const db = serviceDb()
  const { contas, error: errPlano } = await lerPlano(db)
  if (errPlano) return NextResponse.json({ error: `Não foi possível ler o plano de contas: ${errPlano}` }, { status: 500 })
  const alvo = contas.find(c => c.id === String(id))
  if (!alvo) return NextResponse.json({ error: 'Conta não encontrada' }, { status: 404 })

  const uso = await contarUso(db, [alvo.name])
  if (uso.error) return NextResponse.json({ error: uso.error }, { status: 500 })
  const plano = planoDaRemocao({
    conta: alvo, plano: contas,
    lancamentos: uso.lancamentos[alvo.name], regras: uso.regras[alvo.name], destino: moveTo,
  })
  if (plano.ok === false) {
    return NextResponse.json({ error: plano.erro, ...('emUso' in plano ? { emUso: plano.emUso } : {}) }, { status: plano.status })
  }
  if (plano.exigeMotivo && motivo.length < MOTIVO_MINIMO) {
    return NextResponse.json({ error: `Os lançamentos de "${alvo.name}" vão para "${plano.destino}": escreva o motivo (mínimo ${MOTIVO_MINIMO} caracteres).` }, { status: 400 })
  }

  const { data, error } = await db.rpc('apagar_conta_do_plano', {
    p_id: alvo.id, p_nome_atual: alvo.name, p_destino: plano.destino, p_ator: quem.userId, p_motivo: motivo || null,
  })
  if (error) return erroDaChamada(error, 'apagar_conta_do_plano')
  if (!data?.ok) {
    const e = String(data?.erro || '')
    const msg = e === 'em_uso'
      ? `A conta passou a ser usada (${data.lancamentos} lançamento(s), ${data.regras} regra(s)): escolha o destino. Nada foi apagado.`
      : RECUSA_DO_BANCO[e] || `Nada foi apagado (${e}).`
    return NextResponse.json({ error: msg }, { status: 409 })
  }

  return NextResponse.json({
    ok: true,
    message: `"${alvo.name}" apagada`
      + (data.lancamentos ? ` · ${data.lancamentos} lançamento(s) movidos para "${data.destino}"` : '')
      + (data.regras ? ` · ${data.regras} regra(s) ajustadas` : '')
      + (data.contas_a_pagar ? ` · ${data.contas_a_pagar} conta(s) a pagar` : ''),
  })
}
