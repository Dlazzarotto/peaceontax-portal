// lib/quickbooks-import.ts — leitura dos relatórios exportados do QuickBooks Online.
//
// Formatos aceitos (Relatórios → Exportar para Excel/CSV):
//   • "Transaction List by Date"
//   • "Transaction Detail by Account"
// Os dois trazem as colunas Date, Transaction Type, Num, Name, Memo/Description,
// Account, Split, Amount (e às vezes Balance, Class, Posting). O arquivo vem com
// linhas de título antes do cabeçalho, seções por conta e linhas "Total for…",
// que são descartadas aqui. Sem dependência de servidor: é testável sozinho.

export type LinhaQB = {
  date: string            // YYYY-MM-DD
  type: string            // Deposit, Expense, Check, Transfer, Bill Payment…
  num: string
  name: string            // fornecedor/cliente (payee)
  memo: string
  account: string         // conta bancária/cartão no QuickBooks
  split: string           // categoria (conta contábil) — "-Split-" quando há várias
  amount: number          // sinal do QuickBooks: + entra na conta, − sai
  balance: number | null
}

export type ResultadoLeitura = {
  linhas: LinhaQB[]
  colunas: Record<string, number>
  ignoradas: string[]     // trechos das linhas descartadas (para conferência)
  formato: 'lista' | 'detalhe' | 'desconhecido'
}

const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** CSV com aspas, vírgulas dentro do campo e \r\n. Aceita também TSV (Excel "salvar como texto"). */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '')
  const sep = clean.split('\n')[0]?.includes('\t') ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = [], field = '', inQuotes = false
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]
    if (inQuotes) {
      if (c === '"') { if (clean[i + 1] === '"') { field += '"'; i++ } else inQuotes = false }
      else field += c
    } else if (c === '"') inQuotes = true
    else if (c === sep) { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

/** "1,234.56" · "(123.45)" · "-1,234.56" · "$ 12" → número; vazio → null */
export function toNumber(v: string): number | null {
  if (v == null) return null
  let s = String(v).trim().replace(/[$\s]/g, '')
  if (!s) return null
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  if (s.startsWith('-')) { neg = true; s = s.slice(1) }
  if (/,\d{2}$/.test(s) && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.')
  else s = s.replace(/,/g, '')
  const n = Number(s)
  if (!isFinite(n)) return null
  return neg ? -n : n
}

/** MM/DD/YYYY · YYYY-MM-DD · M/D/YY → YYYY-MM-DD; qualquer outra coisa → null */
export function toDate(v: string): string | null {
  const s = (v || '').trim()
  if (!s) return null
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/)
  if (m) {
    const mm = m[1].padStart(2, '0'), dd = m[2].padStart(2, '0')
    let yy = m[3]
    if (yy.length === 2) yy = Number(yy) > 60 ? `19${yy}` : `20${yy}`
    return `${yy}-${mm}-${dd}`
  }
  return null
}

/** Cabeçalho do relatório: a linha que tem "Date" e "Amount". */
function acharCabecalho(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = rows[i].map(norm)
    if (cells.some(c => c === 'date' || c === 'transactiondate') && cells.some(c => c === 'amount')) return i
  }
  return -1
}

/** Nome da categoria como o sistema grava: "Pai: Filho" (um espaço após os dois-pontos). */
export function normalizarCategoriaQB(s: string): string {
  return (s || '').trim().replace(/\s*:\s*/g, ': ').replace(/\s+/g, ' ')
}

export function lerRelatorioQuickBooks(text: string): ResultadoLeitura {
  const rows = parseCsv(text).filter(r => r.some(c => c.trim() !== ''))
  const h = acharCabecalho(rows)
  if (h < 0) return { linhas: [], colunas: {}, ignoradas: [], formato: 'desconhecido' }

  const header = rows[h]
  const idx = (...names: string[]) => header.findIndex(c => names.includes(norm(c)))
  const col = {
    date:    idx('date', 'transactiondate'),
    type:    idx('transactiontype', 'type'),
    num:     idx('num', 'no', 'number', 'refno'),
    name:    idx('name', 'payee', 'vendor', 'customer'),
    memo:    idx('memodescription', 'memo', 'description'),
    account: idx('account', 'accountname', 'accountfullname'),
    split:   idx('split', 'category'),
    amount:  idx('amount'),
    balance: idx('balance', 'runningbalance'),
  }
  const colunas: Record<string, number> = {}
  for (const [k, v] of Object.entries(col)) if (v >= 0) colunas[k] = v

  const linhas: LinhaQB[] = []
  const ignoradas: string[] = []
  let secao = ''          // "Transaction Detail by Account": nome da conta da seção corrente
  let temSecao = false

  for (const r of rows.slice(h + 1)) {
    const cell = (i: number) => (i >= 0 && i < r.length ? (r[i] || '').trim() : '')
    const primeira = (r[0] || '').trim()
    const preenchidas = r.filter(c => c.trim() !== '').length

    // Linha de total/subtotal do relatório
    if (/^total\b/i.test(primeira) || r.some(c => /^total for\b/i.test(c.trim()))) continue

    const data = toDate(cell(col.date))
    if (!data) {
      // Só a primeira célula preenchida e sem data: é o cabeçalho de uma seção (nome da conta)
      if (preenchidas === 1 && primeira && !/^\d/.test(primeira)) { secao = primeira; temSecao = true; continue }
      // Linha de data vazia mas com valor: continuação de seção sem conta — ignora com registro
      if (preenchidas > 1) ignoradas.push(r.join(' | ').slice(0, 60))
      continue
    }

    const amount = toNumber(cell(col.amount))
    if (amount == null) { ignoradas.push(r.join(' | ').slice(0, 60)); continue }

    const account = cell(col.account) || secao
    linhas.push({
      date: data,
      type: cell(col.type),
      num: cell(col.num).replace(/^0+(\d)/, '$1'),
      name: cell(col.name),
      memo: cell(col.memo),
      account,
      split: normalizarCategoriaQB(cell(col.split)),
      amount: Math.round(amount * 100) / 100,
      balance: col.balance >= 0 ? toNumber(cell(col.balance)) : null,
    })
  }

  return { linhas, colunas, ignoradas, formato: temSecao ? 'detalhe' : 'lista' }
}

/** Descrição como o livro guarda: "Nome — Memo (Check #123)"; nunca vazia. */
export function descricaoDaLinha(l: LinhaQB): string {
  const partes = [l.name, l.memo].map(s => (s || '').trim()).filter(Boolean)
  // Memo repetindo o nome não acrescenta nada
  const unicas = partes.filter((p, i) => i === 0 || p.toLowerCase() !== partes[0].toLowerCase())
  let d = unicas.join(' — ') || l.type || 'Lançamento'
  if (l.num && /^check$/i.test(l.type)) d += ` (Check #${l.num})`
  return d.slice(0, 500)
}

/** Split que não é categoria: várias linhas ("-Split-") ou vazio. */
export function splitIndefinido(split: string): boolean {
  const s = (split || '').trim().toLowerCase()
  return !s || s === '-split-' || s === 'split' || s === '--split--'
}
