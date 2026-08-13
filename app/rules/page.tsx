'use client'
// Biblioteca de regras gerais — as que valem para todos os clientes.
// Aqui a equipe edita, corrige e apaga. Regras de um cliente específico
// continuam na aba Regras dentro do cliente.

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface Rule {
  id: string; name: string; pattern: string; category: string
  direction: string; match_type: string; payee: string | null; priority: number
}

const DIR: Record<string, string> = { in: 'Entradas', out: 'Saídas', both: 'Entradas e saídas' }

export default function GlobalRulesPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [busca, setBusca] = useState('')
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [edit, setEdit] = useState<Rule | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const d = await fetch('/api/bookkeeping/rules?scope=global').then(r => r.json())
      if (d?.rules) setRules(d.rules)
      else setMsg(`Não foi possível carregar: ${d?.error || 'erro desconhecido'}`)
    } catch (e) { setMsg((e as Error).message) }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const salvar = async () => {
    if (!edit) return
    setBusy(true); setMsg('')
    const d = await fetch('/api/bookkeeping/rules', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: edit.id, name: edit.name, pattern: edit.pattern,
        category: edit.category, direction: edit.direction,
        matchType: edit.match_type, payee: edit.payee,
      }),
    }).then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg('✓ Regra atualizada.')
    setEdit(null); load()
  }

  const apagar = async (r: Rule) => {
    if (!confirm(`Apagar a regra geral "${r.name}"?\n\nEla deixa de valer para todos os clientes. As categorias já aplicadas continuam como estão.`)) return
    setBusy(true); setMsg('')
    const d = await fetch(`/api/bookkeeping/rules?id=${r.id}`, { method: 'DELETE' })
      .then(x => x.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ Regra "${r.name}" apagada.`)
    load()
  }

  const q = busca.trim().toLowerCase()
  const lista = rules.filter(r => !q ||
    [r.name, r.pattern, r.category, r.payee].some(v => String(v || '').toLowerCase().includes(q)))

  const card: React.CSSProperties = { background: '#fff', border: '1px solid #E2E8F4', borderRadius: 16, padding: '18px 20px', marginBottom: 16 }
  const inp: React.CSSProperties = { padding: '10px 12px', border: '1.5px solid #E2E8F4', borderRadius: 9, fontSize: 14.5, outline: 'none' }
  const btn = (bg: string, off = false): React.CSSProperties => ({
    padding: '9px 15px', background: off ? '#E2E8F4' : bg, color: off ? '#9AAAB0' : '#fff',
    border: 'none', borderRadius: 9, fontSize: 13.5, fontWeight: 700, cursor: off ? 'not-allowed' : 'pointer',
  })

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 28, color: '#0F2340', margin: '0 0 4px', fontWeight: 400 }}>
          Regras gerais
        </h1>
        <p style={{ fontSize: 14.5, color: '#6A7A9A', margin: 0, lineHeight: 1.5 }}>
          Valem para todos os clientes comuns. Organizações sem fins lucrativos não usam estas regras —
          cada uma tem as suas. Dentro de um cliente, uma regra própria com o mesmo texto <b>sobrepõe</b> a geral.
        </p>
      </div>

      {msg && (
        <div style={{
          marginBottom: 14, padding: '12px 16px', borderRadius: 10, fontSize: 14.5, fontWeight: 700,
          background: msg.startsWith('✓') ? '#E8F5EE' : '#FEE2E2',
          color: msg.startsWith('✓') ? '#1A6B4A' : '#B02020',
        }}>
          {msg}
          <button onClick={() => setMsg('')} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, color: 'inherit', fontWeight: 800 }}>✕</button>
        </div>
      )}

      <div style={{ ...card, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input value={busca} onChange={e => setBusca(e.target.value)}
          placeholder="Buscar por texto, categoria ou payee"
          style={{ ...inp, flex: '1 1 260px' }} />
        <span style={{ fontSize: 14, color: '#6A7A9A', fontWeight: 700 }}>
          {lista.length} de {rules.length}
        </span>
      </div>

      {loading ? <p style={{ fontSize: 15, color: '#6A7A9A' }}>Carregando…</p> : (
        <div style={card}>
          {lista.length === 0 ? (
            <p style={{ fontSize: 15, color: '#4A5A70', margin: 0 }}>Nenhuma regra encontrada.</p>
          ) : lista.map(r => (
            <div key={r.id} style={{ padding: '13px 0', borderTop: '1px solid #F0F4FA' }}>
              {edit?.id === r.id ? (
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })}
                      placeholder="Nome" style={{ ...inp, flex: '1 1 180px' }} />
                    <input value={edit.category} onChange={e => setEdit({ ...edit, category: e.target.value })}
                      placeholder="Categoria" style={{ ...inp, flex: '1 1 180px' }} />
                  </div>
                  <input value={edit.pattern} onChange={e => setEdit({ ...edit, pattern: e.target.value })}
                    placeholder="Texto (separe variações com | )" style={inp} />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <select value={edit.direction} onChange={e => setEdit({ ...edit, direction: e.target.value })}
                      style={{ ...inp, cursor: 'pointer' }}>
                      <option value="out">Saídas</option>
                      <option value="in">Entradas</option>
                      <option value="both">Entradas e saídas</option>
                    </select>
                    <input value={edit.payee || ''} onChange={e => setEdit({ ...edit, payee: e.target.value })}
                      placeholder="Payee" style={{ ...inp, flex: '1 1 160px' }} />
                    <button onClick={salvar} disabled={busy} style={btn('#1A6B4A', busy)}>Salvar</button>
                    <button onClick={() => setEdit(null)} style={btn('#6A7A9A')}>Cancelar</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                    <div style={{ fontSize: 15.5, fontWeight: 700, color: '#0F2340' }}>{r.name}</div>
                    <div style={{ fontSize: 13.5, color: '#6A7A9A', marginTop: 2 }}>
                      contém <b style={{ color: '#4A5A70' }}>{r.pattern}</b> · {DIR[r.direction] || r.direction}
                      {r.payee ? ` · ${r.payee}` : ''}
                    </div>
                  </div>
                  <span style={{ fontSize: 13.5, fontWeight: 800, color: '#2D3278', background: '#2D327812', padding: '5px 11px', borderRadius: 20 }}>
                    {r.category}
                  </span>
                  <button onClick={() => setEdit(r)} style={{ background: 'none', border: 'none', color: '#2D3278', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
                    Editar
                  </button>
                  <button onClick={() => apagar(r)} disabled={busy} style={{ background: 'none', border: 'none', color: '#B02020', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
                    Apagar
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Link href="/dashboard" style={{ fontSize: 14.5, color: '#2D3278', fontWeight: 700, textDecoration: 'none' }}>
        ← Voltar ao painel
      </Link>
    </div>
  )
}
