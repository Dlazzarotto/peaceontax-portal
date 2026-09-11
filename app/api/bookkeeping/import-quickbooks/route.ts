// POST /api/bookkeeping/import-quickbooks — histórico do QuickBooks Online
//
// Recebe o relatório "Transaction List by Date" ou "Transaction Detail by
// Account" exportado em CSV/Excel-texto. Dois modos (mesmo desenho do CSV do banco):
//
//   preview: true  → lê o arquivo e devolve: contas encontradas, tipos de
//                    lançamento, categorias (Split) casadas e não casadas com
//                    as do sistema, período e amostra. NÃO grava nada.
//   preview: false → grava em bank_transactions. Categoria vem do Split
//                    (já decidida por uma pessoa no QuickBooks → categorized_by
//                    'staff', status 'approved'); Split sem correspondência
//                    fica pendente para a equipe classificar.
//
// Campos do formulário (multipart):
//   file, clientId, preview, from?, to?
//   contas       JSON [{ nome, importar, accountId|null, tipo, inverter }]
//                nome = conta como está no QuickBooks; accountId = conta já
//                cadastrada (ou null para criar com esse nome); inverter = true
//                quando o relatório mostra saídas como positivas (cartão).
//   mapeamento   JSON { "Split do QuickBooks": "Categoria do sistema" }
//
// Dedupe: mesma chave do CSV/PDF (client_id, tx_date, description, amount) —
// reenviar o arquivo não duplica. Equipe apenas; confere acesso ao cliente.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { applyRulesToClient } from '@/lib/apply-rules'
import { lerRelatorioQuickBooks, descricaoDaLinha, splitIndefinido, normalizarCategoriaQB } from '@/lib/quickbooks-import'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

