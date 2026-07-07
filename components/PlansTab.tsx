'use client'
// PlansTab — Parcelamento (entrada % + parcelas) e Contrato Bookkeeping mensal (dia 5)
// Criação: SÓ manager/owner. Cancelamento sempre com motivo.

import { useState, useEffect } from 'react'

interface Plan {
  id: string; kind: 'installment'|'bookkeeping'
  total: number|null; entry_pct: number|null; entry_amount: number|null
  frequency: string|null; installments: number|null; installment_amount: number|null
  monthly_amount: number|null; due_day: number|null
  description: string|null; status: string
  paid_installments: number; entry_paid_at: string|null; next_charge_date: string|null
  cancel_reason: string|null; created_at: string
}

interface Props { clientId: string; clientName: string }

const STATUS_LABEL: Record<string,string> = {
  draft:'Rascunho', awaiting_entry:'Aguardando entrada', awaiting_setup:'Aguardando assinatura',
  active:'Ativo ✓', paused:'⏸️ Pausado', payment_failed:'⚠️ Débito falhou', completed:'Concluído ✓', cancelled:'Cancelado',
}
const STATUS_COLOR: Record<string,string> = {
  draft:'#6a7a9a', awaiting_entry:'#c06010', awaiting_setup:'#c06010',
  active:'#1a6b4a', paused:'#c06010', payment_failed:'#b02020', completed:'#2D3278', cancelled:'#9aaab0',
}
const FREQ_LABEL: Record<string,string> = { weekly:'Semanal', biweekly:'Quinzenal', monthly:'Mensal' }

