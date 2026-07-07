'use client'
// QuotesTab — aba de cotações na tela /clients/[id]
// Equipe gera cotação → revisa itens → envia link de pagamento Stripe

import { useState, useEffect } from 'react'

interface QuoteItem { label: string; amount: number; qty?: number }
interface Quote {
  id: string; fiscal_year: number; items: QuoteItem[]
  total: number; status: 'draft'|'sent'|'paid'|'cancelled'
  paid_at: string|null; payment_queued_for: string|null; created_at: string
}

interface Props { clientId: string; clientName: string }

const STATUS_LABEL: Record<string,string> = { draft:'Rascunho', sent:'Enviado', paid:'Pago ✓', cancelled:'Cancelado' }
const STATUS_COLOR: Record<string,string> = { draft:'#6a7a9a', sent:'#c06010', paid:'#1a6b4a', cancelled:'#b02020' }
const STATUS_BG:    Record<string,string> = { draft:'#f0f4fa', sent:'#fff7e0', paid:'#e8f5ee', cancelled:'#fee2e2' }

export default function QuotesTab({ clientId, clientName }: Props) {
  const [quotes,     setQuotes]     = useState<Quote[]>([])
  const [loading,    setLoading]    = useState(true)
  const [generating, setGenerating] = useState(false)
  const [sendingId,  setSendingId]  = useState<string|null>(null)
  const [year,       setYear]       = useState(new Date().getFullYear() - 1)
  const [msg,        setMsg]        = useState('')

  const YEARS = Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - 1 - i)

  const load = async () => {
    setLoading(true)
    const r = await fetch(`/api/quotes?clientId=${clientId}`)
    const d = await r.json()
    setQuotes(d.quotes || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [clientId])

  const generate = async () => {
    setGenerating(true); setMsg('')
    const r = await fetch('/api/portal/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, fiscalYear: year }),
    })
    const d = await r.json()
    if (d.quote?.needsManualReview) {
      setMsg(`⚠️ ${d.quote.reviewReason}`)
    } else if (d.quoteId) {
      setMsg(`✓ Cotação gerada: $${d.quote.total.toFixed(2)}`)
      load()
    } else {
      setMsg(d.error || 'Erro ao gerar cotação')
    }
    setGenerating(false)
  }

  const sendPayment = async (quoteId: string) => {
    setSendingId(quoteId); setMsg('')
    const r = await fetch('/api/stripe/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteId }),
    })
    const d = await r.json()
    if (d.url) {
      window.open(d.url, '_blank')
      setMsg('✓ Link de pagamento gerado. Copie e envie ao cliente.')
      load()
    } else {
      setMsg(`Erro: ${d.error}`)
    }
    setSendingId(null)
  }

  const btn = (color: string, disabled: boolean) => ({
    padding:'8px 16px', background: disabled ? '#e2e8f4' : color,
    color: disabled ? '#9aaab0' : '#fff', border:'none', borderRadius:8,
    fontSize:13, fontWeight:700, cursor: disabled ? 'not-allowed' : 'pointer',
  })

  return (
    <div>
      {/* Gerar nova cotação */}
      <div style={{ background:'#fff', borderRadius:14, padding:20, border:'1px solid #e2e8f4', marginBottom:16 }}>
        <h3 style={{ fontFamily:'Georgia,serif', fontSize:15, color:'#0f2340', margin:'0 0 14px' }}>
          💰 Gerar cotação para {clientName}
        </h3>
        <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
          <label style={{ fontSize:13, color:'#6a7a9a' }}>Ano fiscal:</label>
          <select value={year} onChange={e => setYear(Number(e.target.value))}
            style={{ padding:'7px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:14, fontWeight:700, color:'#0f2340', outline:'none' }}>
            {YEARS.map(y => <option key={y}>{y}</option>)}
          </select>
          <button onClick={generate} disabled={generating} style={btn('#2D3278', generating)}>
            {generating ? 'Calculando…' : '📊 Gerar cotação'}
          </button>
        </div>
        <p style={{ fontSize:12, color:'#9aaab0', margin:'8px 0 0' }}>
          A cotação é calculada automaticamente com base nos documentos classificados pela IA.
          Documentos sem classificação são ignorados — verifique antes de enviar.
        </p>
        {msg && (
          <p style={{ fontSize:13, marginTop:10, fontWeight:600,
            color: msg.startsWith('✓') ? '#1a6b4a' : msg.startsWith('⚠') ? '#c06010' : '#b02020' }}>
            {msg}
          </p>
        )}
      </div>

      {/* Lista de cotações */}
      {loading ? (
        <p style={{ color:'#6a7a9a', fontSize:13 }}>Carregando cotações…</p>
      ) : quotes.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:14, padding:40, border:'1px solid #e2e8f4', textAlign:'center', color:'#9aaab0' }}>
          <div style={{ fontSize:32, marginBottom:8 }}>💰</div>
          <div style={{ fontSize:13 }}>Nenhuma cotação ainda. Gere uma acima.</div>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          {quotes.map(q => (
            <div key={q.id} style={{ background:'#fff', borderRadius:14, padding:18, border:'1px solid #e2e8f4' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                <div>
                  <span style={{ fontSize:15, fontWeight:700, color:'#0f2340' }}>Ano Fiscal {q.fiscal_year}</span>
                  <span style={{ marginLeft:10, fontSize:11, padding:'2px 8px', borderRadius:20, fontWeight:700,
                    background:STATUS_BG[q.status], color:STATUS_COLOR[q.status] }}>
                    {STATUS_LABEL[q.status]}
                  </span>
                </div>
                <span style={{ fontSize:22, fontWeight:800, color:'#2D3278' }}>${q.total.toFixed(2)}</span>
              </div>

              {/* Itens */}
              <div style={{ background:'#f8faff', borderRadius:10, padding:'10px 14px', marginBottom:12 }}>
                {q.items.filter(i => i.amount >= 0).map((item, i) => (
                  <div key={i} style={{ display:'flex', justifyContent:'space-between', fontSize:13, color:'#3a4a5a',
                    padding:'4px 0', borderBottom: i < q.items.length-1 ? '1px solid #e2e8f4' : 'none' }}>
                    <span>{item.label}{item.qty && item.qty > 1 ? ` ×${item.qty}` : ''}</span>
                    <span style={{ fontWeight:600 }}>{item.amount === 0 ? 'Incluído' : `$${item.amount.toFixed(2)}`}</span>
                  </div>
                ))}
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:15, fontWeight:800,
                  color:'#0f2340', marginTop:8, paddingTop:8, borderTop:'2px solid #2D3278' }}>
                  <span>Total</span>
                  <span>${q.total.toFixed(2)}</span>
                </div>
              </div>

              {/* Ações */}
              <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                {(q.status === 'draft' || q.status === 'sent') && (
                  <button onClick={() => sendPayment(q.id)} disabled={sendingId === q.id}
                    style={btn('#F47B20', sendingId === q.id)}>
                    {sendingId === q.id ? 'Gerando…' : '💳 Gerar e abrir link de pagamento'}
                  </button>
                )}
                {q.status === 'paid' && (
                  <span style={{ fontSize:13, color:'#1a6b4a', fontWeight:600 }}>
                    ✓ Pago em {new Date(q.paid_at!).toLocaleDateString('pt-BR', { timeZone:'America/New_York' })} (ET)
                    {q.payment_queued_for && (
                      <span style={{ color:'#6a7a9a', fontWeight:400 }}>
                        {' · '}Fila: {new Date(q.payment_queued_for + 'T12:00:00Z').toLocaleDateString('pt-BR', { weekday:'long', day:'numeric', month:'long' })}
                      </span>
                    )}
                  </span>
                )}
                <span style={{ fontSize:11, color:'#9aaab0', marginLeft:'auto' }}>
                  Gerada em {new Date(q.created_at).toLocaleDateString('pt-BR')}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
