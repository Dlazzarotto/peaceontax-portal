// POST /api/bookkeeping/categorize — categoriza as transações pendentes de um cliente
// Body: { clientId, year? }
// 1º regras (do cliente + globais, por prioridade) → 2º IA em lote → ≥95% vira 'auto',
// abaixo disso fica 'pending' com sugestão + confiança para a equipe revisar.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'

export const maxDuration = 300  // Vercel Pro: até 300s — lotes grandes na sugestão da IA

async function loadCategories(db: any): Promise<string[]> {
  const { data } = await db.from('bookkeeping_categories').select('name').eq('active', true)
  return (data || []).map((c: any) => c.name)
}

const AI_PROMPT = (txList: string, cats: string[]) => `You are a bookkeeping categorization engine for a US accounting firm (cash-basis, small business).

Categorize each bank transaction into EXACTLY ONE of these categories:
${cats.join(', ')}

Guidelines:
- Positive amounts are deposits/credits; negative are payments/debits
- "Income": customer payments, sales deposits. "Owner Contribution": owner putting personal money in
- "Owner Draw": ATM withdrawals, transfers to owner. "Personal": clearly personal spending (groceries for home, personal shopping) in a business account
- NEVER use "Transfer" or "Credit Card Payment". Movements between the client's own accounts are decided elsewhere by matching the account number. If a description mentions a transfer but reached you, the other account is NOT the client's — treat it as a normal deposit (income) or payment (expense) with the world outside
- Payments FROM checking TO a credit card ("payment to chase card", "crcardpmt", "online payment thank you") = "Credit Card Payment" (liability payment, NOT an expense — the expenses live on the credit card statement itself)
- On CREDIT CARD statements: purchases are the actual expenses (categorize normally); payments received on the card = "Credit Card Payment"
- Restaurants/food during business = "Meals". Supermarkets are usually "Personal" unless clearly supplies
- Liquor stores, entertainment = "Personal" unless the business is hospitality
- confidence: 0-100, your certainty. Be conservative: ambiguous merchant = lower confidence

Also extract the PAYEE (vendor/person paid or payer) from each description:
- Normalize the name: "CHECKCARD 0929 AT&T*BILL PAYMENT 800-331-0500 TX" → "AT&T"
- "Zelle Transfer Conf# abc; Paulo Bruestle" → "Paulo Bruestle"
- "STAR MARKET 35 09/29 #000130919 PURCHASE" → "Star Market"
- Checks without payee info → null. ATM/generic deposits → null

Respond ONLY with a JSON array, no markdown:
[{"id":"...","category":"...","confidence":95,"payee":"AT&T"}]

Transactions:
${txList}`

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const { clientId, year, mode } = await req.json()
  const useAI = mode === 'ai'   // padrão: SÓ regras — nada é pré-definido sem regra
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })
  if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

  const db = serviceDb()
  const CATEGORIES = await loadCategories(db)

  // Pendentes + reconhecidas (regras têm prioridade e também reprocessam as 'auto';
  // aprovadas/registro nunca são tocadas)
  // Lê TODAS as transações em páginas, em ordem estável.
  // (Antes havia um teto de 800 sem ordenação: em clientes com mais que isso,
  //  parte dos lançamentos nunca era avaliada — mesmo vendor pegava uns e outros não.)
  const PAGINA = 1000
  const txs: any[] = []
  for (let inicio = 0; ; inicio += PAGINA) {
    let q = db.from('bank_transactions')
      .select('id, description, amount, status, account_id, tx_date, transfer_match_id')
      .eq('client_id', clientId)
      .in('status', ['pending', 'auto'])
      .order('id', { ascending: true })
      .range(inicio, inicio + PAGINA - 1)
    if (year) q = q.eq('fiscal_year', year)
    const { data: pagina, error: pErr } = await q
    if (pErr) return NextResponse.json({ error: `Falha ao ler transações: ${pErr.message}` }, { status: 500 })
    if (!pagina || pagina.length === 0) break
    txs.push(...pagina)
    if (pagina.length < PAGINA) break
  }
  if (txs.length === 0) return NextResponse.json({ ok: true, ruled: 0, ai: 0, review: 0, message: 'Nada pendente' })

  // Regras por prioridade. Em non-profit, SÓ as do próprio cliente:
  // cada entidade tem fundos/projetos únicos, regra global não se aplica.
  const { data: cli } = await db.from('clients')
    .select('business_kind').eq('id', clientId).maybeSingle()
  const soDoCliente = cli?.business_kind === 'nonprofit'

  let rq = db.from('bookkeeping_rules')
    .select('pattern, category, priority, client_id, direction, match_type, amount_op, amount_value, payee, account_id')
  rq = soDoCliente
    ? rq.eq('client_id', clientId)
    : rq.or(`client_id.eq.${clientId},client_id.is.null`)
  const { data: rulesRaw } = await rq.order('priority', { ascending: true })
  // Regra do próprio cliente vence a regra geral quando ambas casam
  const rules = (rulesRaw || []).slice().sort((a: any, b: any) =>
    (Number(a.priority) - Number(b.priority)) ||
    ((a.client_id ? 0 : 1) - (b.client_id ? 0 : 1)))

  // Casamento por PALAVRA INTEIRA (não por pedaço).
  // "mobil" não pode casar dentro de "Mobilizat", nem "bk" dentro de "BKOFAMERICA".
  const escapar = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const casaTexto = (desc: string, v: string, tipo: string): boolean => {
    if (!v) return false
    return tipo === 'starts_with'
      ? new RegExp('^' + escapar(v) + '([^a-z0-9]|$)', 'i').test(desc)
      : new RegExp('(^|[^a-z0-9])' + escapar(v) + '([^a-z0-9]|$)', 'i').test(desc)
  }

  const ruleMatches = (r: any, desc: string, amount: number, accountId: string | null): boolean => {
    // Conta (fundo): regra restrita a uma conta só vale naquela conta
    if (r.account_id && r.account_id !== accountId) return false
    // Direção
    if (r.direction === 'in' && amount <= 0) return false
    if (r.direction === 'out' && amount >= 0) return false
    // Descrição — múltiplas variações separadas por | (OR)
    if (r.pattern) {
      const variants = String(r.pattern).toLowerCase().split('|').map((v: string) => v.trim()).filter(Boolean)
      const hit = variants.some((v: string) => casaTexto(desc, v, r.match_type))
      if (!hit) return false
    }
    // Valor (comparação pelo valor absoluto)
    if (r.amount_op) {
      const abs = Math.abs(amount), v = Number(r.amount_value)
      if (r.amount_op === 'gt' && !(abs > v)) return false
      if (r.amount_op === 'lt' && !(abs < v)) return false
      if (r.amount_op === 'eq' && Math.abs(abs - v) > 0.005) return false
    }
    return true
  }

  let ruled = 0
  const unresolved: any[] = []
  const erros: string[] = []

  // Agrupa por (categoria + payee) e grava em lote — antes era um UPDATE por
  // lançamento, o que estourava o tempo em clientes com muitos movimentos.
  const lotes = new Map<string, { category: string; payee: string | null; ids: string[] }>()

  for (const tx of txs) {
    const desc = String(tx.description).toLowerCase()
    const rule = (rules || []).find((r: any) => ruleMatches(r, desc, Number(tx.amount), tx.account_id || null))
    if (!rule) { unresolved.push(tx); continue }
    const chave = `${rule.category}||${rule.payee || ''}`
    const grupo = lotes.get(chave) || { category: rule.category as string, payee: (rule.payee || null) as string | null, ids: [] as string[] }
    grupo.ids.push(tx.id)
    lotes.set(chave, grupo)
  }

  for (const grupo of Array.from(lotes.values())) {
    const upd: Record<string, unknown> = {
      category: grupo.category, category_confidence: 100,
      categorized_by: 'rule', status: 'auto',
      updated_at: new Date().toISOString(),
    }
    if (grupo.payee) upd.payee = grupo.payee
    for (let i = 0; i < grupo.ids.length; i += 400) {
      const fatia = grupo.ids.slice(i, i + 400)
      const { error } = await db.from('bank_transactions').update(upd).in('id', fatia)
      if (error) erros.push(`${grupo.category}: ${error.message}`)
      else ruled += fatia.length
    }
  }

  // ── Transferências entre contas do próprio cliente ──
  // Espelho exato (valor oposto, contas diferentes, até 7 dias). Só vincula
  // quando há UM único candidato — e entra como 'auto', aguardando aprovação.
  let transfers = 0
  const { data: contasCli } = await db.from('bank_accounts')
    .select('id, name, type, account_hint').eq('client_id', clientId)
  const tipoConta = new Map((contasCli || []).map((a: any) => [a.id, String(a.type || '').toLowerCase()]))

  const dias = (a: string, b: string) =>
    Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000)

  const porValor = new Map<string, any[]>()
  for (const t of txs) {
    const k = Math.abs(Number(t.amount)).toFixed(2)
    if (!porValor.has(k)) porValor.set(k, [])
    porValor.get(k)!.push(t)
  }

  // Os extratos dizem a conta na própria descrição:
  // "Online Banking transfer from CHK 7495" → a outra ponta é a conta ...7495.
  // Extrai apenas números de 4 dígitos precedidos por indicação de conta
  // (CHK, SAV, account, card, ...) — nunca de confirmações tipo XXXXX32635.
  // SÓ é transferência quando o extrato diz literalmente "transfer to" ou
  // "transfer from" (ou pagamento de cartão citando um cartão cadastrado).
  // Nada de espelho por valor: valor igual em duas contas não prova nada.
  const sentidoTransferencia = (desc: string): 'to' | 'from' | 'card' | null => {
    const m = /(^|[^a-z])transfer(?:s|red)?[^a-z0-9]{1,3}(to|from)([^a-z]|$)/i.exec(desc)
    if (m) return m[2].toLowerCase() as 'to' | 'from'
    if (/(^|[^a-z])(payment|autopay|crcardpmt|pmt)([^a-z]|$)/i.test(desc)) return 'card'
    return null
  }

  const quatroDigitos = (texto: string): string[] => {
    const achados: string[] = []
    const re = /(?:chk|sav|checking|savings|acct|account|card|ending(?:\s+in)?|[x*•]{2,}|\.{3})\s*#?\s*(\d{4})(?!\d)/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(texto)) !== null) achados.push(m[1])
    return achados
  }

  // Últimos 4 dígitos de cada conta do cliente (vêm do nome/apelido: "BofA ...7495")
  const finalDaConta = new Map<string, string>()
  for (const a of (contasCli || []) as any[]) {
    const digs = String(`${a.name || ''} ${a.account_hint || ''}`).match(/(\d{4})(?!\d)/g)
    if (digs && digs.length) finalDaConta.set(a.id, digs[digs.length - 1])
  }

  const contasDeFora = new Set<string>()
  const usados = new Set<string>()
  const naoCasadas: any[] = []

  // Passo 1: casar pela conta citada na descrição
  const porDescricao: any[] = []
  for (const t of unresolved) {
    if (t.transfer_match_id) continue
    if (!sentidoTransferencia(String(t.description))) continue
    const tokens = quatroDigitos(String(t.description))
    if (tokens.length === 0) continue
    const alvos = (contasCli || []).filter((a: any) =>
      a.id !== t.account_id && finalDaConta.get(a.id) && tokens.includes(finalDaConta.get(a.id)!))
    if (alvos.length === 0) {
      // Cita uma conta que NÃO é deste cliente: dinheiro de fora, não é
      // movimentação interna. Fica para decisão manual (pode ser receita).
      for (const d of tokens) contasDeFora.add(d)
      continue
    }
    if (alvos.length !== 1) continue
    porDescricao.push({ tx: t, conta: alvos[0] })
  }

  for (const { tx: t, conta } of porDescricao) {
    if (usados.has(t.id)) continue
    const ehCartao = /credit|card|cart/.test(
      String(tipoConta.get(t.account_id) || '') + ' ' + String(tipoConta.get(conta.id) || ''))
    // "payment ..." só conta como transferência se a conta citada for um cartão
    if (sentidoTransferencia(String(t.description)) === 'card' && !ehCartao) continue
    const cat = ehCartao ? 'Credit Card Payment' : 'Transfer'

    // Se houver o lançamento espelho naquela conta, vincula as duas pontas
    const espelho = (porValor.get(Math.abs(Number(t.amount)).toFixed(2)) || []).find((o: any) =>
      o.id !== t.id && !usados.has(o.id) && !o.transfer_match_id &&
      o.account_id === conta.id &&
      Math.abs(Number(o.amount) + Number(t.amount)) < 0.005 &&
      dias(o.tx_date, t.tx_date) <= 7)

    const base = {
      category: cat, category_confidence: 100, categorized_by: 'rule',
      status: 'auto', updated_at: new Date().toISOString(),
    }
    const { error: e1 } = await db.from('bank_transactions').update({
      ...base,
      counterparty_account_id: conta.id,
      ...(espelho ? { transfer_match_id: espelho.id } : {}),
    }).eq('id', t.id)
    if (e1) { erros.push(`transferência: ${e1.message}`); continue }
    usados.add(t.id); transfers++

    if (espelho) {
      await db.from('bank_transactions').update({
        ...base, transfer_match_id: t.id, counterparty_account_id: t.account_id,
      }).eq('id', espelho.id)
      usados.add(espelho.id); transfers++
    }
  }


  // ── Pagamento DENTRO do cartão de crédito ──
  // Na fatura, o pagamento recebido ("PAYMENT - THANK YOU") é quitação de
  // dívida, nunca receita. A despesa real são as COMPRAS do cartão.
  const ehPagamentoNoCartao = (desc: string, amount: number, contaId: string | null): boolean => {
    if (amount <= 0) return false
    if (!/credit|card|cart/.test(String(tipoConta.get(contaId || '') || ''))) return false
    return /(^|[^a-z])(payment|pmt|autopay|crcardpmt)([^a-z]|$)|thank you/i.test(desc)
  }

  for (const t of txs) {
    if (usados.has(t.id) || t.transfer_match_id) continue
    if (!ehPagamentoNoCartao(String(t.description), Number(t.amount), t.account_id)) continue

    // Procura a saída correspondente na conta corrente (mesma quantia, até 7 dias)
    const espelhoCC = (porValor.get(Math.abs(Number(t.amount)).toFixed(2)) || []).find((o: any) =>
      o.id !== t.id && !usados.has(o.id) && !o.transfer_match_id &&
      o.account_id && o.account_id !== t.account_id &&
      Math.abs(Number(o.amount) + Number(t.amount)) < 0.005 &&
      dias(o.tx_date, t.tx_date) <= 7)

    const base = {
      category: 'Credit Card Payment', category_confidence: 100,
      categorized_by: 'rule', status: 'auto', updated_at: new Date().toISOString(),
    }
    const { error: ec } = await db.from('bank_transactions').update({
      ...base,
      ...(espelhoCC ? { transfer_match_id: espelhoCC.id, counterparty_account_id: espelhoCC.account_id } : {}),
    }).eq('id', t.id)
    if (ec) continue
    usados.add(t.id); transfers++

    if (espelhoCC) {
      await db.from('bank_transactions').update({
        ...base, transfer_match_id: t.id, counterparty_account_id: t.account_id,
      }).eq('id', espelhoCC.id)
      usados.add(espelhoCC.id); transfers++
    }
  }

  // (Removido) Espelho por valor sem a conta citada: gerava falsos positivos
  // — Zelle de $12,34 casando com outra conta, wire devolvido virando transferência.
  for (const t of unresolved) {
    if (!usados.has(t.id)) naoCasadas.push(t)
  }

  // IA em lote no que sobrou
  let aiAuto = 0, review = 0, transferenciaExterna = 0
  const aiCandidates = naoCasadas.filter((t: any) => t.status === 'pending' && !usados.has(t.id))
  if (useAI && aiCandidates.length > 0) {
    const txList = aiCandidates.map(t => JSON.stringify({ id: t.id, description: t.description, amount: t.amount })).join('\n')

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        messages: [{ role: 'user', content: AI_PROMPT(txList, CATEGORIES) }],
      }),
    })

    // Regra contábil: Transfer/Credit Card Payment SÓ com a conta contraparte no sistema
    const { data: clientAccounts } = await db.from('bank_accounts')
      .select('id, type').eq('client_id', clientId).eq('active', true)
    const accountCount = (clientAccounts || []).length
    const hasCreditCard = (clientAccounts || []).some(a => a.type === 'credit_card')

    if (response.ok) {
      const data = await response.json()
      const text = (data.content?.find((b: any) => b.type === 'text')?.text || '')
        .replace(/```json|```/g, '').trim()
      let results: { id: string; category: string; confidence: number }[] = []
      try { results = JSON.parse(text) } catch { results = [] }

      for (const r of results) {
        if (!r.id || !CATEGORIES.includes(r.category)) continue
        let conf = Math.max(0, Math.min(100, Number(r.confidence) || 0))

        // Transferência é decidida pelo motor determinístico (conta citada bater
        // com uma conta cadastrada do cliente) — a IA não decide isso.
        // Se chegou aqui, é porque NÃO houve casamento de conta: então é
        // movimento com o mundo externo, ou seja, entrada/saída normal.
        if (r.category === 'Transfer' || r.category === 'Credit Card Payment') {
          transferenciaExterna++
          continue   // deixa para regra/decisão manual, nunca como transferência
        }
        void accountCount; void hasCreditCard

        const isAuto = conf >= 95
        const payee = typeof (r as any).payee === 'string' && (r as any).payee.trim().length >= 2
          ? (r as any).payee.trim().slice(0, 120) : null
        await db.from('bank_transactions').update({
          category: r.category, category_confidence: conf,
          categorized_by: 'ai', payee,
          status: isAuto ? 'auto' : 'pending',   // <95%: sugestão fica, status segue pendente
          updated_at: new Date().toISOString(),
        }).eq('id', r.id).eq('client_id', clientId)
        if (isAuto) aiAuto++; else review++
      }
    } else {
      review = aiCandidates.length
    }
  }

  // Backfill: payee ausente em transações já categorizadas (regras antigas não extraíam)
  let payeesFilled = 0
  const { data: noPayee } = await db.from('bank_transactions')
    .select('id, description')
    .eq('client_id', clientId)
    .is('payee', null)
    .in('status', ['auto', 'reviewed'])
    .limit(200)
  if (noPayee && noPayee.length > 0) {
    const listStr = noPayee.map(t => JSON.stringify({ id: t.id, description: t.description })).join('\n')
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 6000,
        messages: [{ role: 'user', content: `Extract the normalized PAYEE (vendor/person) from each bank transaction description. Examples: "CHECKCARD AT&T*BILL PAYMENT" → "AT&T"; "Zelle Conf#abc; Paulo Bruestle" → "Paulo Bruestle"; generic deposits/ATM → null.\nRespond ONLY a JSON array: [{"id":"...","payee":"..."}] (payee null if unknown)\n\n${listStr}` }],
      }),
    })
    if (resp.ok) {
      const d2 = await resp.json()
      const t2 = (d2.content?.find((b: any) => b.type === 'text')?.text || '').replace(/```json|```/g, '').trim()
      try {
        const arr = JSON.parse(t2)
        for (const r of arr) {
          if (r.id && typeof r.payee === 'string' && r.payee.trim().length >= 2) {
            await db.from('bank_transactions').update({ payee: r.payee.trim().slice(0, 120) })
              .eq('id', r.id).eq('client_id', clientId)
            payeesFilled++
          }
        }
      } catch {}
    }
  }

  return NextResponse.json({
    ok: true, ruled, ai: aiAuto, review, payeesFilled, transfers,
    contasDeFora: contasDeFora.size ? Array.from(contasDeFora) : undefined,
    transferenciaExterna: transferenciaExterna || undefined,
    avaliadas: txs.length,
    erros: erros.length ? erros.slice(0, 5) : undefined,
  })
}
