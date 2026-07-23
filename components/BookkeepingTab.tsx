'use client'
// BookkeepingTab — Fase 5.1
// Extrai transações dos extratos PDF (contas fechadas) e lista com resumo.
// Categorização automática (regras + IA) chega no módulo 5.2.

import { useState, useEffect } from 'react'

interface Tx {
  id: string; tx_date: string; description: string; amount: number
  balance: number|null; category: string|null; status: string
  category_confidence: number|null; categorized_by: string|null; payee: string|null
  account_hint: string|null; statement_document_id: string|null; fiscal_year: number
}
interface Doc { id: string; file_name: string; category: string; tax_year: number }

interface Props { clientId: string; clientName: string }

const STATUS_LABEL: Record<string,string> = {
  pending:'⏳ Em aberto', auto:'🤖 Auto', reviewed:'✅ Revisada', excluded:'🚫 Excluída',
}

export default function BookkeepingTab({ clientId }: Props) {
  const [txs, setTxs] = useState<Tx[]>([])
  const [summary, setSummary] = useState<any>(null)
  const [statements, setStatements] = useState<Doc[]>([])
  const [loading, setLoading] = useState(true)
  const [extracting, setExtracting] = useState<string|null>(null)
  const [msg, setMsg] = useState('')
  const [year, setYear] = useState<number | 'all'>(new Date().getFullYear())
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [accounts, setAccounts] = useState<any[]>([])
  const [plaidItems, setPlaidItems] = useState<any[]>([])
  const [plaidBusy, setPlaidBusy] = useState(false)
  const [accountFilter, setAccountFilter] = useState<string>('all')
  const [view, setView] = useState<'banking'|'register'|'statements'|'payees'|'rules'|'reports'>('banking')
  const [tab, setTab] = useState<'recognized'|'unrecognized'|'excluded'>('recognized')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sortField, setSortField] = useState<'tx_date'|'description'|'amount'>('tx_date')
  const [sortDir, setSortDir] = useState<'asc'|'desc'>('desc')

  const toggleSort = (f: 'tx_date'|'description'|'amount') => {
    if (sortField === f) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(f); setSortDir(f === 'description' ? 'asc' : 'desc') }
  }
  const [categorizing, setCategorizing] = useState(false)
  const [categories, setCategories] = useState<{name:string; kind:string}[]>([])
  const [newCatOpen, setNewCatOpen] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [newCatKind, setNewCatKind] = useState('expense')
  const [newCatParent, setNewCatParent] = useState('')
  const [newCatIsSub, setNewCatIsSub] = useState(false)

  // Painel de regras (estilo QuickBooks)
  const [rules, setRules] = useState<any[]>([])
  const [rName, setRName] = useState('')
  const [rDirection, setRDirection] = useState('out')
  const [rPattern, setRPattern] = useState('')
  const [rMatchType, setRMatchType] = useState('contains')
  const [rAmountOp, setRAmountOp] = useState('')
  const [rAmountVal, setRAmountVal] = useState('')
  const [rPayee, setRPayee] = useState('')
  const [rCategory, setRCategory] = useState('')
  const [rScope, setRScope] = useState('client')
  const [editRuleId, setEditRuleId] = useState<string|null>(null)
  const [rPayeeType, setRPayeeType] = useState('vendor')
  const [payeeRegistry, setPayeeRegistry] = useState<{name:string; type:string}[]>([])

  // Modal QuickBooks: aplicar só ao lançamento ou criar regra
  const [catDecision, setCatDecision] = useState<{ tx: Tx; category: string }|null>(null)
  const [mPattern, setMPattern] = useState('')
  const [mPayee, setMPayee] = useState('')
  const [mPayeeType, setMPayeeType] = useState('vendor')
  const [mScope, setMScope] = useState('client')
  const [mErr, setMErr] = useState('')
  const [pnlYear, setPnlYear] = useState(new Date().getFullYear() - 1)
  const [pnlMonth, setPnlMonth] = useState<string>('all')
  const [ovData, setOvData] = useState<any>(null)
  const [ovBusy, setOvBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    const params = new URLSearchParams({ clientId })
    if (year !== 'all') params.set('year', String(year))
    if (accountFilter !== 'all') params.set('accountId', accountFilter)

    const [t, d] = await Promise.all([
      fetch(`/api/bookkeeping/transactions?${params}`).then(r => r.json()),
      fetch(`/api/clients/${clientId}`).then(r => r.json()).catch(() => ({ documents: [] })),
    ])
    setTxs(t.transactions || [])
    setSummary(t.summary || null)
    setAccounts(t.accounts || [])
    setSelected(new Set())
    setStatements((d.documents || []).filter((x: Doc) =>
      (x.category || '').toLowerCase().includes('bank')))
    setLoading(false)
  }
  useEffect(() => { load() }, [clientId, year, accountFilter])
  useEffect(() => {
    fetch(`/api/plaid/items?clientId=${clientId}`).then(r => r.json())
      .then(d => setPlaidItems(d.items || [])).catch(() => null)
  }, [clientId])

  const syncPlaid = async () => {
    setPlaidBusy(true); setMsg('')
    try {
      const r = await fetch('/api/plaid/sync', {
        method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ clientId }),
      }).then(x => x.json())
      setMsg(r.ok ? `✓ Plaid: ${r.added} novas transações (${(r.details||[]).join(' · ')})` : `Erro: ${r.error}`)
      if (r.ok) load()
    } catch (e) { setMsg(`Erro: ${(e as Error).message}`) }
    setPlaidBusy(false)
  }

  useEffect(() => {
    fetch('/api/bookkeeping/categories').then(r => r.json())
      .then(d => setCategories(d.categories || []))
      .catch(() => null)
  }, [])

  const GROUP_LABEL: Record<string,string> = {
    income:'💰 Income', cogs:'📦 Cost of Goods', expense:'💸 Expenses',
    other_income:'➕ Other Income', other_expense:'➖ Other Expenses',
    liability:'🏦 Liability', asset:'🏗️ Assets', non_pnl:'👤 Sócio / Fora do P&L',
  }
  const GROUP_ORDER = ['income','cogs','expense','other_income','other_expense','liability','asset','non_pnl']

  const createCategory = async () => {
    if (newCatName.trim().length < 2) { setMsg('Nome da categoria muito curto.'); return }
    if (newCatIsSub && !newCatParent) { setMsg('Escolha a conta mãe da sub-account.'); return }
    const r = await fetch('/api/bookkeeping/categories', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ name: newCatName.trim(), kind: newCatKind, parent: newCatParent || undefined }),
    })
    const d = await r.json()
    if (d.ok) {
      const fullName = newCatParent ? `${newCatParent}: ${newCatName.trim()}` : newCatName.trim()
      setMsg(`✓ Categoria "${fullName}" criada.`)
      setCategories(c => [...c, { name: fullName, kind: newCatKind }])
      setNewCatOpen(false); setNewCatName(''); setNewCatParent(''); setNewCatIsSub(false)
    } else setMsg(`Erro: ${d.error}`)
  }

  // Auto-extração: processa extratos pendentes ao abrir a aba (um por vez)

  const extract = async (documentId: string, fileName: string) => {
    if (plaidItems.length > 0 && !confirm(
      `Importar as transações de "${fileName}"?\n\n⚠️ Este cliente tem banco conectado via Plaid. Importe este PDF somente se ele cobre um PERÍODO que o Plaid não trouxe (ex.: meses antigos) — senão as transações duplicam.\n\nO PDF continua arquivado para verificação de qualquer forma.`
    )) return
    setExtracting(documentId); setMsg('')
    const r = await fetch('/api/bookkeeping/extract', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ documentId }),
    })
    const d = await r.json()
    if (d.ok) setMsg(`✓ ${fileName}: ${d.inserted} transações extraídas${d.duplicates > 0 ? ` (${d.duplicates} duplicadas ignoradas)` : ''}${d.accountHint ? ` — ${d.accountHint}` : ''}`)
    else setMsg(`${fileName}: ${d.error}`)
    setExtracting(null); load()
  }

  const categorize = async (mode: 'rules' | 'ai' = 'rules') => {
    setCategorizing(true); setMsg('')
    const r = await fetch('/api/bookkeeping/categorize', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ clientId, year: year === 'all' ? undefined : year, mode }),
    })
    const d = await r.json()
    if (d.ok) setMsg(mode === 'ai'
      ? `✓ ${d.ruled} por regra · ${d.ai} sugeridas pela IA (≥95%) · ${d.review} sem sugestão`
      : `✓ ${d.ruled} lançamento(s) reconhecido(s) por regra · ${(d.review ?? 0) + (d.ai ?? 0)} sem regra (para sua decisão)`)
    else setMsg(`Erro: ${d.error}`)
    setCategorizing(false); load()
  }

  const loadPayees = async () => {
    const r = await fetch(`/api/bookkeeping/payees?clientId=${clientId}`).then(x => x.json())
    setPayeeRegistry(r.payees || [])
  }

  const loadRules = async () => {
    const r = await fetch(`/api/bookkeeping/rules?clientId=${clientId}`).then(x => x.json())
    setRules(r.rules || [])
  }

  const createRule = async () => {
    if (!rName.trim() || !rCategory) { setMsg('Regra precisa de nome e categoria.'); return }
    if (!rPattern.trim() && !rAmountOp) { setMsg('Defina ao menos uma condição (descrição ou valor).'); return }
    if (!rPayee.trim()) { setMsg('⚠️ Payee é obrigatório — informe o favorecido (Vendor/Customer) da regra.'); return }

    // Duplicata: mesmo texto (variações) e direção compatível
    if (!editRuleId && rPattern.trim()) {
      const norm = (x: string) => x.split('|').map(v => v.trim().toLowerCase()).filter(Boolean).sort().join('|')
      const dup = rules.find(r =>
        (r.direction === rDirection || r.direction === 'both' || rDirection === 'both') &&
        norm(r.pattern || '') === norm(rPattern))
      if (dup) {
        setMsg(`⚠️ Já existe uma regra com este texto: "${dup.name || dup.pattern}". Use ✏️ Editar nela em vez de criar outra.`)
        return
      }
    }

    const payload: any = {
      clientId, scope: rScope, name: rName.trim(), direction: rDirection,
      pattern: rPattern.trim(), matchType: rMatchType,
      amountOp: rAmountOp || '', amountValue: rAmountVal ? Number(rAmountVal) : undefined,
      payee: rPayee.trim(), category: rCategory,
    }
    if (editRuleId) payload.id = editRuleId
    const r = await fetch('/api/bookkeeping/rules', {
      method: editRuleId ? 'PATCH' : 'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify(payload),
    }).then(x => x.json())
    if (r.ok) {
      if (rPayee.trim()) {
        await fetch('/api/bookkeeping/payees', {
          method:'POST', headers:{'content-type':'application/json'},
          body: JSON.stringify({ clientId, name: rPayee.trim(), type: rPayeeType }),
        })
      }
      setMsg(`✓ Regra "${rName.trim()}" ${editRuleId ? 'atualizada' : 'gravada'} e aplicada a ${r.applied ?? 0} transações.`)
      setView('banking')
      setRName(''); setRPattern(''); setRAmountOp(''); setRAmountVal(''); setRPayee(''); setEditRuleId(null)
      loadRules(); loadPayees(); load()
    } else setMsg(`Erro: ${r.error}`)
  }

  const deleteRule = async (id: string) => {
    await fetch(`/api/bookkeeping/rules?id=${id}`, { method:'DELETE' })
    loadRules()
  }

  const bulkAction = async (ids: string[], action: 'approve'|'unmatch'|'exclude'|'restore') => {
    if (ids.length === 0) return
    const r = await fetch('/api/bookkeeping/transactions', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ ids, action }),
    }).then(x => x.json())
    if (r.ok) {
      const verb = action === 'approve' ? 'aprovadas → registro' : action === 'exclude' ? 'excluídas' : action === 'unmatch' ? 'devolvidas para revisão' : 'restauradas'
      setMsg(`✓ ${r.affected} transação(ões) ${verb}.`)
    } else setMsg(`Erro: ${r.error}`)
    load()
  }

  const toggleSel = (id: string) => setSelected(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n
  })

  const suggestPattern = (desc: string) => desc
    .replace(/\d{2}\/\d{2}/g, '').replace(/#?\d{4,}/g, '').replace(/x{4,}/gi, '')
    .replace(/\s+/g, ' ').trim().toLowerCase().split(' ').slice(0, 3).join(' ')

  const setTxPayee = async (id: string, payee: string) => {
    await fetch('/api/bookkeeping/transactions', {
      method:'PATCH', headers:{'content-type':'application/json'},
      body: JSON.stringify({ id, payee }),
    })
  }

  const setTxCategory = (tx: Tx, category: string) => {
    setCatDecision({ tx, category }); setMErr('')
    setMPattern(suggestPattern(tx.description))
    setMPayee(tx.payee || '')
    setMPayeeType(Number(tx.amount) > 0 ? 'customer' : 'vendor')
    setMScope('client')
  }

  const applyOnlyThis = async () => {
    if (!catDecision) return
    await fetch('/api/bookkeeping/transactions', {
      method:'PATCH', headers:{'content-type':'application/json'},
      body: JSON.stringify({ id: catDecision.tx.id, category: catDecision.category, payee: mPayee || undefined }),
    })
    setMsg('✓ Categorizada — somente este lançamento.')
    setCatDecision(null); load()
  }

  const applyAsRule = async () => {
    if (!catDecision) return
    setMErr('')
    if (!mPattern.trim()) { setMErr('Defina o texto da regra.'); return }
    if (!mPayee.trim()) { setMErr('Payee é obrigatório para criar a regra — informe o favorecido.'); return }

    // 1. Cria a regra (aplicação retroativa a pendentes + reconhecidas)
    const r = await fetch('/api/bookkeeping/rules', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({
        clientId, scope: mScope,
        name: mPattern.trim().slice(0, 40),
        direction: Number(catDecision.tx.amount) > 0 ? 'in' : 'out',
        pattern: mPattern.trim(), matchType: 'contains',
        payee: mPayee.trim(),
        category: catDecision.category,
      }),
    }).then(x => x.json())

    if (!r.ok) {
      setMErr(`Não foi possível criar a regra: ${r.error}`)   // fica no modal, visível
      return
    }

    // 2. Este lançamento: revisado com a categoria + payee
    await fetch('/api/bookkeeping/transactions', {
      method:'PATCH', headers:{'content-type':'application/json'},
      body: JSON.stringify({ id: catDecision.tx.id, category: catDecision.category, payee: mPayee.trim() }),
    })
    // 3. Payee no cadastro com o tipo escolhido
    await fetch('/api/bookkeeping/payees', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ clientId, name: mPayee.trim(), type: mPayeeType }),
    })

    setMsg(`✓ Regra criada e aplicada a ${(r.applied ?? 0) + 1} lançamento(s) com a mesma informação.`)
    setCatDecision(null); setMErr(''); load(); loadRules()
  }

  const openPnl = () => {
    const params = new URLSearchParams({ clientId, year: String(pnlYear) })
    if (pnlMonth !== 'all') params.set('month', pnlMonth)
    window.open(`/api/bookkeeping/pnl?${params}`, '_blank')
  }

  const loadCounter = async () => {
    setOvBusy(true)
    const r = await fetch(`/api/bookkeeping/overage?clientId=${clientId}&year=${pnlYear}`)
    const d = await r.json()
    if (!d.error) setOvData(d)
    setOvBusy(false)
  }
  useEffect(() => { loadCounter() }, [clientId, pnlYear])

  const chargeOverage = async () => {
    setOvBusy(true); setMsg('')
    const r = await fetch('/api/bookkeeping/overage', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ clientId, year: pnlYear }),
    })
    const d = await r.json()
    setMsg(d.ok ? `✓ ${d.message}` : `Erro: ${d.error}`)
    setOvBusy(false); loadCounter()
  }

  const TAB_FILTER: Record<string, (t: Tx) => boolean> = {
    recognized:   t => t.status === 'auto',
    unrecognized: t => t.status === 'pending',
    register:     t => t.status === 'approved' || t.status === 'reviewed',
    excluded:     t => t.status === 'excluded',
  }
  const tabTxs = txs.filter(view === 'register' ? TAB_FILTER.register : TAB_FILTER[tab])
    .sort((a, b) => {
      let cmp = 0
      if (sortField === 'tx_date') cmp = String(a.tx_date).localeCompare(String(b.tx_date))
      else if (sortField === 'description') cmp = String(a.description).localeCompare(String(b.description), undefined, { sensitivity: 'base' })
      else cmp = Number(a.amount) - Number(b.amount)
      return sortDir === 'asc' ? cmp : -cmp
    })
  const counts = {
    recognized: txs.filter(TAB_FILTER.recognized).length,
    unrecognized: txs.filter(TAB_FILTER.unrecognized).length,
    register: txs.filter(TAB_FILTER.register).length,
    excluded: txs.filter(TAB_FILTER.excluded).length,
  }

  const extractedDocIds = new Set(txs.map(t => t.statement_document_id).filter(Boolean))
  const years = (Array.from(new Set(txs.map(t => t.fiscal_year))) as number[]).sort((a,b) => b-a)
  const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`

  const card = { background:'#fff', borderRadius:14, padding:18, border:'1px solid #e2e8f4', marginBottom:14 }
  const btn = (bg: string, disabled = false) => ({
    padding:'7px 14px', background: disabled ? '#e2e8f4' : bg,
    color: disabled ? '#9aaab0' : '#fff', border:'none', borderRadius:8,
    fontSize:12.5, fontWeight:700, cursor: disabled ? 'not-allowed' : 'pointer',
  })
  const sel = { padding:'7px 11px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, fontWeight:700, color:'#0f2340', outline:'none', cursor:'pointer' }

  const MENU: [typeof view, string][] = [
    ['banking', '🏦 Banking'],
    ['register', '📖 Registro'],
    ['statements', '📄 Extratos'],
    ['payees', '🏪 Payees'],
    ['rules', '⚙️ Regras'],
    ['reports', '📑 Relatórios'],
  ]

  return (
    <div>
      {/* Menu por tema (estilo QuickBooks Desktop) */}
      <div style={{ display:'flex', gap:4, marginBottom:16, background:'#fff', borderRadius:12, padding:6, border:'1px solid #e2e8f4', flexWrap:'wrap' }}>
        {MENU.map(([k, label]) => (
          <button key={k} onClick={() => { setView(k); if (k === 'rules' || k === 'payees') { loadRules(); loadPayees() } }}
            style={{ padding:'10px 16px', background: view === k ? '#2D3278' : 'transparent',
              color: view === k ? '#fff' : '#4a5a70', border:'none', borderRadius:9,
              fontSize:13.5, fontWeight:700, cursor:'pointer' }}>
            {label}
          </button>
        ))}
        <select value={year} onChange={e => setYear(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          style={{ marginLeft:'auto', padding:'7px 11px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, fontWeight:700, color:'#0f2340', outline:'none', cursor:'pointer' }}>
          <option value="all">Todos os anos</option>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {view === 'statements' && (<>
      {/* Extratos disponíveis */}
      <div style={card}>
        <h3 style={{ fontFamily:'Georgia,serif', fontSize:15, color:'#0f2340', margin:'0 0 4px' }}>
          📄 Extratos bancários (PDF)
        </h3>
        <p style={{ fontSize:12.5, color:'#6a7a9a', margin:'0 0 12px' }}>
          Os PDFs ficam sempre arquivados como <b>documentos de verificação</b> (cheques, descrições incompletas,
          reconciliação). Use <b>⬇️ Importar</b> apenas nos extratos de períodos que o Plaid não cobre.
        </p>
        {statements.filter(st => year === 'all' || String(st.tax_year) === String(year)).length === 0 ? (
          <p style={{ fontSize:13, color:'#9aaab0' }}>Nenhum extrato de {year === 'all' ? 'nenhum ano' : year}. PDFs de outros anos aparecem ao trocar o ano no seletor.</p>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {statements.filter(st => year === 'all' || String(st.tax_year) === String(year)).map(s => (
              <div key={s.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', background:'#f8faff', borderRadius:9, flexWrap:'wrap' }}>
                <span style={{ fontSize:13, fontWeight:600, color:'#1a2a3a', flex:1, minWidth:180 }}>📄 {s.file_name}</span>
                <span style={{ fontSize:11, color:'#6a7a9a' }}>{s.tax_year}</span>
                <span style={{ fontSize:11.5, color:'#8a9ab0' }}>📎 verificação</span>
                {extractedDocIds.has(s.id) ? (
                  <span style={{ fontSize:12, color:'#1a6b4a', fontWeight:700 }}>✓ Importado</span>
                ) : (
                  <button onClick={() => extract(s.id, s.file_name)} disabled={!!extracting}
                    style={btn('#2D3278', !!extracting)}>
                    {extracting === s.id ? '🤖 Lendo o PDF…' : '⬇️ Importar transações'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {msg && (
          <p style={{ fontSize:13, fontWeight:600, marginTop:10,
            color: msg.startsWith('✓') ? '#1a6b4a' : '#b02020' }}>{msg}</p>
        )}
      </div>

      </>)}

      {view === 'banking' && (<>
      {/* Resumo */}
      {summary && summary.total > 0 && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:10, marginBottom:14 }}>
          {[
            ['Transações', String(summary.total), '#2D3278'],
            ['Em aberto', String(summary.pending), summary.pending > 0 ? '#c06010' : '#1a6b4a'],
            ['Entradas', money(summary.credits), '#1a6b4a'],
            ['Saídas', money(summary.debits), '#b02020'],
          ].map(([label, value, color]) => (
            <div key={label} style={{ background:'#fff', borderRadius:12, padding:'12px 16px', border:'1px solid #e2e8f4' }}>
              <div style={{ fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const }}>{label}</div>
              <div style={{ fontSize:20, fontWeight:800, color: color as string, marginTop:2 }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Contas bancárias (estilo QuickBooks) */}
      {accounts.length > 0 && (
        <div style={{ display:'flex', gap:12, marginBottom:14, flexWrap:'wrap' }}>
          <div onClick={() => setAccountFilter('all')}
            style={{ cursor:'pointer', background: accountFilter==='all' ? '#2D3278' : '#fff', color: accountFilter==='all' ? '#fff' : '#0f2340',
              borderRadius:12, padding:'12px 16px', border:'1.5px solid #2D3278', minWidth:140 }}>
            <div style={{ fontSize:13, fontWeight:800 }}>Todas as contas</div>
            <div style={{ fontSize:11, opacity:0.8, marginTop:2 }}>{txs.length} transações</div>
          </div>
          {accounts.map(a => (
            <div key={a.id} onClick={() => setAccountFilter(a.id)}
              style={{ cursor:'pointer', background: accountFilter===a.id ? '#2D3278' : '#fff', color: accountFilter===a.id ? '#fff' : '#0f2340',
                borderRadius:12, padding:'12px 16px', border:'1.5px solid #e2e8f4', minWidth:190 }}>
              <div style={{ fontSize:12.5, fontWeight:800 }}>{a.type === 'credit_card' ? '💳' : '🏦'} {a.name}</div>
              <div style={{ fontSize:11, opacity:0.85, marginTop:4, lineHeight:1.6 }}>
                {a.lastBalance != null && <>{a.type === 'credit_card' ? 'Saldo devedor' : 'Saldo'} (último extrato): <b>${Number(a.lastBalance).toFixed(2)}</b><br/></>}
                Para revisar: <b style={{ color: accountFilter===a.id ? '#ffd9b0' : '#c06010' }}>{a.forReview}</b> · No registro: <b>{a.inRegister}</b>
              </div>
            </div>
          ))}
        </div>
      )}

      </>)}

      {view === 'reports' && (<>
      {/* P&L + Excedente */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(300px, 1fr))', gap:12, marginBottom:14 }}>
        <div style={{ background:'#fff', borderRadius:12, padding:'14px 16px', border:'1px solid #e2e8f4' }}>
          <div style={{ fontSize:13, fontWeight:700, color:'#0f2340', marginBottom:8 }}>📑 Relatórios</div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:8 }}>
            <select value={pnlYear} onChange={e => setPnlYear(Number(e.target.value))} style={sel}>
              {Array.from({length:7},(_,i)=>new Date().getFullYear()-i).map(y => <option key={y}>{y}</option>)}
            </select>
            <select value={pnlMonth} onChange={e => setPnlMonth(e.target.value)} style={sel}>
              <option value="all">Ano inteiro</option>
              {Array.from({length:12},(_,i)=>i+1).map(m => <option key={m} value={m}>{String(m).padStart(2,'0')}</option>)}
            </select>
          </div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            <button onClick={openPnl} style={btn('#2D3278')}>📈 P&L</button>
            <button onClick={() => window.open(`/api/bookkeeping/balance-sheet?clientId=${clientId}&year=${pnlYear}`, '_blank')}
              style={btn('#0a6a8a')}>🏦 Balance Sheet</button>
            <button onClick={() => window.open(`/api/bookkeeping/vendors?clientId=${clientId}&year=${pnlYear}&report=vendors`, '_blank')}
              style={btn('#5a1a8a')}>🏪 Fornecedores</button>
            <button onClick={() => window.open(`/api/bookkeeping/vendors?clientId=${clientId}&year=${pnlYear}&report=1099`, '_blank')}
              style={btn('#8a4a0a')}>📋 1099</button>
          </div>
        </div>
        <div style={{ background:'#fff', borderRadius:12, padding:'14px 16px', border:'1px solid #e2e8f4' }}>
          <div style={{ fontSize:13, fontWeight:700, color:'#0f2340', marginBottom:8 }}>
            🧮 Total de transações do ano — {pnlYear} (todos os bancos)
          </div>
          {!ovData ? (
            <span style={{ fontSize:12.5, color:'#9aaab0' }}>{ovBusy ? 'Contando…' : '—'}</span>
          ) : (
            <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'center' }}>
              <span style={{ fontSize:22, fontWeight:800, color:'#2D3278' }}>{ovData.total}</span>
              {ovData.included ? (
                <>
                  <span style={{ fontSize:12.5, fontWeight:600, color: ovData.overage > 0 ? '#c06010' : '#1a6b4a' }}>
                    lançamentos no ano
                    <span style={{ color:'#8a9ab0', fontWeight:400 }}> · contrato: {ovData.included}/ano
                    {ovData.overage > 0 ? ` (${ovData.overage} acima → $${Number(ovData.charge).toFixed(2)})` : ' ✓'}</span>
                  </span>
                  {ovData.overage > 0 && (
                    <button onClick={chargeOverage} disabled={ovBusy} style={btn('#F47B20', ovBusy)}>
                      💳 Cobrar excedente do ano (fatura dia 5)
                    </button>
                  )}
                </>
              ) : (
                <span style={{ fontSize:12, color:'#9aaab0' }}>transações no ano (sem contrato de bookkeeping ativo — só contagem)</span>
              )}
            </div>
          )}
        </div>
      </div>

      </>)}

      {/* Painel de regras */}
      {view === 'rules' && (
        <div style={{ background:'#fff', borderRadius:14, padding:20, border:'2px solid #1a6b4a', marginBottom:14 }}>
          <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
            <h3 style={{ fontFamily:'Georgia,serif', fontSize:15, color:'#0f2340', margin:'0 0 4px' }}>⚙️ Regras de categorização</h3>
            {rules.some(r => !r.payee || !String(r.payee).trim()) && (
              <button onClick={async () => {
                const n = rules.filter(r => !r.payee || !String(r.payee).trim()).length
                if (!confirm(`Excluir de uma vez as ${n} regra(s) sem payee? Elas serão removidas — as transações já processadas não mudam; recategorize com regras novas (com payee).`)) return
                const r2 = await fetch(`/api/bookkeeping/rules?mode=no_payee&clientId=${clientId}`, { method:'DELETE' }).then(x => x.json())
                setMsg(r2.ok ? `🧹 ${r2.deleted} regra(s) sem payee excluída(s).` : `Erro: ${r2.error}`)
                loadRules()
              }}
                style={{ marginLeft:'auto', padding:'7px 14px', background:'#fee2e2', color:'#b02020', border:'none', borderRadius:8, fontSize:12.5, fontWeight:700, cursor:'pointer' }}>
                🧹 Excluir todas sem payee ({rules.filter(r => !r.payee || !String(r.payee).trim()).length})
              </button>
            )}
          </div>
          <p style={{ fontSize:12, color:'#6a7a9a', margin:'0 0 14px' }}>
            Regras têm prioridade sobre a IA. Formato QuickBooks: nome + direção + condições (descrição e/ou valor) + payee + categoria.
          </p>

          {/* Form nova regra */}
          <div style={{ background:'#f8faff', borderRadius:10, padding:14, marginBottom:14 }}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:10, marginBottom:10 }}>
              <div>
                <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>Nome da regra *</label>
                <input value={rName} onChange={e => setRName(e.target.value)} placeholder="Ex.: Pagamentos Paulo"
                  style={{ width:'100%', padding:'7px 10px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }} />
              </div>
              <div>
                <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>Aplica a</label>
                <select value={rDirection} onChange={e => setRDirection(e.target.value)} style={{ ...sel, width:'100%' }}>
                  <option value="out">💸 Money Out (saídas)</option>
                  <option value="in">💰 Money In (entradas)</option>
                  <option value="both">↔️ Ambos</option>
                </select>
              </div>
              <div>
                <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>Escopo</label>
                <select value={rScope} onChange={e => setRScope(e.target.value)} style={{ ...sel, width:'100%' }}>
                  <option value="client">Só este cliente</option>
                  <option value="global">Todos os clientes</option>
                </select>
              </div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:10, marginBottom:10 }}>
              <div>
                <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>Se descrição…</label>
                <select value={rMatchType} onChange={e => setRMatchType(e.target.value)} style={{ ...sel, width:'100%' }}>
                  <option value="contains">contém</option>
                  <option value="starts_with">começa com</option>
                </select>
              </div>
              <div>
                <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>Texto — variações com | </label>
                <input value={rPattern} onChange={e => setRPattern(e.target.value)} placeholder="walmart | wal mart | wm"
                  style={{ width:'100%', padding:'7px 10px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }} />
                <div style={{ fontSize:10.5, color:'#9aaab0', marginTop:2 }}>Qualquer variação ativa a regra (OU)</div>
              </div>
              <div>
                <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>E valor… (opcional)</label>
                <select value={rAmountOp} onChange={e => setRAmountOp(e.target.value)} style={{ ...sel, width:'100%' }}>
                  <option value="">— sem condição —</option>
                  <option value="gt">maior que</option>
                  <option value="lt">menor que</option>
                  <option value="eq">igual a</option>
                </select>
              </div>
              <div>
                <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>Valor ($)</label>
                <input type="number" value={rAmountVal} onChange={e => setRAmountVal(e.target.value)} disabled={!rAmountOp}
                  style={{ width:'100%', padding:'7px 10px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none', background: rAmountOp ? '#fff' : '#f0f4fa' }} />
              </div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(170px, 1fr))', gap:10, marginBottom:12 }}>
              <div>
                <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>Então: Payee *</label>
                <input value={rPayee} onChange={e => setRPayee(e.target.value)} list="payee-list" placeholder="Escolher ou criar"
                  style={{ width:'100%', padding:'7px 10px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }} />
                <datalist id="payee-list">
                  {payeeRegistry.map(p2 => <option key={p2.name} value={p2.name}>{p2.type === 'customer' ? '💰 Customer' : '🏪 Vendor'}</option>)}
                  {Array.from(new Set(txs.map(t => t.payee).filter(Boolean)))
                    .filter(n => !payeeRegistry.some(p2 => p2.name === n))
                    .map(p2 => <option key={p2 as string} value={p2 as string} />)}
                </datalist>
              </div>
              <div>
                <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>Tipo do payee</label>
                <select value={rPayeeType} onChange={e => setRPayeeType(e.target.value)} style={{ ...sel, width:'100%' }}>
                  <option value="vendor">🏪 Vendor (fornecedor)</option>
                  <option value="customer">💰 Customer (cliente)</option>
                </select>
              </div>
              <div>
                <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>Categoria *</label>
                <select value={rCategory} onChange={e => setRCategory(e.target.value)} style={{ ...sel, width:'100%' }}>
                  <option value="">— escolher —</option>
                  {GROUP_ORDER.filter(g => categories.some(c => c.kind === g)).map(g => (
                    <optgroup key={g} label={GROUP_LABEL[g]}>
                      {categories.filter(c => c.kind === g)
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map(c =>
                        <option key={c.name} value={c.name}>{c.name.includes(':') ? `\u00A0\u00A0\u21B3 ${c.name.split(': ')[1]}` : c.name}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div style={{ display:'flex', alignItems:'flex-end', gap:8 }}>
                <button onClick={createRule} style={btn(editRuleId ? '#2D3278' : '#1a6b4a')}>
                  {editRuleId ? '💾 Salvar alterações' : '✓ Criar regra'}
                </button>
                {editRuleId && (
                  <button onClick={() => { setEditRuleId(null); setRName(''); setRPattern(''); setRAmountOp(''); setRAmountVal(''); setRPayee(''); setRCategory('') }}
                    style={{ padding:'9px 14px', background:'#fff', color:'#6a7a9a', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, fontWeight:700, cursor:'pointer' }}>
                    Cancelar edição
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Lista de regras */}
          <div style={{ display:'flex', flexDirection:'column', gap:6, maxHeight:260, overflow:'auto' }}>
            {rules.map(r => (
              <div key={r.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', background:'#f8faff', borderRadius:8, fontSize:12.5, flexWrap:'wrap' }}>
                <span style={{ fontWeight:700, color:'#0f2340' }}>{r.name || r.pattern}</span>
                <span style={{ color:'#6a7a9a' }}>
                  {r.direction === 'in' ? '💰 In' : r.direction === 'out' ? '💸 Out' : '↔️'}
                  {r.pattern && ` · "${r.pattern}"`}
                  {r.amount_op && ` · ${r.amount_op === 'gt' ? '>' : r.amount_op === 'lt' ? '<' : '='} $${Number(r.amount_value).toFixed(2)}`}
                  {r.payee && ` · → ${r.payee}`}
                  {` · ${r.category}`}
                </span>
                <span style={{ fontSize:10.5, padding:'1px 8px', borderRadius:12, background: r.client_id ? '#2D327815' : '#5a1a8a15', color: r.client_id ? '#2D3278' : '#5a1a8a', fontWeight:700 }}>
                  {r.client_id ? 'Cliente' : 'Global'}
                </span>
                <button onClick={() => {
                    setEditRuleId(r.id)
                    setRName(r.name || ''); setRDirection(r.direction || 'both')
                    setRPattern(r.pattern || ''); setRMatchType(r.match_type || 'contains')
                    setRAmountOp(r.amount_op || ''); setRAmountVal(r.amount_value != null ? String(r.amount_value) : '')
                    setRPayee(r.payee || ''); setRCategory(r.category || '')
                    setRScope(r.client_id ? 'client' : 'global')
                  }}
                  style={{ marginLeft:'auto', background:'none', border:'none', color:'#2D3278', cursor:'pointer', fontSize:13, fontWeight:700 }}>✏️ Editar</button>
                <button onClick={() => deleteRule(r.id)}
                  style={{ background:'none', border:'none', color:'#b02020', cursor:'pointer', fontSize:13, fontWeight:700 }}>✕</button>
              </div>
            ))}
            {rules.length === 0 && <p style={{ fontSize:12.5, color:'#9aaab0' }}>Nenhuma regra ainda.</p>}
          </div>
        </div>
      )}

      {/* Modal QuickBooks: só este lançamento ou regra */}
      {catDecision && (
        <div style={{ position:'fixed', inset:0, background:'rgba(15,35,64,0.5)', display:'flex',
          alignItems:'center', justifyContent:'center', zIndex:2000 }}>
          <div style={{ background:'#fff', borderRadius:16, padding:24, width:480, maxWidth:'94vw' }}>
            <h3 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:'0 0 4px' }}>
              Categorizar como "{catDecision.category}"
            </h3>
            <p style={{ fontSize:12, color:'#6a7a9a', margin:'0 0 14px' }}>
              {catDecision.tx.description.slice(0, 90)}
            </p>

            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:12 }}>
              <div>
                <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>Payee (Vendor/Customer) *</label>
                <input value={mPayee} onChange={e => setMPayee(e.target.value)} list="payee-list" placeholder="Opcional"
                  style={{ width:'100%', padding:'7px 10px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }} />
              </div>
              <div>
                <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>Tipo</label>
                <select value={mPayeeType} onChange={e => setMPayeeType(e.target.value)} style={{ ...sel, width:'100%' }}>
                  <option value="vendor">🏪 Vendor</option>
                  <option value="customer">💰 Customer</option>
                </select>
              </div>
            </div>

            <div style={{ background:'#f0f9f4', border:'1.5px solid #1a6b4a40', borderRadius:10, padding:12, marginBottom:14 }}>
              <div style={{ fontSize:12.5, fontWeight:700, color:'#1a6b4a', marginBottom:6 }}>
                📐 Se criar regra: aplica a TODOS cuja descrição contém… (variações com |)
              </div>
              <input value={mPattern} onChange={e => setMPattern(e.target.value)} placeholder="walmart | wal mart | wm"
                style={{ width:'100%', padding:'7px 10px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none', marginBottom:8 }} />
              <select value={mScope} onChange={e => setMScope(e.target.value)} style={{ ...sel, width:'100%' }}>
                <option value="client">Só este cliente</option>
                <option value="global">Todos os clientes</option>
              </select>
            </div>

            {mErr && (
              <p style={{ fontSize:13, fontWeight:700, color:'#b02020', background:'#fee2e2', borderRadius:8, padding:'9px 12px', margin:'0 0 12px' }}>
                ⚠️ {mErr}
              </p>
            )}
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end', flexWrap:'wrap' }}>
              <button onClick={() => setCatDecision(null)}
                style={{ padding:'9px 14px', background:'#fff', color:'#6a7a9a', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, fontWeight:700, cursor:'pointer' }}>
                Cancelar
              </button>
              <button onClick={applyOnlyThis} style={btn('#6a7a9a')}>
                Só este lançamento
              </button>
              <button onClick={applyAsRule} style={btn('#1a6b4a')}>
                📐 Criar regra (aplica a todos)
              </button>
            </div>
          </div>
        </div>
      )}

      {(view === 'banking' || view === 'register') && (<>
      {/* Filtros */}
      <div style={{ display:'flex', gap:10, marginBottom:12, flexWrap:'wrap' }}>
        <button onClick={() => categorize('rules')} disabled={categorizing} style={btn('#2D3278', categorizing)}>
          {categorizing ? 'Aplicando…' : '📐 Aplicar regras'}
        </button>
        <button onClick={() => { if (confirm('Pedir sugestões da IA para os lançamentos SEM regra? As sugestões ficam nas Reconhecidas aguardando sua aprovação — nada entra no registro sozinho.')) categorize('ai') }}
          disabled={categorizing} style={btn('#5a6a7a', categorizing)}>
          🤖 Sugerir com IA (opcional)
        </button>
        <button onClick={() => setNewCatOpen(o => !o)} style={btn('#6a7a9a')}>
          + Nova categoria
        </button>
        {plaidItems.length > 0 && (
          <button onClick={syncPlaid} disabled={plaidBusy} style={btn('#0a6a8a', plaidBusy)}>
            {plaidBusy ? 'Sincronizando…' : `🔄 Sincronizar Plaid (${plaidItems.length})`}
          </button>
        )}
        {newCatOpen && (
          <span style={{ display:'inline-flex', gap:6, alignItems:'center' }}>
            <input value={newCatName} onChange={e => setNewCatName(e.target.value)} placeholder="Nome da categoria"
              style={{ padding:'7px 11px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none', width:170 }} />
            <select value={newCatKind} onChange={e => setNewCatKind(e.target.value)} style={sel}>
              <option value="income">Income</option>
              <option value="cogs">Cost of Goods</option>
              <option value="expense">Expense</option>
              <option value="other_income">Other Income</option>
              <option value="other_expense">Other Expense</option>
              <option value="liability">Liability</option>
              <option value="asset">Asset</option>
              <option value="non_pnl">Fora do P&L</option>
            </select>
            <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:13, fontWeight:600, color:'#0f2340', cursor:'pointer', whiteSpace:'nowrap' as const }}>
              <input type="checkbox" checked={newCatIsSub}
                onChange={e => { setNewCatIsSub(e.target.checked); if (!e.target.checked) setNewCatParent('') }}
                style={{ width:17, height:17, cursor:'pointer' }} />
              Sub-account
            </label>
            {newCatIsSub && (
              <select value={newCatParent} onChange={e => setNewCatParent(e.target.value)} style={sel}>
                <option value="">— escolher a conta mãe —</option>
                {categories.filter(c => c.kind === newCatKind && !c.name.includes(':')).map(c =>
                  <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            )}
            <button onClick={createCategory} style={btn('#1a6b4a')}>✓ Criar</button>
          </span>
        )}
      </div>

      {/* Abas de revisão (Banking) / cabeçalho do Registro */}
      {view === 'register' && (
        <div style={{ padding:'12px 4px', fontSize:13.5, color:'#4a5a70' }}>
          📖 <b>Bank Register</b> — lançamentos aprovados nos livros ({counts.register}). Aqui você pode
          <b> editar categoria/payee</b> (vira "revisado"), <b>↩️ reabrir</b> para a revisão do Banking, ou <b>🚫 anular</b>.
        </div>
      )}
      {view === 'banking' && (
      <div style={{ display:'flex', gap:4, marginBottom:0, borderBottom:'2px solid #e2e8f4', flexWrap:'wrap' }}>
        {([
          ['recognized', `🔵 Reconhecidas (${counts.recognized})`],
          ['unrecognized', `🟠 Não reconhecidas (${counts.unrecognized})`],
          ['excluded', `🚫 Excluídas (${counts.excluded})`],
        ] as const).map(([k, label]) => (
          <button key={k} onClick={() => { setTab(k); setSelected(new Set()) }}
            style={{ padding:'10px 16px', background:'none', border:'none', cursor:'pointer',
              fontSize:13, fontWeight:700, color: tab===k ? '#2D3278' : '#8a9ab0',
              borderBottom: tab===k ? '3px solid #F47B20' : '3px solid transparent', marginBottom:-2 }}>
            {label}
          </button>
        ))}
      </div>
      )}

      {/* Ações em massa */}
      {selected.size > 0 && (
        <div style={{ display:'flex', gap:8, alignItems:'center', padding:'10px 14px', background:'#f0f4ff', borderRadius:'0 0 10px 10px', marginBottom:10, flexWrap:'wrap' }}>
          <span style={{ fontSize:13, fontWeight:700, color:'#2D3278' }}>{selected.size} selecionada(s):</span>
          {view === 'banking' && (tab === 'recognized' || tab === 'unrecognized') && (
            <button onClick={() => bulkAction(Array.from(selected), 'approve')} style={btn('#1a6b4a')}>✓ Aprovar → registro</button>
          )}
          {view === 'banking' && tab === 'recognized' && (
            <button onClick={() => bulkAction(Array.from(selected), 'unmatch')} style={btn('#c06010')}>↩️ Não aceitar</button>
          )}
          {view === 'register' && (
            <button onClick={() => bulkAction(Array.from(selected), 'reopen')} style={btn('#c06010')}>↩️ Reabrir p/ revisão</button>
          )}
          {(view === 'register' || tab !== 'excluded') && (
            <button onClick={() => bulkAction(Array.from(selected), 'exclude')} style={btn('#b02020')}>🚫 {view === 'register' ? 'Anular (void)' : 'Excluir'}</button>
          )}
          {view === 'banking' && tab === 'excluded' && (
            <button onClick={() => bulkAction(Array.from(selected), 'restore')} style={btn('#6a7a9a')}>♻️ Restaurar</button>
          )}
        </div>
      )}

      {/* Lista */}
      {loading ? <p style={{ color:'#6a7a9a', fontSize:13 }}>Carregando…</p> :
       tabTxs.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:14, padding:40, border:'1px solid #e2e8f4', textAlign:'center', color:'#9aaab0' }}>
          <div style={{ fontSize:32, marginBottom:8 }}>📊</div>
          <div style={{ fontSize:13 }}>Nada nesta aba.</div>
        </div>
      ) : (
        <div style={{ background:'#fff', borderRadius:14, border:'1px solid #e2e8f4', overflow:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', minWidth:760 }}>
            <thead><tr style={{ background:'#f8faff' }}>
              <th style={{ padding:'9px 8px', borderBottom:'1px solid #e2e8f4', width:34 }}>
                <input type="checkbox"
                  checked={tabTxs.length > 0 && tabTxs.every(t => selected.has(t.id))}
                  onChange={e => setSelected(e.target.checked ? new Set(tabTxs.map(t => t.id)) : new Set())}
                  style={{ width:17, height:17, cursor:'pointer' }} />
              </th>
              {([['Data','tx_date'],['Descrição','description'],['Payee',''],['Valor','amount'],['Categoria',''],['Ação','']] as const).map(([h, f]) =>
                <th key={h}
                  onClick={f ? () => toggleSort(f as any) : undefined}
                  style={{ padding:'9px 14px', textAlign:'left', fontSize:11, fontWeight:700,
                    color: f && sortField === f ? '#2D3278' : '#6a7a9a',
                    textTransform:'uppercase' as const, borderBottom:'1px solid #e2e8f4',
                    cursor: f ? 'pointer' : 'default', userSelect:'none' as const, whiteSpace:'nowrap' as const }}>
                  {h}{f && sortField === f ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>)}
            </tr></thead>
            <tbody>
              {tabTxs.map(t => (
                <tr key={t.id} style={{ borderBottom:'1px solid #f0f4fa', background: selected.has(t.id) ? '#f0f4ff' : undefined }}>
                  <td style={{ padding:'8px 8px' }}>
                    <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleSel(t.id)}
                      style={{ width:17, height:17, cursor:'pointer' }} />
                  </td>
                  <td style={{ padding:'8px 14px', fontSize:12.5, color:'#3a4a5a', whiteSpace:'nowrap' as const }}>
                    {new Date(t.tx_date + 'T12:00:00Z').toLocaleDateString('pt-BR')}
                  </td>
                  <td style={{ padding:'8px 14px', fontSize:12.5, color:'#1a2a3a', maxWidth:320 }}>
                    {t.description}
                    {t.account_hint && <div style={{ fontSize:10.5, color:'#9aaab0' }}>{t.account_hint}</div>}
                  </td>
                  <td style={{ padding:'8px 10px' }}>
                    <input defaultValue={t.payee || ''} placeholder="—"
                      onBlur={e => { if (e.target.value !== (t.payee || '')) setTxPayee(t.id, e.target.value) }}
                      style={{ width:120, padding:'4px 8px', border:'1.5px solid #e2e8f4', borderRadius:7,
                        fontSize:11.5, fontWeight:600, color:'#2D3278', outline:'none' }} />
                  </td>
                  <td style={{ padding:'8px 14px', fontSize:13, fontWeight:700, whiteSpace:'nowrap' as const,
                    color: t.amount < 0 ? '#b02020' : '#1a6b4a' }}>
                    {money(Number(t.amount))}
                  </td>
                  <td style={{ padding:'8px 14px', fontSize:12 }}>
                    <select value={t.category || ''} onChange={e => setTxCategory(t, e.target.value)}
                      style={{ padding:'4px 8px', border:'1.5px solid #e2e8f4', borderRadius:7, fontSize:11.5,
                        fontWeight:600, color: t.category ? '#2D3278' : '#9aaab0', outline:'none', cursor:'pointer',
                        background: t.status === 'pending' && t.category ? '#fff7e0' : '#fff', maxWidth:180 }}>
                      <option value="" disabled>— escolher —</option>
                      {GROUP_ORDER.filter(g => categories.some(c => c.kind === g)).map(g => (
                        <optgroup key={g} label={GROUP_LABEL[g]}>
                          {categories.filter(c => c.kind === g)
                            .sort((a, b) => a.name.localeCompare(b.name))
                            .map(c =>
                            <option key={c.name} value={c.name}>{c.name.includes(':') ? `\u00A0\u00A0\u21B3 ${c.name.split(': ')[1]}` : c.name}</option>)}
                        </optgroup>
                      ))}
                    </select>
                    {t.category_confidence != null && t.categorized_by !== 'staff' && (
                      <div style={{ fontSize:10, color: Number(t.category_confidence) >= 95 ? '#1a6b4a' : '#c06010', marginTop:2 }}>
                        {t.categorized_by === 'rule' ? 'regra' : `IA ${Number(t.category_confidence).toFixed(0)}%`}
                      </div>
                    )}
                  </td>
                  <td style={{ padding:'8px 10px', whiteSpace:'nowrap' as const }}>
                    {(t.status === 'auto' || t.status === 'pending') && (
                      <button onClick={() => bulkAction([t.id], 'approve')} title="Aprovar → registro"
                        style={{ background:'#e8f5ee', color:'#1a6b4a', border:'none', borderRadius:7, padding:'5px 9px', fontSize:12, fontWeight:800, cursor:'pointer', marginRight:4 }}>✓</button>
                    )}
                    {(t.status === 'approved' || t.status === 'reviewed') && (
                      <button onClick={() => bulkAction([t.id], 'reopen')} title="Reabrir para revisão (Banking)"
                        style={{ background:'#fff7e0', color:'#c06010', border:'none', borderRadius:7, padding:'5px 9px', fontSize:12, fontWeight:800, cursor:'pointer', marginRight:4 }}>↩</button>
                    )}
                    {t.status === 'auto' && (
                      <button onClick={() => bulkAction([t.id], 'unmatch')} title="Não aceitar (volta p/ não reconhecidas)"
                        style={{ background:'#fff7e0', color:'#c06010', border:'none', borderRadius:7, padding:'5px 9px', fontSize:12, fontWeight:800, cursor:'pointer', marginRight:4 }}>↩</button>
                    )}
                    {t.status !== 'excluded' ? (
                      <button onClick={() => bulkAction([t.id], 'exclude')} title="Excluir dos livros"
                        style={{ background:'#fee2e2', color:'#b02020', border:'none', borderRadius:7, padding:'5px 9px', fontSize:12, fontWeight:800, cursor:'pointer' }}>🚫</button>
                    ) : (
                      <button onClick={() => bulkAction([t.id], 'restore')} title="Restaurar"
                        style={{ background:'#f0f4fa', color:'#6a7a9a', border:'none', borderRadius:7, padding:'5px 9px', fontSize:12, fontWeight:800, cursor:'pointer' }}>♻️</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>)}

      {/* View Payees */}
      {view === 'payees' && (
        <div style={{ background:'#fff', borderRadius:14, padding:20, border:'1px solid #e2e8f4' }}>
          <h3 style={{ fontFamily:'Georgia,serif', fontSize:15, color:'#0f2340', margin:'0 0 4px' }}>🏪 Payees (Vendors & Customers)</h3>
          <p style={{ fontSize:12.5, color:'#6a7a9a', margin:'0 0 14px' }}>
            Cadastro dos favorecidos deste cliente. O tipo define onde aparecem nos relatórios (Vendor = pagamentos · Customer = recebimentos).
          </p>
          {payeeRegistry.length === 0 ? (
            <p style={{ fontSize:13, color:'#9aaab0' }}>Nenhum payee ainda — eles são criados nas regras, no modal de categorização ou na coluna Payee da tabela.</p>
          ) : (
            <table style={{ width:'100%', borderCollapse:'collapse' as const, maxWidth:560 }}>
              <thead><tr>
                {['Nome','Tipo'].map(h => <th key={h} style={{ textAlign:'left', padding:'8px 10px', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, borderBottom:'1px solid #e2e8f4' }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {payeeRegistry.map(p2 => (
                  <tr key={p2.name} style={{ borderBottom:'1px solid #f0f4fa' }}>
                    <td style={{ padding:'9px 10px', fontSize:13.5, fontWeight:600, color:'#0f2340' }}>{p2.name}</td>
                    <td style={{ padding:'9px 10px' }}>
                      <select value={p2.type}
                        onChange={async e => {
                          await fetch('/api/bookkeeping/payees', {
                            method:'POST', headers:{'content-type':'application/json'},
                            body: JSON.stringify({ clientId, name: p2.name, type: e.target.value }),
                          })
                          loadPayees()
                        }}
                        style={{ padding:'6px 10px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:12.5, fontWeight:700, outline:'none', cursor:'pointer' }}>
                        <option value="vendor">🏪 Vendor</option>
                        <option value="customer">💰 Customer</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
