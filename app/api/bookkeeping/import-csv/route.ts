// POST /api/bookkeeping/import-csv
//
// Importa o CSV que o cliente baixa do banco (útil para bancos fora do Plaid,
// como Cambridge Savings Bank). Dois modos:
//
//   preview: true  → detecta as colunas e devolve amostra, SEM gravar nada
//   preview: false → grava em bank_transactions com o mesmo dedupe do PDF
//
// Aceita os formatos comuns: Debit/Credit separados ou coluna única Amount.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { applyRulesToClient } from '@/lib/apply-rules'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ── CSV com aspas, vírgulas dentro do campo e quebras \r\n ──
function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '')          // remove BOM
  const rows: string[][] = []
  let row: string[] = [], field = '', inQuotes = false

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(cell => cell.trim() !== ''))
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

// "1,234.56" / "(123.45)" / "-123,45" → número
function toNumber(v: string): number | null {
  if (!v) return null
  let s = v.trim().replace(/[$\s]/g, '')
  if (!s) return null
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  if (s.startsWith('-')) { neg = true; s = s.slice(1) }
  // 1.234,56 (formato BR) vs 1,234.56 (US)
  if (/,\d{2}$/.test(s) && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.')
  else s = s.replace(/,/g, '')
  const n = Number(s)
  if (!isFinite(n)) return null
  return neg ? -n : n
}

// MM/DD/YYYY · YYYY-MM-DD · DD-MMM-YYYY → YYYY-MM-DD
function toDate(v: string): string | null {
  const s = (v || '').trim()
  if (!s) return null
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/)
  if (m) {
    const mm = m[1].padStart(2, '0'), dd = m[2].padStart(2, '0')
    let yy = m[3]
    if (yy.length === 2) yy = Number(yy) > 60 ? `19${yy}` : `20${yy}`
    return `${yy}-${mm}-${dd}`      // padrão americano MM/DD/YYYY
  }
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

type Cols = {
  date: number; desc: number; desc2: number
  debit: number; credit: number; amount: number
  balance: number; check: number
}

function detectColumns(header: string[]): Cols {
  const idx = (...names: string[]) =>
    header.findIndex(h => names.some(n => norm(h) === n || norm(h).includes(n)))
  return {
    date:    idx('date', 'data', 'postingdate', 'transactiondate'),
    desc:    idx('description', 'descricao', 'payee', 'name', 'memo'),
    desc2:   header.findIndex((h, i) => i > 0 && /transactiondescription|memo|details/.test(norm(h))),
    debit:   idx('debit', 'withdrawal', 'saida', 'debito'),
    credit:  idx('credit', 'deposit', 'entrada', 'credito'),
    amount:  idx('amount', 'valor'),
    balance: idx('runningbalance', 'balance', 'saldo'),
    check:   idx('checknumber', 'custref', 'check', 'cheque'),
  }
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    const clientId = String(form.get('clientId') || '')
    const accountId = String(form.get('accountId') || '') || null
    const accountName = String(form.get('accountName') || '').trim()
    const preview = String(form.get('preview') || '') === 'true'
    const from = String(form.get('from') || '')   // recorte opcional: só a partir desta data
    const to   = String(form.get('to') || '')     // e/ou até esta data

    if (!file || !clientId) return NextResponse.json({ error: 'file e clientId obrigatórios' }, { status: 400 })
    if (!(await canAccessClient(auth, clientId))) return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

    const rows = parseCsv(await file.text())
    if (rows.length < 2) return NextResponse.json({ error: 'CSV vazio ou ilegível' }, { status: 422 })

    const header = rows[0]
    const c = detectColumns(header)
    if (c.date < 0) return NextResponse.json({ error: 'Não encontrei a coluna de data no CSV' }, { status: 422 })
    if (c.amount < 0 && c.debit < 0 && c.credit < 0) {
      return NextResponse.json({ error: 'Não encontrei colunas de valor (Amount ou Debit/Credit)' }, { status: 422 })
    }

    const parsed: { date: string; description: string; amount: number; balance: number | null }[] = []
    const ignoradas: string[] = []

    for (const r of rows.slice(1)) {
      const date = toDate(r[c.date] || '')
      if (!date) { ignoradas.push((r[c.date] || '').slice(0, 30)); continue }

      let amount: number | null = null
      if (c.amount >= 0) amount = toNumber(r[c.amount] || '')
      else {
        const deb = c.debit >= 0 ? toNumber(r[c.debit] || '') : null
        const cre = c.credit >= 0 ? toNumber(r[c.credit] || '') : null
        if (deb != null && deb !== 0) amount = -Math.abs(deb)          // débito = saída
        else if (cre != null && cre !== 0) amount = Math.abs(cre)      // crédito = entrada
      }
      if (amount == null || !isFinite(amount)) { ignoradas.push(date); continue }

      const partes = [
        c.desc >= 0 ? (r[c.desc] || '').trim() : '',
        c.desc2 >= 0 ? (r[c.desc2] || '').trim() : '',
      ].filter(Boolean)
      const chk = c.check >= 0 ? (r[c.check] || '').trim().replace(/^0+/, '') : ''
      let description = partes.join(' — ') || 'Lançamento'
      if (chk) description += ` (Check #${chk})`

      parsed.push({
        date,
        description: description.slice(0, 500),
        amount: Math.round(amount * 100) / 100,
        balance: c.balance >= 0 ? toNumber(r[c.balance] || '') : null,
      })
    }

    if (parsed.length === 0) {
      return NextResponse.json({ error: 'Nenhuma linha válida encontrada no CSV' }, { status: 422 })
    }

    // Recorte de período (evita reimportar meses que já vieram por PDF/Plaid)
    const emJanela = parsed.filter(p =>
      (!from || p.date >= from) && (!to || p.date <= to))

    const datas = parsed.map(p => p.date).sort()
    const resumo = {
      total: parsed.length,
      ignoradas: ignoradas.length,
      de: datas[0],
      ate: datas[datas.length - 1],
      entradas: parsed.filter(p => p.amount > 0).length,
      saidas: parsed.filter(p => p.amount < 0).length,
      colunas: {
        data: header[c.date] || null,
        descricao: [c.desc, c.desc2].filter(i => i >= 0).map(i => header[i]),
        valor: c.amount >= 0 ? [header[c.amount]] : [c.debit >= 0 ? header[c.debit] : null, c.credit >= 0 ? header[c.credit] : null].filter(Boolean),
        saldo: c.balance >= 0 ? header[c.balance] : null,
        cheque: c.check >= 0 ? header[c.check] : null,
      },
    }

    if (preview) {
      // O que já existe no período deste CSV — e de onde veio
      const dbp = serviceDb()
      const [{ data: jaExiste }, { data: contas }] = await Promise.all([
        dbp.from('bank_transactions')
          .select('tx_date, source, account_id')
          .eq('client_id', clientId)
          .gte('tx_date', resumo.de)
          .lte('tx_date', resumo.ate)
          .neq('status', 'excluded')
          .limit(20000),
        dbp.from('bank_accounts').select('id, name').eq('client_id', clientId),
      ])

      const nomeConta = new Map((contas || []).map((a: any) => [a.id, a.name]))
      const porConta: Record<string, { nome: string; total: number; ultimaData: string; fontes: Record<string, number> }> = {}
      for (const t of (jaExiste || [])) {
        const key = (t as any).account_id || 'sem_conta'
        const nome = nomeConta.get((t as any).account_id) || 'Sem conta definida'
        porConta[key] = porConta[key] || { nome, total: 0, ultimaData: '', fontes: {} }
        porConta[key].total++
        const f = (t as any).source || 'outro'
        porConta[key].fontes[f] = (porConta[key].fontes[f] || 0) + 1
        if ((t as any).tx_date > porConta[key].ultimaData) porConta[key].ultimaData = (t as any).tx_date
      }

      return NextResponse.json({
        ok: true, preview: true, resumo, amostra: parsed.slice(0, 6),
        existentes: {
          total: (jaExiste || []).length,
          contas: Object.entries(porConta).map(([id, v]) => ({ accountId: id, ...v })),
        },
      })
    }

    // ── Importação ──
    if (emJanela.length === 0) {
      return NextResponse.json({
        error: `O período escolhido (${from || 'início'} a ${to || 'fim'}) não inclui nenhum lançamento deste arquivo, que vai de ${resumo.de} a ${resumo.ate}. Ajuste ou limpe as datas.`,
      }, { status: 422 })
    }

    const db = serviceDb()
    let contaId = accountId
    if (!contaId && accountName) {
      const { data: acc } = await db.from('bank_accounts').upsert(
        { client_id: clientId, name: accountName, account_hint: accountName, type: 'checking' },
        { onConflict: 'client_id,name' }
      ).select('id').single()
      contaId = acc?.id ?? null
    }

    const registros = emJanela.map(p => ({
      account_id: contaId,
      client_id: clientId,
      source: 'csv',
      account_hint: accountName || null,
      tx_date: p.date,
      description: p.description,
      amount: p.amount,
      balance: p.balance,
      status: 'pending',
    }))

    let inseridas = 0
    for (let i = 0; i < registros.length; i += 500) {
      const { data, error } = await db
        .from('bank_transactions')
        .upsert(registros.slice(i, i + 500), {
          onConflict: 'client_id,tx_date,description,amount',
          ignoreDuplicates: true,
        })
        .select('id')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      inseridas += data?.length ?? 0
    }

    const ruled = inseridas > 0 ? await applyRulesToClient(db, clientId).catch(() => 0) : 0

    return NextResponse.json({
      ok: true,
      resumo,
      inseridas,
      duplicadas: emJanela.length - inseridas,
      foraDoPeriodo: parsed.length - emJanela.length,
      ruled,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