type ContaEscolha = { nome: string; importar?: boolean; accountId?: string | null; tipo?: string; inverter?: boolean }

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    const clientId = String(form.get('clientId') || '')
    const preview = String(form.get('preview') || '') === 'true'
    const from = String(form.get('from') || '')
    const to = String(form.get('to') || '')
    if (!file || !clientId) return NextResponse.json({ error: 'file e clientId obrigatórios' }, { status: 400 })
    if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

    const leitura = lerRelatorioQuickBooks(await file.text())
    if (leitura.formato === 'desconhecido') {
      return NextResponse.json({ error: 'Não encontrei o cabeçalho do relatório (colunas Date e Amount). Exporte "Transaction List by Date" ou "Transaction Detail by Account" do QuickBooks.' }, { status: 422 })
    }
    if (leitura.colunas.split == null) {
      return NextResponse.json({ error: 'O relatório não tem a coluna Split (categoria). Use "Transaction List by Date" ou "Transaction Detail by Account".' }, { status: 422 })
    }
    if (leitura.linhas.length === 0) {
      return NextResponse.json({ error: 'Nenhum lançamento com data e valor no arquivo.' }, { status: 422 })
    }

    const db = serviceDb()
    const [{ data: cats }, { data: contasCliente }] = await Promise.all([
      db.from('bookkeeping_categories').select('name').eq('active', true),
      db.from('bank_accounts').select('id, name').eq('client_id', clientId),
    ])
    // Casamento de categoria: nome exato, sem diferenciar maiúsculas
    const porNome = new Map<string, string>()
    for (const c of cats || []) porNome.set(normalizarCategoriaQB(c.name).toLowerCase(), c.name)

    const emJanela = leitura.linhas.filter(l => (!from || l.date >= from) && (!to || l.date <= to))

    // ── Prévia ──
    if (preview) {
      const contas: Record<string, { nome: string; total: number; entradas: number; saidas: number; de: string; ate: string }> = {}
      const tipos: Record<string, number> = {}
      const splits: Record<string, { total: number; categoria: string | null }> = {}
      for (const l of leitura.linhas) {
        const k = l.account || '(sem conta)'
        contas[k] = contas[k] || { nome: k, total: 0, entradas: 0, saidas: 0, de: l.date, ate: l.date }
        contas[k].total++; if (l.amount >= 0) contas[k].entradas++; else contas[k].saidas++
        if (l.date < contas[k].de) contas[k].de = l.date
        if (l.date > contas[k].ate) contas[k].ate = l.date
        tipos[l.type || '(sem tipo)'] = (tipos[l.type || '(sem tipo)'] || 0) + 1
        const sp = splitIndefinido(l.split) ? '-Split-' : l.split
        splits[sp] = splits[sp] || { total: 0, categoria: splitIndefinido(l.split) ? null : (porNome.get(sp.toLowerCase()) || null) }
        splits[sp].total++
      }
      const datas = leitura.linhas.map(l => l.date).sort()

      // Lançamentos que o cliente já tem no período (mesmo aviso do CSV)
      const { data: jaExiste } = await db.from('bank_transactions')
        .select('tx_date, source, account_id').eq('client_id', clientId)
        .gte('tx_date', datas[0]).lte('tx_date', datas[datas.length - 1]).neq('status', 'excluded').limit(20000)
      const nomeConta = new Map((contasCliente || []).map((a: any) => [a.id, a.name]))
      const porConta: Record<string, { nome: string; total: number; fontes: Record<string, number> }> = {}
      for (const t of jaExiste || []) {
        const key = (t as any).account_id || 'sem-conta'
        porConta[key] = porConta[key] || { nome: nomeConta.get(key) || 'Sem conta', total: 0, fontes: {} }
        porConta[key].total++
        const f = (t as any).source || 'outro'
        porConta[key].fontes[f] = (porConta[key].fontes[f] || 0) + 1
      }

      return NextResponse.json({
        ok: true, preview: true, formato: leitura.formato,
        resumo: {
          total: leitura.linhas.length, ignoradas: leitura.ignoradas.length,
          de: datas[0], ate: datas[datas.length - 1],
          colunas: Object.keys(leitura.colunas),
        },
        contas: Object.values(contas).sort((a, b) => b.total - a.total),
        tipos: Object.entries(tipos).map(([tipo, total]) => ({ tipo, total })).sort((a, b) => b.total - a.total),
        categorias: Object.entries(splits).map(([split, v]) => ({ split, ...v })).sort((a, b) => b.total - a.total),
        contasCliente: contasCliente || [],
        amostra: leitura.linhas.slice(0, 8).map(l => ({ date: l.date, description: descricaoDaLinha(l), amount: l.amount, split: l.split, account: l.account })),
        existentes: { total: (jaExiste || []).length, contas: Object.entries(porConta).map(([id, v]) => ({ accountId: id, ...v })) },
        ignoradas: leitura.ignoradas.slice(0, 10),
      })
    }

    // ── Importação ──
    let escolhas: ContaEscolha[] = []
    let mapeamento: Record<string, string> = {}
    try { escolhas = JSON.parse(String(form.get('contas') || '[]')) } catch { escolhas = [] }
    try { mapeamento = JSON.parse(String(form.get('mapeamento') || '{}')) } catch { mapeamento = {} }
    const porContaQB = new Map(escolhas.map(e => [e.nome, e]))

    // Só o que a equipe marcou; sem lista, importa todas as contas do arquivo
    const selecionadas = emJanela.filter(l => {
      const e = porContaQB.get(l.account || '(sem conta)')
      return e ? e.importar !== false : escolhas.length === 0
    })
    if (selecionadas.length === 0) {
      return NextResponse.json({ error: 'Nenhum lançamento selecionado: confira as contas marcadas e o período.' }, { status: 422 })
    }

    // Contas bancárias: usa a escolhida ou cria com o nome do QuickBooks
    const idDaConta = new Map<string, string | null>()
    for (const nomeQB of new Set(selecionadas.map(l => l.account || '(sem conta)'))) {
      const e = porContaQB.get(nomeQB)
      if (e?.accountId) { idDaConta.set(nomeQB, e.accountId); continue }
      const { data: acc, error } = await db.from('bank_accounts').upsert(
        { client_id: clientId, name: nomeQB, account_hint: nomeQB, type: e?.tipo === 'credit' ? 'credit' : 'checking' },
        { onConflict: 'client_id,name' }
      ).select('id').single()
      if (error) return NextResponse.json({ error: `Conta "${nomeQB}": ${error.message}` }, { status: 500 })
      idDaConta.set(nomeQB, acc?.id ?? null)
    }

    // Categoria: Split casado com o sistema, ou mapeado pela equipe; senão pendente
    const categoriaDe = (split: string): string | null => {
      if (splitIndefinido(split)) return null
      const m = mapeamento[split]
      if (m && porNome.has(normalizarCategoriaQB(m).toLowerCase())) return porNome.get(normalizarCategoriaQB(m).toLowerCase())!
      return porNome.get(split.toLowerCase()) || null
    }

    let semCategoria = 0
    const registros = selecionadas.map(l => {
      const nomeQB = l.account || '(sem conta)'
      const e = porContaQB.get(nomeQB)
      const amount = e?.inverter ? -l.amount : l.amount
      const categoria = categoriaDe(l.split)
      if (!categoria) semCategoria++
      return {
        client_id: clientId,
        account_id: idDaConta.get(nomeQB) ?? null,
        source: 'quickbooks',
        account_hint: nomeQB,
        tx_date: l.date,
        description: descricaoDaLinha(l),
        amount: Math.round(amount * 100) / 100,
        balance: l.balance,
        payee: l.name ? l.name.slice(0, 120) : null,
        memo: l.memo ? l.memo.slice(0, 500) : null,
        fiscal_year: parseInt(l.date.slice(0, 4)),
        category: categoria,
        category_confidence: categoria ? 100 : null,
        categorized_by: categoria ? 'staff' : null,     // decidida por uma pessoa no QuickBooks
        status: categoria ? 'approved' : 'pending',
      }
    })

    let inseridas = 0
    for (let i = 0; i < registros.length; i += 500) {
      const { data, error } = await db.from('bank_transactions')
        .upsert(registros.slice(i, i + 500), { onConflict: 'client_id,tx_date,description,amount', ignoreDuplicates: true })
        .select('id')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      inseridas += data?.length ?? 0
    }

    // Regras do cliente classificam o que ficou pendente (Split indefinido ou sem correspondência)
    const ruled = inseridas > 0 && semCategoria > 0 ? await applyRulesToClient(db, clientId).catch(() => 0) : 0

    return NextResponse.json({
      ok: true, inseridas, duplicadas: registros.length - inseridas,
      semCategoria, classificadasPorRegra: ruled,
      contas: [...idDaConta.keys()],
    })
  } catch (e) {
    console.error('import-quickbooks:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
