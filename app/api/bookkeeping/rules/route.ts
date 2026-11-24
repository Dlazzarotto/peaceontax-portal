// GET    /api/bookkeeping/rules?clientId=...  — regras do cliente + globais
// POST   /api/bookkeeping/rules               — cria regra (manager/owner)
// DELETE /api/bookkeeping/rules?id=...        — exclui regra (manager/owner)
// PATCH  /api/bookkeeping/rules { id, scope?, ... } — edita regra, inclusive o
//        escopo: 'global' (todos os clientes, client_id nulo) ou 'client'.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth, serviceDb, canAccessClient } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { textoGenerico, MOTIVO_GENERICO } from '@/lib/regra-texto'
import { aplicarNaFila } from '@/lib/aplicar-na-fila'
import { todasAsLinhas } from '@/lib/paginar'

// Criar ou editar uma regra a aplica à fila do cliente — e, depois do
// histórico do Plaid, a fila tem milhares de lançamentos. Lida em páginas e
// gravada em lotes (lib/aplicar-na-fila.ts), cabe com folga; o teto aqui é
// para o pior caso não virar uma página de erro no lugar da resposta.
export const maxDuration = 60


// Mesmo motor de casamento das demais rotas: palavra inteira, sem fragmentos
// de 1-2 letras e sem os metadados técnicos de wire/ACH.
const limparRuido = (d: string): string =>
  d.replace(/\b(bnf bk|orig bk|bnf|orig|id|trn|seq|fx|pmt det|ref|conf|confirmation)\s*[:#]\s*\S*/gi, ' ')
   .replace(/\s+/g, ' ')

const escaparRegra = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const casaTexto = (desc: string, v: string, tipo: string): boolean => {
  if (!v || v.length < 3) return false
  return tipo === 'starts_with'
    ? new RegExp('^' + escaparRegra(v) + '([^a-z0-9]|$)', 'i').test(desc)
    : new RegExp('(^|[^a-z0-9])' + escaparRegra(v) + '([^a-z0-9]|$)', 'i').test(desc)
}

// Regra cujo texto é só jargão do banco casa com quase tudo — a tela avisa.
const marcarGenericas = (rules: any[]) => rules.map(r => ({ ...r, generica: textoGenerico(r.pattern) }))

/**
 * UMA definição de "este lançamento casa com a regra", para criar, editar e
 * reclassificar o registro. O POST tinha a sua cópia, lado a lado com a do
 * PATCH — e cópia diverge.
 */
function casaDaRegra(r: {
  conta: string | null; direction: string; pattern: string | null; matchType: string
  amountOp: string | null; amountValue: number | null
}) {
  return (tx: { description: string; amount: number | string; account_id?: string | null }): boolean => {
    if (r.conta && tx.account_id !== r.conta) return false
    const desc = limparRuido(String(tx.description).toLowerCase())
    const amount = Number(tx.amount)
    if (r.direction === 'in' && amount <= 0) return false
    if (r.direction === 'out' && amount >= 0) return false
    if (r.pattern) {
      const variants = r.pattern.split('|')
      if (!variants.some((v: string) => casaTexto(desc, v, r.matchType))) return false
    }
    if (r.amountOp) {
      const abs = Math.abs(amount)
      if (r.amountOp === 'gt' && !(abs > r.amountValue!)) return false
      if (r.amountOp === 'lt' && !(abs < r.amountValue!)) return false
      if (r.amountOp === 'eq' && Math.abs(abs - r.amountValue!) > 0.005) return false
    }
    return true
  }
}

async function requireManager(userId: string) {
  const level = await getStaffLevel(userId)
  return level === 'owner' || level === 'manager'
}

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const clientId = req.nextUrl.searchParams.get('clientId')
  const db0 = serviceDb()

  // Biblioteca geral: regras que valem para todos os clientes
  if (!clientId && req.nextUrl.searchParams.get('scope') === 'global') {
    const { data, error } = await db0.from('bookkeeping_rules')
      .select('*').is('client_id', null)
      .order('name', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ rules: marcarGenericas(data || []), businessKind: 'regular', scope: 'global' })
  }
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  // Escopo por TIPO: as regras dizem o plano de contas, os fornecedores e os
  // clientes daquela empresa. Esta rota ficou fora do funil canAccessClient
  // quando o escopo foi criado.
  if (!(await canAccessClient(auth, clientId)))
    return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })
  const { data: cli } = await db0.from('clients')
    .select('business_kind').eq('id', clientId).maybeSingle()
  const soDoCliente = cli?.business_kind === 'nonprofit'

  // Em páginas: as gerais e as do cliente juntas podem passar de mil, e o
  // PostgREST corta em mil sem avisar — a regra recém-criada (prioridade 30,
  // depois das gerais) seria a primeira a sumir da lista.
  const { data, error } = await todasAsLinhas(() => {
    const q = db0.from('bookkeeping_rules').select('*')
    return (soDoCliente
      ? q.eq('client_id', clientId)                                 // non-profit: nada global
      : q.or(`client_id.eq.${clientId},client_id.is.null`))
      .order('priority', { ascending: true })
      .order('created_at', { ascending: false })
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({
    rules: marcarGenericas(data || []),
    businessKind: cli?.business_kind || 'regular',
  })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  if (!(await requireManager(auth.userId))) {
    return NextResponse.json({ error: 'Somente manager/owner criam regras' }, { status: 403 })
  }

  const b = await req.json()
  const name = String(b.name || '').trim()
  const pattern = String(b.pattern || '')
    .split('|').map((x: string) => x.trim().toLowerCase()).filter((x: string) => x.length >= 2)
    .join('|') || null
  const category = String(b.category || '').trim()
  const direction = ['in','out','both'].includes(b.direction) ? b.direction : 'both'
  const matchType = ['contains','starts_with'].includes(b.matchType) ? b.matchType : 'contains'
  const amountOp = ['gt','lt','eq'].includes(b.amountOp) ? b.amountOp : null
  const amountValue = amountOp ? Number(b.amountValue) : null
  const payee = String(b.payee || '').trim() || null
  let global = b.scope === 'global'

  // Regra de um cliente so vale se a pessoa alcanca aquele cliente.
  // Regra GLOBAL nao tem cliente -- requireManager ja e a trava dela.
  if (b.clientId && !(await canAccessClient(auth, b.clientId)))
    return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })

  // Non-profit: a regra é SEMPRE da própria entidade (fundos/projetos únicos)
  if (b.clientId) {
    const { data: cliPost } = await serviceDb().from('clients')
      .select('business_kind').eq('id', b.clientId).maybeSingle()
    if (cliPost?.business_kind === 'nonprofit') {
      if (global) {
        return NextResponse.json({
          error: 'Este cliente é uma organização sem fins lucrativos — as regras valem apenas para ela. Escolha "Só este cliente".',
        }, { status: 400 })
      }
      global = false
    }
  }

  if (name.length < 2) return NextResponse.json({ error: 'Nome da regra obrigatório' }, { status: 400 })
  if (!category) return NextResponse.json({ error: 'Categoria obrigatória' }, { status: 400 })
  if (!pattern && !amountOp) return NextResponse.json({ error: 'Defina ao menos uma condição (descrição ou valor)' }, { status: 400 })
  if (pattern && textoGenerico(pattern)) return NextResponse.json({ error: MOTIVO_GENERICO }, { status: 400 })
  if (!payee) return NextResponse.json({ error: 'Payee é obrigatório na regra — informe o favorecido (Vendor/Customer)' }, { status: 400 })
  if (amountOp && (amountValue == null || isNaN(amountValue))) {
    return NextResponse.json({ error: 'Valor da condição inválido' }, { status: 400 })
  }
  if (!global && !b.clientId) return NextResponse.json({ error: 'clientId obrigatório para regra do cliente' }, { status: 400 })

  const db = serviceDb()

  // Regra pode ser restrita a uma conta (fundo/projeto). null = todas as contas.
  const ruleAccount: string | null = b.accountId || null

  // Duplicata: mesma direção + mesmo conjunto de variações do texto
  if (pattern) {
    // Compara apenas com regras do MESMO escopo: uma regra do cliente pode
    // repetir o texto de uma regra geral — ela sobrepõe a geral naquele cliente.
    let eq = db.from('bookkeeping_rules')
      .select('id, name, pattern, direction, account_id')
    eq = global ? eq.is('client_id', null) : eq.eq('client_id', b.clientId)
    const { data: existing, error: errExistentes } = await eq
    // Leitura que falha não é "nenhuma igual": criaria a regra em dobro.
    if (errExistentes) return NextResponse.json({ error: `Não foi possível conferir as regras existentes: ${errExistentes.message}` }, { status: 500 })
    const norm = (p2: string | null) => (p2 || '').split('|').map(x => x.trim()).filter(Boolean).sort().join('|')
    const dup = (existing || []).find((r: any) =>
      (r.direction === direction || r.direction === 'both' || direction === 'both') &&
      norm(r.pattern) === norm(pattern) &&
      String(r.account_id || '') === String(ruleAccount || ''))
    if (dup) {
      return NextResponse.json({
        error: `Já existe uma regra ${global ? 'geral' : 'deste cliente'} com este texto: "${dup.name || dup.pattern}". Edite-a em vez de criar outra.`,
      }, { status: 409 })
    }
  }

  const { error } = await db.from('bookkeeping_rules').insert({
    client_id: global ? null : b.clientId,
    account_id: ruleAccount,
    name, pattern, category, direction,
    match_type: matchType, amount_op: amountOp, amount_value: amountValue,
    payee, priority: 30, created_by: 'staff',
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Cadastra o payee da regra (vendor p/ saídas, customer p/ entradas)
  if (payee && b.clientId) {
    await db.from('payees').upsert(
      { client_id: b.clientId, name: payee, type: direction === 'in' ? 'customer' : 'vendor' },
      { onConflict: 'client_id,name' }
    ).then(() => null, () => null)
  }

  // RETROATIVO: aplica a regra à fila do cliente (pending + auto — preserva o
  // que a equipe já revisou). Era `.limit(5000)` (o PostgREST devolve MIL) e
  // uma gravação por lançamento: com a fila do Plaid, a regra pegava só parte
  // dela, ou a função estourava o tempo e a tela ficava sem resposta.
  // A regra JÁ ESTÁ gravada aqui: se aplicar falhar, a resposta diz isso em
  // vez de virar erro — senão o clique seguinte daria "já existe uma regra
  // com este texto" e ninguém entenderia o que aconteceu.
  let fila = { casaram: 0, aplicadas: 0, falharam: 0, primeiraFalha: null as string | null }
  let erroDaFila: string | null = null
  if (b.clientId) {
    const upd: Record<string, unknown> = {
      category, category_confidence: 100, categorized_by: 'rule',
      status: 'auto', updated_at: new Date().toISOString(),
    }
    if (payee) upd.payee = payee
    try {
      fila = await aplicarNaFila(db, {
        clientId: b.clientId, status: ['pending', 'auto'], alteracao: upd,
        casa: casaDaRegra({ conta: ruleAccount, direction, pattern, matchType, amountOp, amountValue }),
      })
    } catch (e) { erroDaFila = (e as Error).message }
  }

  return NextResponse.json({
    ok: true, applied: fila.aplicadas, casaram: fila.casaram,
    filaFalhou: fila.falharam, falhaExemplo: fila.primeiraFalha || undefined,
    aviso: erroDaFila
      ? `A regra foi criada, mas não foi aplicada aos lançamentos já importados (${erroDaFila}). Use "Aplicar regras" para tentar de novo.`
      : undefined,
  })
}

export async function DELETE(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  if (!(await requireManager(auth.userId))) {
    return NextResponse.json({ error: 'Somente manager/owner' }, { status: 403 })
  }
  // Modo em massa: excluir todas as regras sem payee (do cliente + globais)
  const mode = req.nextUrl.searchParams.get('mode')
  if (mode === 'no_payee') {
    const clientId = req.nextUrl.searchParams.get('clientId')
    if (clientId && !(await canAccessClient(auth, clientId)))
      return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })
    let q = serviceDb().from('bookkeeping_rules').delete({ count: 'exact' })
      .or('payee.is.null,payee.eq.')
    if (clientId) q = q.or(`client_id.eq.${clientId},client_id.is.null`)
    const { error, count } = await q
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, deleted: count ?? 0 })
  }

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })
  const { error } = await serviceDb().from('bookkeeping_rules').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: NextRequest) {
  try {
    const auth = await getAuth()
    if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
    if (!(await requireManager(auth.userId))) {
      return NextResponse.json({ error: 'Somente manager/owner editam regras' }, { status: 403 })
    }

    const b = await req.json()
    if (!b.id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

    const db = serviceDb()
    const { data: existing } = await db.from('bookkeeping_rules').select('*').eq('id', b.id).single()
    if (!existing) return NextResponse.json({ error: 'Regra não encontrada' }, { status: 404 })

    // Conta (fundo) da regra: usa a enviada; se não vier, mantém a atual
    const ruleAccountP: string | null =
      b.accountId !== undefined ? (b.accountId || null) : (existing.account_id ?? null)

    const name = String(b.name ?? existing.name ?? '').trim()
    const pattern = b.pattern !== undefined
      ? (String(b.pattern).split('|').map((x: string) => x.trim().toLowerCase()).filter((x: string) => x.length >= 2).join('|') || null)
      : existing.pattern
    const category = String(b.category ?? existing.category).trim()
    const direction = ['in','out','both'].includes(b.direction) ? b.direction : existing.direction
    const matchType = ['contains','starts_with'].includes(b.matchType) ? b.matchType : existing.match_type
    const amountOp = b.amountOp === '' ? null : (['gt','lt','eq'].includes(b.amountOp) ? b.amountOp : existing.amount_op)
    const amountValue = amountOp ? Number(b.amountValue ?? existing.amount_value) : null
    const payee = b.payee !== undefined ? (String(b.payee).trim() || null) : existing.payee

    if (!pattern && !amountOp) return NextResponse.json({ error: 'Defina ao menos uma condição' }, { status: 400 })
    if (pattern && textoGenerico(pattern)) return NextResponse.json({ error: MOTIVO_GENERICO }, { status: 400 })

    // ── Escopo: geral (todos os clientes) × só este cliente ──
    // A tela manda `scope` em toda edição. Sem ler aqui, trocar de Global para
    // Cliente respondia ok e não gravava nada: o formulário mudava e o banco
    // continuava igual. Omitir `scope` mantém o escopo atual.
    let global = b.scope !== undefined ? b.scope === 'global' : existing.client_id === null
    const clienteAlvo = b.clientId || existing.client_id

    // Non-profit: a regra é SEMPRE da própria entidade (mesma trava do POST)
    if (global && clienteAlvo) {
      const { data: cliPatch } = await db.from('clients')
        .select('business_kind').eq('id', clienteAlvo).maybeSingle()
      if (cliPatch?.business_kind === 'nonprofit') {
        return NextResponse.json({
          error: 'Este cliente é uma organização sem fins lucrativos — as regras valem apenas para ela. Escolha "Só este cliente".',
        }, { status: 400 })
      }
    }
    if (!global && !clienteAlvo) {
      return NextResponse.json({ error: 'clientId obrigatório para regra do cliente' }, { status: 400 })
    }
    const novoClientId: string | null = global ? null : clienteAlvo
    // A conta bancária pertence a um cliente: regra geral não fica presa a uma conta
    const contaFinal: string | null = global ? null : ruleAccountP
    const mudouEscopo = (existing.client_id === null) !== global

    // Trocou de escopo? A mesma trava de duplicata do POST, agora no escopo novo
    if (mudouEscopo && pattern) {
      let eq = db.from('bookkeeping_rules')
        .select('id, name, pattern, direction, account_id').neq('id', b.id)
      eq = global ? eq.is('client_id', null) : eq.eq('client_id', novoClientId)
      const { data: irmas } = await eq
      const norm = (p2: string | null) => (p2 || '').split('|').map((x: string) => x.trim()).filter(Boolean).sort().join('|')
      const dup = (irmas || []).find((r: any) =>
        (r.direction === direction || r.direction === 'both' || direction === 'both') &&
        norm(r.pattern) === norm(pattern) &&
        String(r.account_id || '') === String(contaFinal || ''))
      if (dup) {
        return NextResponse.json({
          error: `Já existe uma regra ${global ? 'geral' : 'deste cliente'} com este texto: "${dup.name || dup.pattern}". Edite-a em vez de criar outra.`,
        }, { status: 409 })
      }
    }

    const { error } = await db.from('bookkeeping_rules').update({
      client_id: novoClientId,
      account_id: contaFinal,
      name, pattern, category, direction,
      match_type: matchType, amount_op: amountOp, amount_value: amountValue, payee,
    }).eq('id', b.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const targetClient = b.clientId || existing.client_id

    // UMA definição de "esta transação casa com a regra" (casaDaRegra), para a
    // fila, o registro e a criação. Comparavam por CÓPIA, lado a lado — e
    // cópia diverge: a reclassificação passaria a pegar um conjunto diferente
    // do que a fila pega, sem nada acusar.
    const casaARegra = casaDaRegra({ conta: contaFinal, direction, pattern, matchType, amountOp, amountValue })

    // Reaplica retroativamente (pending + auto do cliente atual): lê TUDO em
    // páginas e grava em lotes, contando o que o banco gravou e o que recusou
    // (lib/aplicar-na-fila.ts). Leitura que falha lança — o catch do fim
    // responde o motivo, em vez de "nenhuma casou".
    let applied = 0
    let filaFalhou = 0
    let primeiraFalha = ''
    if (targetClient) {
      const upd: Record<string, unknown> = {
        category, category_confidence: 100, categorized_by: 'rule',
        status: 'auto', updated_at: new Date().toISOString(),
      }
      if (payee) upd.payee = payee
      const f = await aplicarNaFila(db, { clientId: targetClient, status: ['pending', 'auto'], casa: casaARegra, alteracao: upd })
      applied = f.aplicadas
      filaFalhou = f.falharam
      if (f.primeiraFalha) primeiraFalha = f.primeiraFalha
    }

    // ── RECLASSIFICAR O REGISTRO (aprovadas) — owner/manager + SENHA + MOTIVO ──
    let registerChanged = 0
    let registerCasou = 0
    let registerFalhou = 0
    // Pedir a reclassificação e não ter cliente alvo era PULADO em silêncio: a
    // senha foi digitada, o motivo foi escrito, a resposta saía ok e nada
    // acontecia. Se não dá para fazer, tem de recusar.
    if (b.applyToRegister === true && !targetClient) {
      return NextResponse.json({
        error: 'Para reclassificar o registro é preciso dizer de qual cliente. Abra a regra pela tela do cliente.',
      }, { status: 400 })
    }
    if (b.applyToRegister === true && targetClient) {
      const reason = String(b.reason || '').trim()
      if (reason.length < 5) {
        return NextResponse.json({ error: 'Motivo obrigatório (mín. 5 caracteres) para reclassificar o registro' }, { status: 400 })
      }
      const password = String(b.password || '')
      if (!password) return NextResponse.json({ error: 'Senha obrigatória para reclassificar o registro' }, { status: 400 })

      // Re-autenticação: valida a senha do próprio usuário logado
      const authClient = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { persistSession: false } }
      )
      // getAuth() devolve só userId/isStaff — o e-mail vem do próprio auth.
      // (Antes usava auth.email, que não existe: a senha era sempre recusada.)
      const { data: quem } = await db.auth.admin.getUserById(auth.userId)
      const emailLogado = quem?.user?.email
      if (!emailLogado) {
        return NextResponse.json({ error: 'Não foi possível identificar seu login para confirmar a senha.' }, { status: 400 })
      }

      const { error: pwErr } = await authClient.auth.signInWithPassword({
        email: emailLogado, password: password.trim(),
      })
      if (pwErr) {
        const m = pwErr.message || ''
        if (/rate|too many|429/i.test(m)) {
          return NextResponse.json({ error: 'Muitas tentativas em pouco tempo. Aguarde 1 minuto.' }, { status: 429 })
        }
        return NextResponse.json({
          error: `Senha não confere para ${emailLogado}. Use a mesma senha com que você entra no sistema.`,
        }, { status: 403 })
      }

      // status permanece: continua no registro, apenas reclassificado. O erro
      // era DESCARTADO (`if (!uErr) registerChanged++`): com todas as escritas
      // recusadas a resposta saía ok, com 0, e a tela nem mostrava o 0 — quem
      // pediu a reclassificação não tinha como saber que nada mudou. Agora a
      // falha viaja, e a gravação vai em lotes, como a da fila.
      const updReg: Record<string, unknown> = { category, categorized_by: 'rule', updated_at: new Date().toISOString() }
      if (payee) updReg.payee = payee
      const reg = await aplicarNaFila(db, { clientId: targetClient, status: ['approved', 'reviewed'], casa: casaARegra, alteracao: updReg })
      registerCasou = reg.casaram
      registerChanged = reg.aplicadas
      registerFalhou = reg.falharam
      if (!primeiraFalha && reg.primeiraFalha) primeiraFalha = reg.primeiraFalha

      await db.from('bookkeeping_reclass_log').insert({
        rule_id: b.id, client_id: targetClient,
        changed_by: auth.userId, changed_by_email: emailLogado,
        reason, affected_register: registerChanged,
        new_category: category, new_payee: payee || null,
      })
    }

    return NextResponse.json({
      ok: true, applied, registerChanged,
      // O que a tela precisa para não mentir: quantas CASARAM, quantas o banco
      // recusou, e o texto da primeira recusa. Sem isso "0 reclassificadas" e
      // "20 recusadas pelo banco" ficam indistinguíveis.
      registerCasou, registerFalhou, filaFalhou,
      falhaExemplo: primeiraFalha || undefined,
      // Regra geral editada pela tela de um cliente só reclassifica o registro
      // DAQUELE cliente. Dizer isso evita a conclusão de que "não funcionou".
      escopoDoRegistro: b.applyToRegister === true
        ? (global ? 'apenas o cliente aberto (a regra vale para todos, a reclassificação não)' : 'este cliente')
        : undefined,
      scope: global ? 'global' : 'client',
      aviso: mudouEscopo
        ? (global
            ? 'A regra passou a valer para todos os clientes.'
            : 'A regra passou a valer só para este cliente — deixa de ser aplicada aos demais. O que já foi classificado nos outros continua como está.')
        : undefined,
    })
  } catch (e) {
    // `aplicarNaFila` lanca quando a leitura dos lancamentos falha. Sem isto a
    // rota devolveria 500 sem corpo e a tela diria so "Servidor respondeu 500".
    return NextResponse.json({ error: `Regra salva, mas ${(e as Error).message}` }, { status: 500 })
  }
}
