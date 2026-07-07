'use client'
// /dashboard/pricing — Tabela de Preços (SÓ OWNER)
// Edita valores do cotador automático e cria itens do catálogo para cotações manuais.

import { useState, useEffect } from 'react'

interface Item {
  id: string; code: string; label: string; amount: number
  kind: string; active: boolean; sort: number
}

const KIND_LABEL: Record<string,string> = {
  base_single:'Base — Solteiro', base_married:'Base — Casado',
  per_unit:'Por unidade', fixed:'Valor fixo', discount:'🏷 Desconto (exige PIN)',
}

export default function PricingPage() {
  const [items,   setItems]   = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [denied,  setDenied]  = useState(false)
  const [msg,     setMsg]     = useState('')
  const [editing, setEditing] = useState<Record<string, { label: string; amount: string; kind: string }>>({})

  // Novo item
  const [newLabel,  setNewLabel]  = useState('')
  const [newAmount, setNewAmount] = useState('')
  const [newKind,   setNewKind]   = useState('fixed')
  const [creating,  setCreating]  = useState(false)

  const load = async () => {
    setLoading(true)
    const r = await fetch('/api/pricing')
    const d = await r.json()
    if (r.status === 403) { setDenied(true); setLoading(false); return }
    setItems(d.items || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const startEdit = (it: Item) =>
    setEditing(e => ({ ...e, [it.id]: { label: it.label, amount: String(it.amount), kind: it.kind } }))

  const save = async (id: string) => {
    const e = editing[id]
    if (!e) return
    setMsg('')
    const r = await fetch('/api/pricing', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, label: e.label, amount: Number(e.amount), kind: e.kind }),
    })
    const d = await r.json()
    if (d.ok) {
      setMsg('✓ Item atualizado — vale para cotações novas a partir de agora.')
      setEditing(ed => { const c = { ...ed }; delete c[id]; return c })
      load()
    } else setMsg(`Erro: ${d.error}`)
  }

  const toggleActive = async (it: Item) => {
    setMsg('')
    const r = await fetch('/api/pricing', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: it.id, active: !it.active }),
    })
    const d = await r.json()
    if (d.ok) { setMsg(`✓ ${it.label} ${it.active ? 'desativado' : 'ativado'}.`); load() }
    else setMsg(`Erro: ${d.error}`)
  }

  const create = async () => {
    setMsg(''); setCreating(true)
    const r = await fetch('/api/pricing', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: newLabel, amount: Number(newAmount), kind: newKind }),
    })
    const d = await r.json()
    if (d.ok) { setMsg('✓ Item criado.'); setNewLabel(''); setNewAmount(''); load() }
    else setMsg(`Erro: ${d.error}`)
    setCreating(false)
  }

  const input = { padding:'8px 10px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }
  const btn = (bg: string, disabled = false) => ({
    padding:'7px 14px', background: disabled ? '#e2e8f4' : bg,
    color: disabled ? '#9aaab0' : '#fff', border:'none', borderRadius:8,
    fontSize:12, fontWeight:700, cursor: disabled ? 'not-allowed' : 'pointer',
  })

  if (denied) return (
    <div style={{ padding:40, textAlign:'center', color:'#b02020', fontSize:15 }}>
      🔒 Acesso restrito ao owner.
    </div>
  )

  return (
    <div style={{ maxWidth:820 }}>
      <h1 style={{ fontFamily:'Georgia,serif', fontSize:24, color:'#0f2340', marginBottom:6 }}>💲 Tabela de Preços</h1>
      <p style={{ fontSize:13, color:'#6a7a9a', marginBottom:20 }}>
        Alterações valem imediatamente para cotações novas. Cotações já enviadas ou pagas não mudam.
      </p>

      {msg && (
        <p style={{ fontSize:13, fontWeight:600, marginBottom:14,
          color: msg.startsWith('✓') ? '#1a6b4a' : '#b02020' }}>{msg}</p>
      )}

      {/* Criar item */}
      <div style={{ background:'#fff', borderRadius:14, padding:18, border:'1px solid #e2e8f4', marginBottom:18 }}>
        <h2 style={{ fontFamily:'Georgia,serif', fontSize:15, color:'#0f2340', margin:'0 0 12px' }}>+ Novo item de cobrança</h2>
        <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'center' }}>
          <input placeholder="Descrição (ex.: Annual Report)" value={newLabel}
            onChange={e => setNewLabel(e.target.value)} style={{ ...input, flex:1, minWidth:220 }} />
          <span style={{ color:'#6a7a9a' }}>$</span>
          <input type="number" placeholder="0.00" value={newAmount} min={0} step={5}
            onChange={e => setNewAmount(e.target.value)} style={{ ...input, width:100, textAlign:'right' as const }} />
          <select value={newKind} onChange={e => setNewKind(e.target.value)} style={input}>
            <option value="fixed">Valor fixo</option>
            <option value="per_unit">Por unidade</option>
            <option value="discount">Desconto (exige PIN)</option>
          </select>
          <button onClick={create} disabled={creating || !newLabel.trim() || newAmount === ''}
            style={btn('#2D3278', creating || !newLabel.trim() || newAmount === '')}>
            {creating ? 'Criando…' : 'Criar'}
          </button>
        </div>
      </div>

      {/* Lista */}
      {loading ? <p style={{ color:'#6a7a9a', fontSize:13 }}>Carregando…</p> : (
        <div style={{ background:'#fff', borderRadius:14, border:'1px solid #e2e8f4', overflow:'hidden' }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ background:'#f8faff' }}>
                {['Item','Tipo','Valor','Status',''].map(h => (
                  <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, borderBottom:'1px solid #e2e8f4' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map(it => {
                const ed = editing[it.id]
                return (
                  <tr key={it.id} style={{ borderBottom:'1px solid #f0f4fa', opacity: it.active ? 1 : 0.5 }}>
                    <td style={{ padding:'10px 14px' }}>
                      {ed ? (
                        <input value={ed.label}
                          onChange={e => setEditing(x => ({ ...x, [it.id]: { ...ed, label: e.target.value } }))}
                          style={{ ...input, width:'100%' }} />
                      ) : (
                        <span style={{ fontSize:13.5, fontWeight:600, color:'#1a2a3a' }}>
                          {it.kind === 'discount' ? '🏷 ' : ''}{it.label}
                        </span>
                      )}
                    </td>
                    <td style={{ padding:'10px 14px', fontSize:12, color:'#6a7a9a' }}>
                      {ed && !['base_single','base_married'].includes(it.kind) ? (
                        <select value={ed.kind}
                          onChange={e => setEditing(x => ({ ...x, [it.id]: { ...ed, kind: e.target.value } }))}
                          style={{ ...input, fontSize:12, fontWeight:700, cursor:'pointer' }}>
                          <option value="fixed">Fixo</option>
                          <option value="per_unit">Por unidade</option>
                          <option value="discount">Desconto</option>
                        </select>
                      ) : (KIND_LABEL[it.kind] || it.kind)}
                    </td>
                    <td style={{ padding:'10px 14px' }}>
                      {ed ? (
                        <input type="number" value={ed.amount} min={0} step={5}
                          onChange={e => setEditing(x => ({ ...x, [it.id]: { ...ed, amount: e.target.value } }))}
                          style={{ ...input, width:90, textAlign:'right' as const }} />
                      ) : (
                        <span style={{ fontSize:14, fontWeight:800, color:'#2D3278' }}>${Number(it.amount).toFixed(2)}</span>
                      )}
                    </td>
                    <td style={{ padding:'10px 14px' }}>
                      <span style={{ fontSize:11, padding:'2px 8px', borderRadius:20, fontWeight:700,
                        background: it.active ? '#e8f5ee' : '#f0f4fa', color: it.active ? '#1a6b4a' : '#6a7a9a' }}>
                        {it.active ? 'Ativo' : 'Inativo'}
                      </span>
                    </td>
                    <td style={{ padding:'10px 14px' }}>
                      <div style={{ display:'flex', gap:6, justifyContent:'flex-end' }}>
                        {ed ? (
                          <>
                            <button onClick={() => save(it.id)} style={btn('#1a6b4a')}>Salvar</button>
                            <button onClick={() => setEditing(x => { const c={...x}; delete c[it.id]; return c })}
                              style={{ ...btn('#fff'), color:'#6a7a9a', border:'1px solid #e2e8f4' }}>Cancelar</button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => startEdit(it)}
                              style={{ ...btn('#fff'), color:'#2D3278', border:'1px solid #2D3278' }}>✏️ Editar</button>
                            <button onClick={() => toggleActive(it)}
                              style={{ ...btn('#fff'), color: it.active ? '#b02020' : '#1a6b4a',
                                border:`1px solid ${it.active ? '#fdd' : '#cfe8d8'}` }}>
                              {it.active ? 'Desativar' : 'Ativar'}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
