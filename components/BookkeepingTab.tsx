'use client'
// BookkeepingTab — Fase 5.1
// Extrai transações dos extratos PDF (contas fechadas) e lista com resumo.
// Categorização automática (regras + IA) chega no módulo 5.2.

import { useState, useEffect } from 'react'

interface Tx {
  id: string; tx_date: string; description: string; amount: number
  balance: number|null; category: string|null; status: string
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
  const [year, setYear] = useState<number | 'all'>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const load = async () => {
    setLoading(true)
    const params = new URLSearchParams({ clientId })
    if (year !== 'all') params.set('year', String(year))
    if (statusFilter !== 'all') params.set('status', statusFilter)

    const [t, d] = await Promise.all([
      fetch(`/api/bookkeeping/transactions?${params}`).then(r => r.json()),
      fetch(`/api/clients/${clientId}`).then(r => r.json()).catch(() => ({ documents: [] })),
    ])
    setTxs(t.transactions || [])
    setSummary(t.summary || null)
    setStatements((d.documents || []).filter((x: Doc) =>
      (x.category || '').toLowerCase().includes('bank')))
    setLoading(false)
  }
  useEffect(() => { load() }, [clientId, year, statusFilter])

  const extract = async (documentId: string, fileName: string) => {
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

  const extractedDocIds = new Set(txs.map(t => t.statement_document_id).filter(Boolean))
  const years = Array.from(new Set(txs.map(t => t.fiscal_year))).sort((a,b) => b-a)
  const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`

  const card = { background:'#fff', borderRadius:14, padding:18, border:'1px solid #e2e8f4', marginBottom:14 }
  const btn = (bg: string, disabled = false) => ({
    padding:'7px 14px', background: disabled ? '#e2e8f4' : bg,
    color: disabled ? '#9aaab0' : '#fff', border:'none', borderRadius:8,
    fontSize:12.5, fontWeight:700, cursor: disabled ? 'not-allowed' : 'pointer',
  })
  const sel = { padding:'7px 11px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, fontWeight:700, color:'#0f2340', outline:'none', cursor:'pointer' }

  return (
    <div>
      {/* Extratos disponíveis */}
      <div style={card}>
        <h3 style={{ fontFamily:'Georgia,serif', fontSize:15, color:'#0f2340', margin:'0 0 4px' }}>
          📄 Extratos bancários (PDF)
        </h3>
        <p style={{ fontSize:12.5, color:'#6a7a9a', margin:'0 0 12px' }}>
          Para contas fechadas ou sem conexão bancária: a IA lê o PDF e extrai todas as transações.
        </p>
        {statements.length === 0 ? (
          <p style={{ fontSize:13, color:'#9aaab0' }}>Nenhum extrato na categoria Bank Statements. Faça upload na aba Documents.</p>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {statements.map(s => (
              <div key={s.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', background:'#f8faff', borderRadius:9, flexWrap:'wrap' }}>
                <span style={{ fontSize:13, fontWeight:600, color:'#1a2a3a', flex:1, minWidth:180 }}>📄 {s.file_name}</span>
                <span style={{ fontSize:11, color:'#6a7a9a' }}>{s.tax_year}</span>
                {extractedDocIds.has(s.id) ? (
                  <span style={{ fontSize:12, color:'#1a6b4a', fontWeight:700 }}>✓ Extraído</span>
                ) : (
                  <button onClick={() => extract(s.id, s.file_name)} disabled={!!extracting}
                    style={btn('#2D3278', !!extracting)}>
                    {extracting === s.id ? '🤖 Lendo o PDF…' : '📊 Extrair transações'}
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

      {/* Filtros */}
      <div style={{ display:'flex', gap:10, marginBottom:12, flexWrap:'wrap' }}>
        <select value={year} onChange={e => setYear(e.target.value === 'all' ? 'all' : Number(e.target.value))} style={sel}>
          <option value="all">Todos os anos</option>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={sel}>
          <option value="all">Todos os status</option>
          <option value="pending">⏳ Em aberto</option>
          <option value="auto">🤖 Auto</option>
          <option value="reviewed">✅ Revisadas</option>
          <option value="excluded">🚫 Excluídas</option>
        </select>
      </div>

      {/* Lista */}
      {loading ? <p style={{ color:'#6a7a9a', fontSize:13 }}>Carregando…</p> :
       txs.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:14, padding:40, border:'1px solid #e2e8f4', textAlign:'center', color:'#9aaab0' }}>
          <div style={{ fontSize:32, marginBottom:8 }}>📊</div>
          <div style={{ fontSize:13 }}>Nenhuma transação ainda — extraia um extrato acima.</div>
        </div>
      ) : (
        <div style={{ background:'#fff', borderRadius:14, border:'1px solid #e2e8f4', overflow:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', minWidth:640 }}>
            <thead><tr style={{ background:'#f8faff' }}>
              {['Data','Descrição','Valor','Categoria','Status'].map(h =>
                <th key={h} style={{ padding:'9px 14px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, borderBottom:'1px solid #e2e8f4' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {txs.map(t => (
                <tr key={t.id} style={{ borderBottom:'1px solid #f0f4fa' }}>
                  <td style={{ padding:'8px 14px', fontSize:12.5, color:'#3a4a5a', whiteSpace:'nowrap' as const }}>
                    {new Date(t.tx_date + 'T12:00:00Z').toLocaleDateString('pt-BR')}
                  </td>
                  <td style={{ padding:'8px 14px', fontSize:12.5, color:'#1a2a3a', maxWidth:320 }}>
                    {t.description}
                    {t.account_hint && <div style={{ fontSize:10.5, color:'#9aaab0' }}>{t.account_hint}</div>}
                  </td>
                  <td style={{ padding:'8px 14px', fontSize:13, fontWeight:700, whiteSpace:'nowrap' as const,
                    color: t.amount < 0 ? '#b02020' : '#1a6b4a' }}>
                    {money(Number(t.amount))}
                  </td>
                  <td style={{ padding:'8px 14px', fontSize:12, color: t.category ? '#2D3278' : '#c9d2e0' }}>
                    {t.category || '— (5.2)'}
                  </td>
                  <td style={{ padding:'8px 14px', fontSize:11.5 }}>
                    <span style={{ padding:'2px 8px', borderRadius:20, fontWeight:700,
                      background: t.status === 'pending' ? '#fff7e0' : t.status === 'reviewed' ? '#e8f5ee' : '#f0f4fa',
                      color: t.status === 'pending' ? '#c06010' : t.status === 'reviewed' ? '#1a6b4a' : '#6a7a9a' }}>
                      {STATUS_LABEL[t.status] || t.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