export default function PlansTab({ clientId, clientName }: Props) {
  const [plans, setPlans] = useState<Plan[]>([])
  const [level, setLevel] = useState('junior')
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  // Form parcelamento
  const [showInst, setShowInst] = useState(false)
  const [total, setTotal] = useState(''); const [entryPct, setEntryPct] = useState('30')
  const [freq, setFreq] = useState('monthly'); const [nInst, setNInst] = useState('12')
  const [descInst, setDescInst] = useState('')

  // Form bookkeeping
  const [showBk, setShowBk] = useState(false)
  const [monthly, setMonthly] = useState(''); const [descBk, setDescBk] = useState('Bookkeeping mensal')

  // Cancelamento
  const [cancelId, setCancelId] = useState<string|null>(null)
  const [cancelReason, setCancelReason] = useState('')

  // Pausa/retomada (só bookkeeping)
  const [pauseTarget, setPauseTarget] = useState<{ id:string; action:'pause'|'resume' }|null>(null)
  const [pauseReason, setPauseReason] = useState('')

  const canManage = level === 'owner' || level === 'manager'

  const load = async () => {
    setLoading(true)
    const r = await fetch(`/api/plans?clientId=${clientId}`)
    const d = await r.json()
    setPlans(d.plans || []); setLevel(d.level || 'junior'); setLoading(false)
  }
  useEffect(() => { load() }, [clientId])

  // Preview do parcelamento
  const pTotal = Number(total) || 0
  const pEntry = Math.round(pTotal * (Number(entryPct)||0)) / 100 * 1 // % handled below
  const entryVal = Math.round(pTotal * (Number(entryPct)||0)) / 100
  const perInst = pTotal > 0 && Number(nInst) > 0
    ? Math.round(((pTotal - entryVal) / Number(nInst)) * 100) / 100 : 0

  const createInstallment = async () => {
    setBusy(true); setMsg('')
    const r = await fetch('/api/plans', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({
        clientId, kind:'installment', total: Number(total),
        entryPct: Number(entryPct), frequency: freq,
        installments: Number(nInst), description: descInst,
      }),
    })
    const d = await r.json()
    if (d.ok) { setMsg('✓ Parcelamento criado — gere o link da entrada.'); setShowInst(false); load() }
    else setMsg(`Erro: ${d.error}`)
    setBusy(false)
  }

  const createBookkeeping = async () => {
    setBusy(true); setMsg('')
    const r = await fetch('/api/plans', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ clientId, kind:'bookkeeping', monthlyAmount: Number(monthly), description: descBk }),
    })
    const d = await r.json()
    if (d.ok) { setMsg('✓ Contrato criado — gere o link de assinatura.'); setShowBk(false); load() }
    else setMsg(`Erro: ${d.error}`)
    setBusy(false)
  }

  const genLink = async (planId: string) => {
    setBusy(true); setMsg('')
    const r = await fetch('/api/plans/checkout', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ planId }),
    })
    const d = await r.json()
    if (d.url) { window.open(d.url, '_blank'); setMsg('✓ Link aberto em nova aba — copie e envie ao cliente.'); load() }
    else setMsg(`Erro: ${d.error}`)
    setBusy(false)
  }

  const doPause = async () => {
    if (!pauseReason.trim()) { setMsg('Motivo é obrigatório.'); return }
    setBusy(true)
    const r = await fetch('/api/plans/pause', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ planId: pauseTarget!.id, action: pauseTarget!.action, reason: pauseReason }),
    })
    const d = await r.json()
    if (d.ok) { setMsg(pauseTarget!.action === 'pause' ? '✓ Contrato pausado — cobranças suspensas.' : '✓ Contrato retomado — cobranças reativadas.'); setPauseTarget(null); setPauseReason(''); load() }
    else setMsg(`Erro: ${d.error}`)
    setBusy(false)
  }

  const doCancel = async () => {
    if (!cancelReason.trim()) { setMsg('Motivo é obrigatório.'); return }
    setBusy(true)
    const r = await fetch(`/api/plans?id=${cancelId}&reason=${encodeURIComponent(cancelReason)}`, { method:'DELETE' })
    const d = await r.json()
    if (d.ok) { setMsg('✓ Plano cancelado (cobranças futuras interrompidas).'); setCancelId(null); setCancelReason(''); load() }
    else setMsg(`Erro: ${d.error}`)
    setBusy(false)
  }

  const btn = (bg: string, disabled = false) => ({
    padding:'9px 16px', background: disabled ? '#e2e8f4' : bg,
    color: disabled ? '#9aaab0' : '#fff', border:'none', borderRadius:8,
    fontSize:13, fontWeight:700, cursor: disabled ? 'not-allowed' : 'pointer',
  })
  const outlineBtn = (color: string) => ({
    padding:'9px 16px', background:'#fff', color, border:`1.5px solid ${color}`,
    borderRadius:8, fontSize:13, fontWeight:700, cursor:'pointer',
  })
  const input = { padding:'9px 11px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:14, outline:'none' }
  const label = { display:'block', fontSize:12, fontWeight:700, color:'#6a7a9a', marginBottom:4 }
  const money = (n: number|null) => n == null ? '—' : `$${Number(n).toFixed(2)}`

  return (
    <div>
      {!canManage && (
        <p style={{ fontSize:13, color:'#c06010', fontWeight:600, marginBottom:12 }}>
          Somente manager/owner criam e cancelam planos. Você pode visualizar.
        </p>
      )}

      {/* Botões de criação */}
      {canManage && (
        <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap' }}>
          <button onClick={() => { setShowInst(s => !s); setShowBk(false) }} style={outlineBtn('#2D3278')}>
            📆 Novo parcelamento
          </button>
          <button onClick={() => { setShowBk(s => !s); setShowInst(false) }} style={outlineBtn('#1a6b4a')}>
            📚 Novo contrato bookkeeping
          </button>
        </div>
      )}

      {/* Form: Parcelamento */}
      {showInst && (
        <div style={{ background:'#fff', borderRadius:14, padding:20, border:'2px solid #2D3278', marginBottom:16 }}>
          <h3 style={{ fontFamily:'Georgia,serif', fontSize:15, color:'#0f2340', margin:'0 0 14px' }}>
            📆 Parcelamento para {clientName}
          </h3>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:12, marginBottom:12 }}>
            <div>
              <label style={label}>Valor total ($)</label>
              <input type="number" value={total} onChange={e => setTotal(e.target.value)} min={1} style={{ ...input, width:'100%' }} />
            </div>
            <div>
              <label style={label}>Entrada (%)</label>
              <input type="number" value={entryPct} onChange={e => setEntryPct(e.target.value)} min={1} max={90} style={{ ...input, width:'100%' }} />
            </div>
            <div>
              <label style={label}>Frequência</label>
              <select value={freq} onChange={e => setFreq(e.target.value)} style={{ ...input, width:'100%', cursor:'pointer' }}>
                <option value="weekly">Semanal</option>
                <option value="biweekly">Quinzenal</option>
                <option value="monthly">Mensal</option>
              </select>
            </div>
            <div>
              <label style={label}>Nº de parcelas</label>
              <input type="number" value={nInst} onChange={e => setNInst(e.target.value)} min={1} max={60} style={{ ...input, width:'100%' }} />
            </div>
          </div>
          <div style={{ marginBottom:12 }}>
            <label style={label}>Descrição do serviço</label>
            <input value={descInst} onChange={e => setDescInst(e.target.value)}
              placeholder="Ex.: Bookkeeping 2024 + declarações em atraso" style={{ ...input, width:'100%' }} />
          </div>
          {pTotal > 0 && (
            <div style={{ background:'#f0f4ff', borderRadius:10, padding:'12px 16px', marginBottom:12, fontSize:14, color:'#2D3278' }}>
              💵 Entrada: <strong>{money(entryVal)}</strong> (paga agora, autoriza o débito automático)
              <br/>📆 Depois: <strong>{nInst}× de {money(perInst)}</strong> ({FREQ_LABEL[freq]}), a partir de 1 {freq==='weekly'?'semana':freq==='biweekly'?'quinzena':'mês'} após a entrada
            </div>
          )}
          <button onClick={createInstallment} disabled={busy || !total || !nInst} style={btn('#2D3278', busy || !total || !nInst)}>
            {busy ? 'Criando…' : 'Criar parcelamento'}
          </button>
        </div>
      )}

      {/* Form: Bookkeeping */}
      {showBk && (
        <div style={{ background:'#fff', borderRadius:14, padding:20, border:'2px solid #1a6b4a', marginBottom:16 }}>
          <h3 style={{ fontFamily:'Georgia,serif', fontSize:15, color:'#0f2340', margin:'0 0 14px' }}>
            📚 Contrato bookkeeping mensal — {clientName}
          </h3>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:12, marginBottom:12 }}>
            <div>
              <label style={label}>Valor mensal ($)</label>
              <input type="number" value={monthly} onChange={e => setMonthly(e.target.value)} min={1} style={{ ...input, width:'100%' }} />
            </div>
            <div>
              <label style={label}>Descrição</label>
              <input value={descBk} onChange={e => setDescBk(e.target.value)} style={{ ...input, width:'100%' }} />
            </div>
          </div>
          <p style={{ fontSize:13, color:'#1a6b4a', background:'#e8f5ee', borderRadius:8, padding:'10px 14px', marginBottom:12 }}>
            📅 Cobrança automática <strong>todo dia 5</strong>. O cliente autoriza o débito (cartão ou conta bancária) no link de assinatura. Sem prazo final — até cancelamento.
          </p>
          <button onClick={createBookkeeping} disabled={busy || !monthly} style={btn('#1a6b4a', busy || !monthly)}>
            {busy ? 'Criando…' : 'Criar contrato'}
          </button>
        </div>
      )}

      {msg && (
        <p style={{ fontSize:13, fontWeight:600, marginBottom:12,
          color: msg.startsWith('✓') ? '#1a6b4a' : '#b02020' }}>{msg}</p>
      )}

      {/* Lista */}
      {loading ? <p style={{ color:'#6a7a9a', fontSize:13 }}>Carregando…</p> :
       plans.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:14, padding:40, border:'1px solid #e2e8f4', textAlign:'center', color:'#9aaab0' }}>
          <div style={{ fontSize:32, marginBottom:8 }}>📆</div>
          <div style={{ fontSize:13 }}>Nenhum plano ainda.</div>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          {plans.map(p => (
            <div key={p.id} style={{ background:'#fff', borderRadius:14, padding:18, border:'1px solid #e2e8f4' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10, flexWrap:'wrap', gap:8 }}>
                <div>
                  <span style={{ fontSize:15, fontWeight:700, color:'#0f2340' }}>
                    {p.kind === 'installment' ? '📆 Parcelamento' : '📚 Bookkeeping mensal'}
                  </span>
                  <span style={{ marginLeft:10, fontSize:11, padding:'2px 10px', borderRadius:20, fontWeight:700,
                    background:`${STATUS_COLOR[p.status]}18`, color:STATUS_COLOR[p.status] }}>
                    {STATUS_LABEL[p.status] || p.status}
                  </span>
                </div>
                <span style={{ fontSize:20, fontWeight:800, color:'#2D3278' }}>
                  {p.kind === 'installment' ? money(p.total) : `${money(p.monthly_amount)}/mês`}
                </span>
              </div>

              {p.description && <p style={{ fontSize:13, color:'#5a6a7a', margin:'0 0 10px' }}>{p.description}</p>}

              <div style={{ background:'#f8faff', borderRadius:10, padding:'10px 14px', marginBottom:12, fontSize:13, color:'#3a4a5a', lineHeight:1.7 }}>
                {p.kind === 'installment' ? (
                  <>
                    Entrada: <strong>{money(p.entry_amount)} ({p.entry_pct}%)</strong>
                    {p.entry_paid_at && <span style={{ color:'#1a6b4a' }}> — paga ✓</span>}
                    <br/>Parcelas: <strong>{p.paid_installments}/{p.installments} pagas</strong> de {money(p.installment_amount)} ({FREQ_LABEL[p.frequency||''] || p.frequency})
                    {p.next_charge_date && p.status === 'active' && (
                      <><br/>Próximo débito: <strong>{new Date(p.next_charge_date+'T12:00:00Z').toLocaleDateString('pt-BR')}</strong></>
                    )}
                  </>
                ) : (
                  <>
                    Vencimento: <strong>todo dia {p.due_day}</strong> · Mensalidades pagas: <strong>{p.paid_installments}</strong>
                    {p.next_charge_date && <><br/>Primeira cobrança: <strong>{new Date(p.next_charge_date+'T12:00:00Z').toLocaleDateString('pt-BR')}</strong></>}
                  </>
                )}
                {p.status === 'cancelled' && p.cancel_reason && (
                  <><br/><span style={{ color:'#b02020' }}>Cancelado: {p.cancel_reason}</span></>
                )}
              </div>

              {canManage && (
                <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                  {['draft','awaiting_entry','awaiting_setup'].includes(p.status) && (
                    <button onClick={() => genLink(p.id)} disabled={busy} style={btn('#F47B20', busy)}>
                      {p.kind === 'installment' ? '💳 Link da entrada' : '💳 Link de assinatura'}
                    </button>
                  )}
                  {p.kind === 'bookkeeping' && ['active','payment_failed'].includes(p.status) && (
                    <button onClick={() => { setPauseTarget({ id: p.id, action:'pause' }); setPauseReason('') }} style={outlineBtn('#c06010')}>
                      ⏸️ Pausar
                    </button>
                  )}
                  {p.kind === 'bookkeeping' && p.status === 'paused' && (
                    <button onClick={() => { setPauseTarget({ id: p.id, action:'resume' }); setPauseReason('') }} style={btn('#1a6b4a')}>
                      ▶️ Retomar
                    </button>
                  )}
                  {!['completed','cancelled'].includes(p.status) && (
                    <button onClick={() => { setCancelId(p.id); setCancelReason('') }} style={outlineBtn('#b02020')}>
                      🚫 Cancelar plano
                    </button>
                  )}
                  <span style={{ fontSize:11, color:'#9aaab0', marginLeft:'auto', alignSelf:'center' }}>
                    Criado em {new Date(p.created_at).toLocaleDateString('pt-BR')}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Modal pausa/retomada */}
      {pauseTarget && (
        <div style={{ position:'fixed', inset:0, background:'rgba(15,35,64,0.5)', display:'flex',
          alignItems:'center', justifyContent:'center', zIndex:2000 }}>
          <div style={{ background:'#fff', borderRadius:16, padding:24, width:400, maxWidth:'90vw' }}>
            <h3 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:'0 0 6px' }}>
              {pauseTarget.action === 'pause' ? '⏸️ Pausar contrato' : '▶️ Retomar contrato'}
            </h3>
            <p style={{ fontSize:13, color:'#6a7a9a', margin:'0 0 14px' }}>
              {pauseTarget.action === 'pause'
                ? 'As cobranças do dia 5 ficam suspensas até retomar. O contrato é preservado.'
                : 'As cobranças mensais do dia 5 voltam a ocorrer normalmente.'}
            </p>
            <label style={label}>Motivo *</label>
            <textarea value={pauseReason} onChange={e => setPauseReason(e.target.value)} rows={2}
              style={{ ...input, width:'100%', resize:'vertical' as const, marginBottom:12 }} />
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={() => setPauseTarget(null)} style={outlineBtn('#6a7a9a')}>Voltar</button>
              <button onClick={doPause} disabled={busy}
                style={btn(pauseTarget.action === 'pause' ? '#c06010' : '#1a6b4a', busy)}>
                {busy ? 'Processando…' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de cancelamento */}
      {cancelId && (
        <div style={{ position:'fixed', inset:0, background:'rgba(15,35,64,0.5)', display:'flex',
          alignItems:'center', justifyContent:'center', zIndex:2000 }}>
          <div style={{ background:'#fff', borderRadius:16, padding:24, width:400, maxWidth:'90vw' }}>
            <h3 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:'0 0 6px' }}>🚫 Cancelar plano</h3>
            <p style={{ fontSize:13, color:'#6a7a9a', margin:'0 0 14px' }}>
              As cobranças futuras serão interrompidas no Stripe. O motivo fica na auditoria.
            </p>
            <label style={label}>Motivo *</label>
            <textarea value={cancelReason} onChange={e => setCancelReason(e.target.value)} rows={2}
              style={{ ...input, width:'100%', resize:'vertical' as const, marginBottom:12 }} />
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={() => setCancelId(null)} style={outlineBtn('#6a7a9a')}>Voltar</button>
              <button onClick={doCancel} disabled={busy} style={btn('#b02020', busy)}>
                {busy ? 'Cancelando…' : 'Confirmar cancelamento'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
