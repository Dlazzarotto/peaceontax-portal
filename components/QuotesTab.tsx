'use client'
// QuotesTab v2 — cotações com edição, permissões e auditoria
// owner/manager: editam direto · junior: PIN de manager + motivo
// Cliente business: sem cotação automática — criação manual

import { useState, useEffect } from 'react'

interface QuoteItem { label: string; amount: number; qty?: number }
interface Quote {
  id: string; fiscal_year: number; items: QuoteItem[]
  total: number; status: 'draft'|'sent'|'paid'|'cancelled'
  paid_at: string|null; payment_queued_for: string|null; created_at: string
}

interface Props { clientId: string; clientName: string; clientType?: string }

const STATUS_LABEL: Record<string,string> = { draft:'Rascunho', sent:'Enviado', paid:'Pago ✓', cancelled:'Cancelado' }
const STATUS_COLOR: Record<string,string> = { draft:'#6a7a9a', sent:'#c06010', paid:'#1a6b4a', cancelled:'#b02020' }
const STATUS_BG:    Record<string,string> = { draft:'#f0f4fa', sent:'#fff7e0', paid:'#e8f5ee', cancelled:'#fee2e2' }

export default function QuotesTab({ clientId, clientName, clientType }: Props) {
  const [quotes,     setQuotes]     = useState<Quote[]>([])
  const [loading,    setLoading]    = useState(true)
  const [level,      setLevel]      = useState<'owner'|'manager'|'junior'>('junior')
  const [generating, setGenerating] = useState(false)
  const [sendingId,  setSendingId]  = useState<string|null>(null)
  const [year,       setYear]       = useState(new Date().getFullYear() - 1)
  const [msg,        setMsg]        = useState('')

  // Editor
  const [editingId,  setEditingId]  = useState<string|null>(null)
  const [editItems,  setEditItems]  = useState<QuoteItem[]>([])
  const [saving,     setSaving]     = useState(false)

  // Modal de aprovação (junior) / cancelamento
  const [modalAction, setModalAction] = useState<null | { type:'save'|'cancel'; quoteId: string }>(null)
  const [pin,        setPin]        = useState('')
  const [reason,     setReason]     = useState('')

  const YEARS = Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - 1 - i)
  const isBusiness = clientType === 'business'
  const needsApproval = level === 'junior'

  const load = async () => {
    setLoading(true)
    const [q, p] = await Promise.all([
      fetch(`/api/quotes?clientId=${clientId}`).then(r => r.json()),
      fetch('/api/quotes/perms').then(r => r.json()),
    ])
    setQuotes(q.quotes || [])
    setLevel(p.level || 'junior')
    setLoading(false)
  }

  useEffect(() => { load() }, [clientId])

  // ---- Gerar cotação (automática PF / manual business) ----
  const generate = async () => {
    setGenerating(true); setMsg('')
    if (isBusiness) {
      // Business: cria cotação manual em branco para a equipe montar
      const blank = [{ label: 'Serviço contábil — descrever', amount: 0 }]
      const r = await fetch('/api/portal/quote', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, fiscalYear: year, manualBlank: true }),
      })
      // Fallback: se a rota não suportar manualBlank ainda, orienta
      const d = await r.json()
      if (d.quoteId) { setMsg('✓ Rascunho criado — edite os itens abaixo.'); load() }
      else setMsg('Business requer cotação manual. Gere um rascunho editando a cotação abaixo ou peça atualização da API.')
    } else {
      const r = await fetch('/api/portal/quote', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, fiscalYear: year }),
      })
      const d = await r.json()
      if (d.quote?.needsManualReview) setMsg(`⚠️ ${d.quote.reviewReason}`)
      else if (d.quoteId) { setMsg(`✓ Cotação gerada: $${d.quote.total.toFixed(2)} — revise e edite se necessário.`); load() }
      else setMsg(d.error || 'Erro ao gerar cotação')
    }
    setGenerating(false)
  }

  // ---- Edição ----
  const startEdit = (q: Quote) => {
    setEditingId(q.id)
    setEditItems(q.items.map(i => ({ ...i })))
    setMsg('')
  }

  const updateItem = (i: number, patch: Partial<QuoteItem>) =>
    setEditItems(items => items.map((it, idx) => idx === i ? { ...it, ...patch } : it))

  const addItem = () => setEditItems(items => [...items, { label: '', amount: 0 }])
  const removeItem = (i: number) => setEditItems(items => items.filter((_, idx) => idx !== i))

  const editTotal = editItems.reduce((s, i) => s + (Number(i.amount) || 0), 0)

  const trySave = () => {
    for (const it of editItems) {
      if (!it.label.trim()) { setMsg('Todos os itens precisam de descrição.'); return }
    }
    if (needsApproval) {
      setModalAction({ type:'save', quoteId: editingId! })
      setPin(''); setReason('')
    } else {
      doSave(editingId!, undefined, undefined)
    }
  }

  const doSave = async (quoteId: string, managerPin?: string, saveReason?: string) => {
    setSaving(true); setMsg('')
    const r = await fetch(`/api/quotes/${quoteId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: editItems.map(i => ({ label: i.label.trim(), amount: Number(i.amount), qty: i.qty })),
        managerPin: managerPin, reason: saveReason,
      }),
    })
    const d = await r.json()
    if (d.ok) { setMsg('✓ Cotação atualizada.'); setEditingId(null); setModalAction(null); load() }
    else setMsg(`Erro: ${d.error}`)
    setSaving(false)
  }

  // ---- Cancelamento (sempre exige motivo) ----
  const tryCancel = (quoteId: string) => {
    setModalAction({ type:'cancel', quoteId })
    setPin(''); setReason('')
  }

  const doCancel = async (quoteId: string, managerPin?: string, cancelReason?: string) => {
    setSaving(true); setMsg('')
    const r = await fetch(`/api/quotes/${quoteId}`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ managerPin, reason: cancelReason }),
    })
    const d = await r.json()
    if (d.ok) { setMsg('✓ Cotação cancelada.'); setModalAction(null); load() }
    else setMsg(`Erro: ${d.error}`)
    setSaving(false)
  }

  const confirmModal = () => {
    if (!reason.trim()) { setMsg('Motivo é obrigatório.'); return }
    if (needsApproval && !pin.trim()) { setMsg('PIN do manager é obrigatório.'); return }
    if (modalAction?.type === 'save')   doSave(modalAction.quoteId, pin || undefined, reason)
    if (modalAction?.type === 'cancel') doCancel(modalAction.quoteId, pin || undefined, reason)
  }

  // ---- Pagamento ----
  const sendPayment = async (quoteId: string) => {
    setSendingId(quoteId); setMsg('')
    const r = await fetch('/api/stripe/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteId }),
    })
    const d = await r.json()
    if (d.url) { window.open(d.url, '_blank'); setMsg('✓ Link de pagamento aberto em nova aba. Copie e envie ao cliente.'); load() }
    else setMsg(`Erro: ${d.error}`)
    setSendingId(null)
  }

  const btn = (bg: string, disabled = false) => ({
    padding:'8px 16px', background: disabled ? '#e2e8f4' : bg,
    color: disabled ? '#9aaab0' : '#fff', border:'none', borderRadius:8,
    fontSize:13, fontWeight:700, cursor: disabled ? 'not-allowed' : 'pointer',
  })
  const input = { padding:'8px 10px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }

  return (
    <div>
      {/* Barra de nível */}
      <p style={{ fontSize:12, color:'#9aaab0', margin:'0 0 12px' }}>
        Seu nível: <strong style={{ color:'#2D3278' }}>{level}</strong>
        {needsApproval && ' — alterações exigem PIN de um manager + motivo'}
      </p>

      {/* Gerar cotação */}
      <div style={{ background:'#fff', borderRadius:14, padding:20, border:'1px solid #e2e8f4', marginBottom:16 }}>
        <h3 style={{ fontFamily:'Georgia,serif', fontSize:15, color:'#0f2340', margin:'0 0 14px' }}>
          💰 {isBusiness ? 'Cotação business (manual)' : 'Gerar cotação'} para {clientName}
        </h3>
        <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
          <label style={{ fontSize:13, color:'#6a7a9a' }}>Ano fiscal:</label>
          <select value={year} onChange={e => setYear(Number(e.target.value))}
            style={{ ...input, fontWeight:700, color:'#0f2340' }}>
            {YEARS.map(y => <option key={y}>{y}</option>)}
          </select>
          <button onClick={generate} disabled={generating} style={btn('#2D3278', generating)}>
            {generating ? 'Criando…' : isBusiness ? '📝 Criar rascunho manual' : '📊 Gerar cotação automática'}
          </button>
        </div>
        <p style={{ fontSize:12, color:'#9aaab0', margin:'8px 0 0' }}>
          {isBusiness
            ? 'Clientes business não têm cotação automática — a equipe monta os itens manualmente.'
            : 'Calculada pelos documentos classificados pela IA. Revise e edite antes de enviar.'}
        </p>
        {msg && (
          <p style={{ fontSize:13, marginTop:10, fontWeight:600,
            color: msg.startsWith('✓') ? '#1a6b4a' : msg.startsWith('⚠') ? '#c06010' : '#b02020' }}>
            {msg}
          </p>
        )}
      </div>

      {/* Lista */}
      {loading ? <p style={{ color:'#6a7a9a', fontSize:13 }}>Carregando…</p> :
       quotes.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:14, padding:40, border:'1px solid #e2e8f4', textAlign:'center', color:'#9aaab0' }}>
          <div style={{ fontSize:32, marginBottom:8 }}>💰</div>
          <div style={{ fontSize:13 }}>Nenhuma cotação ainda.</div>
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
                <span style={{ fontSize:22, fontWeight:800, color:'#2D3278' }}>
                  ${(editingId === q.id ? editTotal : q.total).toFixed(2)}
                </span>
              </div>

              {/* ---- Modo edição ---- */}
              {editingId === q.id ? (
                <div style={{ background:'#f8faff', borderRadius:10, padding:'12px 14px', marginBottom:12 }}>
                  {editItems.map((item, i) => (
                    <div key={i} style={{ display:'flex', gap:8, marginBottom:8, alignItems:'center' }}>
                      <input value={item.label} placeholder="Descrição do serviço"
                        onChange={e => updateItem(i, { label: e.target.value })}
                        style={{ ...input, flex:1 }} />
                      <span style={{ color:'#6a7a9a' }}>$</span>
                      <input type="number" value={item.amount} min={0} step={5}
                        onChange={e => updateItem(i, { amount: Number(e.target.value) })}
                        style={{ ...input, width:90, textAlign:'right' as const }} />
                      <button onClick={() => removeItem(i)} aria-label="Remover item"
                        style={{ ...btn('#b02020'), padding:'6px 10px' }}>×</button>
                    </div>
                  ))}
                  <div style={{ display:'flex', gap:8, marginTop:10 }}>
                    <button onClick={addItem} style={{ ...btn('#fff'), color:'#2D3278', border:'1.5px solid #2D3278' }}>
                      + Adicionar item
                    </button>
                    <button onClick={trySave} disabled={saving} style={btn('#1a6b4a', saving)}>
                      {saving ? 'Salvando…' : '✓ Salvar alterações'}
                    </button>
                    <button onClick={() => { setEditingId(null); setMsg('') }}
                      style={{ ...btn('#fff'), color:'#6a7a9a', border:'1.5px solid #e2e8f4' }}>
                      Cancelar edição
                    </button>
                  </div>
                </div>
              ) : (
                /* ---- Visualização ---- */
                <div style={{ background:'#f8faff', borderRadius:10, padding:'10px 14px', marginBottom:12 }}>
                  {q.items.map((item, i) => (
                    <div key={i} style={{ display:'flex', justifyContent:'space-between', fontSize:13, color:'#3a4a5a',
                      padding:'4px 0', borderBottom: i < q.items.length-1 ? '1px solid #e2e8f4' : 'none' }}>
                      <span>{item.label}{item.qty && item.qty > 1 ? ` ×${item.qty}` : ''}</span>
                      <span style={{ fontWeight:600 }}>{item.amount === 0 ? 'Incluído' : `$${item.amount.toFixed(2)}`}</span>
                    </div>
                  ))}
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:15, fontWeight:800,
                    color:'#0f2340', marginTop:8, paddingTop:8, borderTop:'2px solid #2D3278' }}>
                    <span>Total</span><span>${q.total.toFixed(2)}</span>
                  </div>
                </div>
              )}

              {/* Ações */}
              {editingId !== q.id && (
                <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                  {(q.status === 'draft' || q.status === 'sent') && (
                    <>
                      <button onClick={() => startEdit(q)} style={{ ...btn('#fff'), color:'#2D3278', border:'1.5px solid #2D3278' }}>
                        ✏️ Editar
                      </button>
                      <button onClick={() => sendPayment(q.id)} disabled={sendingId === q.id || q.total <= 0}
                        style={btn('#F47B20', sendingId === q.id || q.total <= 0)}>
                        {sendingId === q.id ? 'Gerando…' : '💳 Link de pagamento'}
                      </button>
                      <button onClick={() => tryCancel(q.id)} style={{ ...btn('#fff'), color:'#b02020', border:'1.5px solid #fdd' }}>
                        🚫 Cancelar cotação
                      </button>
                    </>
                  )}
                  {q.status === 'paid' && (
                    <span style={{ fontSize:13, color:'#1a6b4a', fontWeight:600 }}>
                      ✓ Pago {q.paid_at && `em ${new Date(q.paid_at).toLocaleDateString('pt-BR', { timeZone:'America/New_York' })} (ET)`}
                      {q.payment_queued_for && (
                        <span style={{ color:'#6a7a9a', fontWeight:400 }}>
                          {' · '}Fila: {new Date(q.payment_queued_for + 'T12:00:00Z').toLocaleDateString('pt-BR', { weekday:'long', day:'numeric', month:'long' })}
                        </span>
                      )}
                    </span>
                  )}
                  <span style={{ fontSize:11, color:'#9aaab0', marginLeft:'auto' }}>
                    {new Date(q.created_at).toLocaleDateString('pt-BR')}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ---- Modal de motivo/PIN ---- */}
      {modalAction && (
        <div style={{ position:'fixed', inset:0, background:'rgba(15,35,64,0.5)', display:'flex',
          alignItems:'center', justifyContent:'center', zIndex:2000 }}>
          <div style={{ background:'#fff', borderRadius:16, padding:24, width:400, maxWidth:'90vw' }}>
            <h3 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:'0 0 6px' }}>
              {modalAction.type === 'cancel' ? '🚫 Cancelar cotação' : '✓ Confirmar alteração'}
            </h3>
            <p style={{ fontSize:13, color:'#6a7a9a', margin:'0 0 14px' }}>
              {modalAction.type === 'cancel'
                ? 'O motivo do cancelamento fica registrado na auditoria.'
                : 'Alterações de nível junior exigem aprovação de um manager.'}
            </p>

            <label style={{ display:'block', fontSize:12, fontWeight:700, color:'#6a7a9a', marginBottom:4 }}>
              Motivo *
            </label>
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
              placeholder="Descreva o motivo…"
              style={{ ...input, width:'100%', resize:'vertical' as const, marginBottom:12 }} />

            {needsApproval && (
              <>
                <label style={{ display:'block', fontSize:12, fontWeight:700, color:'#6a7a9a', marginBottom:4 }}>
                  PIN do manager *
                </label>
                <input type="password" inputMode="numeric" value={pin} onChange={e => setPin(e.target.value)}
                  placeholder="4–8 dígitos" maxLength={8}
                  style={{ ...input, width:'100%', marginBottom:12, letterSpacing:4 }} />
              </>
            )}

            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={() => { setModalAction(null); setMsg('') }}
                style={{ ...btn('#fff'), color:'#6a7a9a', border:'1.5px solid #e2e8f4' }}>
                Voltar
              </button>
              <button onClick={confirmModal} disabled={saving}
                style={btn(modalAction.type === 'cancel' ? '#b02020' : '#1a6b4a', saving)}>
                {saving ? 'Processando…' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
