'use client'
// Listas → Fornecedores e clientes
// Visão de todos os clientes. Para trocar a conta contábil em massa,
// o caminho é o bookkeeping do cliente (aba 🏪 Payees), onde aparecem
// os números de uso de cada um.

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface Payee { id: string; name: string; type: string; clientId: string; cliente: string }

export default function PayeesPage() {
  const [payees, setPayees] = useState<Payee[]>([])
  const [busca, setBusca] = useState('')
  const [cliente, setCliente] = useState('all')
  const [tipo, setTipo] = useState('all')
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const d = await fetch('/api/bookkeeping/payees?all=1').then(r => r.json())
      if (d?.payees) setPayees(d.payees)
      else setMsg(`⚠️ ${d?.error || 'Não foi possível carregar.'}`)
    } catch (e) { setMsg(`⚠️ ${(e as Error).message}`) }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const patch = async (p: Payee, body: any, aviso: string) => {
    setBusy(true); setMsg('')
    const d = await fetch('/api/bookkeeping/payees', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: p.clientId, name: p.name, ...body }),
    }).then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${aviso}${d.message ? ` — ${d.message}` : ''}`)
    load()
  }

  const apagar = async (p: Payee) => {
    if (!confirm(`Apagar "${p.name}" do cadastro de ${p.cliente}?\n\nSe houver lançamentos com esse nome, o nome sai dos que ainda estão em aberto.`)) return
    setBusy(true); setMsg('')
    const url = `/api/bookkeeping/payees?clientId=${p.clientId}&name=${encodeURIComponent(p.name)}&limpar=1`
    const d = await fetch(url, { method: 'DELETE' }).then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`)
    load()
  }

  const clientes = Array.from(new Set(payees.map(p => p.cliente))).sort()
  const q = busca.trim().toLowerCase()
  const lista = payees
    .filter(p => cliente === 'all' || p.cliente === cliente)
    .filter(p => tipo === 'all' || p.type === tipo)
    .filter(p => !q || p.name.toLowerCase().includes(q) || p.cliente.toLowerCase().includes(q))

  const card: React.CSSProperties = { background: '#fff', border: '1px solid #E2E8F4', borderRadius: 16, padding: '18px 20px', marginBottom: 16 }
  const inp: React.CSSProperties = { padding: '10px 12px', border: '1.5px solid #E2E8F4', borderRadius: 9, fontSize: 14.5, outline: 'none' }

  return (
    <div style={{ maxWidth: 980 }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 28, color: '#0F2340', margin: '0 0 4px', fontWeight: 400 }}>
          Fornecedores e clientes
        </h1>
        <p style={{ fontSize: 14.5, color: '#6A7A9A', margin: 0, lineHeight: 1.5 }}>
          Cadastro de todos os clientes da firma. Para trocar a conta contábil de todos os
          lançamentos de um fornecedor, abra o bookkeeping do cliente — lá aparecem os números de uso.
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

      <div style={{ ...card, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar nome ou cliente"
          style={{ ...inp, flex: '1 1 240px' }} />
        <select value={cliente} onChange={e => setCliente(e.target.value)} style={{ ...inp, cursor: 'pointer', maxWidth: 240 }}>
          <option value="all">Todos os clientes</option>
          {clientes.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={tipo} onChange={e => setTipo(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
          <option value="all">Vendors e customers</option>
          <option value="vendor">Só vendors</option>
          <option value="customer">Só customers</option>
        </select>
        <span style={{ fontSize: 14, color: '#6A7A9A', fontWeight: 700 }}>{lista.length} de {payees.length}</span>
      </div>

      {loading ? <p style={{ fontSize: 15, color: '#6A7A9A' }}>Carregando…</p> : (
        <div style={{ ...card, overflowX: 'auto' as const }}>
          {lista.length === 0 ? (
            <p style={{ fontSize: 15, color: '#4A5A70', margin: 0 }}>Nenhum registro encontrado.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, minWidth: 680 }}>
              <thead><tr>
                {['Nome', 'Cliente', 'Tipo', ''].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '8px 10px', fontSize: 11, fontWeight: 800,
                    color: '#6A7A9A', textTransform: 'uppercase' as const, borderBottom: '1px solid #E2E8F4' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {lista.map(p => (
                  <tr key={p.id} style={{ borderBottom: '1px solid #F0F4FA' }}>
                    <td style={{ padding: '10px', fontSize: 15, fontWeight: 700, color: '#0F2340' }}>{p.name}</td>
                    <td style={{ padding: '10px', fontSize: 13.5 }}>
                      <Link href={`/clients/${p.clientId}`} style={{ color: '#2D3278', fontWeight: 700, textDecoration: 'none' }}>
                        {p.cliente}
                      </Link>
                    </td>
                    <td style={{ padding: '10px' }}>
                      <select value={p.type} disabled={busy}
                        onChange={e => patch(p, { type: e.target.value }, 'Tipo atualizado')}
                        style={{ padding: '6px 10px', border: '1.5px solid #E2E8F4', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', outline: 'none' }}>
                        <option value="vendor">🏪 Vendor</option>
                        <option value="customer">💰 Customer</option>
                      </select>
                    </td>
                    <td style={{ padding: '10px', whiteSpace: 'nowrap' as const }}>
                      <button onClick={() => {
                          const novo = window.prompt('Novo nome:', p.name)
                          if (novo && novo.trim() && novo.trim() !== p.name) patch(p, { newName: novo.trim() }, 'Renomeado')
                        }}
                        style={{ background: 'none', border: 'none', color: '#2D3278', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
                        Renomear
                      </button>
                      <button onClick={() => apagar(p)} disabled={busy}
                        style={{ background: 'none', border: 'none', color: '#B02020', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', marginLeft: 10 }}>
                        Apagar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <Link href="/dashboard/accounts" style={{ fontSize: 14.5, color: '#2D3278', fontWeight: 700, textDecoration: 'none' }}>
        Plano de contas →
      </Link>
    </div>
  )
}
