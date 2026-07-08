'use client'
// /dashboard/bookkeeping — Central de Bookkeeping
// Visão de todos os clientes: 🔴 Sem começar · 🟠 Em aberto · ✅ Pronto

import { useState, useEffect } from 'react'
import Link from 'next/link'

const WORK_LABEL: Record<string, string> = {
  sem_comecar: '🔴 Sem começar', em_aberto: '🟠 Em aberto', pronto: '✅ Pronto',
}
const WORK_COLOR: Record<string, string> = {
  sem_comecar: '#b02020', em_aberto: '#c06010', pronto: '#1a6b4a',
}
const CONTRACT_LABEL: Record<string, string> = {
  active: 'Ativo', paused: '⏸️ Pausado', payment_failed: '⚠️ Débito falhou',
}

export default function BookkeepingCentral() {
  const [data, setData] = useState<any>(null)
  const [filter, setFilter] = useState<string>('all')

  useEffect(() => {
    fetch('/api/bookkeeping/overview').then(r => r.json()).then(setData).catch(() => null)
  }, [])

  if (!data) return <p style={{ color:'#6a7a9a', fontSize:14 }}>Carregando…</p>

  const rows = (data.clients || []).filter((c: any) => filter === 'all' || c.workStatus === filter)

  const statCard = (key: string, label: string, value: number, color: string) => (
    <div key={key} onClick={() => setFilter(f => f === key ? 'all' : key)}
      style={{ cursor:'pointer', background: filter === key ? color : '#fff',
        color: filter === key ? '#fff' : '#0f2340',
        borderRadius:14, padding:'16px 20px', border:`2px solid ${color}`, minWidth:150, flex:1 }}>
      <div style={{ fontSize:30, fontWeight:800 }}>{value}</div>
      <div style={{ fontSize:13, fontWeight:700, marginTop:2, opacity:0.9 }}>{label}</div>
    </div>
  )

  return (
    <div>
      <h1 style={{ fontFamily:'Georgia,serif', fontSize:24, color:'#0f2340', margin:'0 0 4px' }}>
        📊 Central de Bookkeeping
      </h1>
      <p style={{ color:'#6a7a9a', fontSize:13.5, margin:'0 0 20px' }}>
        Todos os clientes de bookkeeping — clique num card para filtrar, e no cliente para trabalhar.
      </p>

      {/* Alertas de cobrança */}
      {(data.alerts || []).length > 0 && (
        <div style={{ background:'#fee2e2', border:'1.5px solid #b02020', borderRadius:12, padding:'12px 16px', marginBottom:18 }}>
          <div style={{ fontSize:13, fontWeight:800, color:'#b02020', marginBottom:6 }}>⚠️ Alertas de cobrança</div>
          {data.alerts.slice(0, 4).map((a: any) => (
            <div key={a.id} style={{ fontSize:12.5, color:'#7a1a1a', padding:'3px 0' }}>{a.message}</div>
          ))}
        </div>
      )}

      {/* Cards de status */}
      <div style={{ display:'flex', gap:12, marginBottom:22, flexWrap:'wrap' }}>
        {statCard('em_aberto', '🟠 Em aberto (para revisar)', data.counts.em_aberto, '#c06010')}
        {statCard('sem_comecar', '🔴 Sem começar', data.counts.sem_comecar, '#b02020')}
        {statCard('pronto', '✅ Pronto', data.counts.pronto, '#1a6b4a')}
      </div>

      {/* Tabela */}
      <div style={{ background:'#fff', borderRadius:14, border:'1px solid #e2e8f4', overflow:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', minWidth:820 }}>
          <thead><tr style={{ background:'#f8faff' }}>
            {['Cliente','Status','Contrato','Para revisar','No registro',`Transações ${data.year}`,''].map(h =>
              <th key={h} style={{ padding:'11px 16px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, borderBottom:'1px solid #e2e8f4' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} style={{ padding:30, textAlign:'center', color:'#9aaab0', fontSize:13 }}>
                Nenhum cliente {filter !== 'all' ? 'neste status' : 'de bookkeeping ainda'}.
              </td></tr>
            ) : rows.map((c: any) => (
              <tr key={c.clientId} style={{ borderBottom:'1px solid #f0f4fa' }}>
                <td style={{ padding:'12px 16px', fontSize:14, fontWeight:700, color:'#0f2340' }}>{c.name}</td>
                <td style={{ padding:'12px 16px' }}>
                  <span style={{ fontSize:12, padding:'3px 12px', borderRadius:20, fontWeight:800,
                    background:`${WORK_COLOR[c.workStatus]}15`, color:WORK_COLOR[c.workStatus] }}>
                    {WORK_LABEL[c.workStatus]}
                  </span>
                </td>
                <td style={{ padding:'12px 16px', fontSize:12.5, color:'#3a4a5a' }}>
                  {c.contract
                    ? <>${Number(c.contract.monthly).toFixed(0)}/mês · {CONTRACT_LABEL[c.contract.status] || c.contract.status}</>
                    : <span style={{ color:'#9aaab0' }}>sem contrato</span>}
                </td>
                <td style={{ padding:'12px 16px', fontSize:15, fontWeight:800, color: c.forReview > 0 ? '#c06010' : '#c9d2e0' }}>
                  {c.forReview}
                </td>
                <td style={{ padding:'12px 16px', fontSize:15, fontWeight:800, color:'#1a6b4a' }}>{c.inRegister}</td>
                <td style={{ padding:'12px 16px', fontSize:13, fontWeight:700,
                  color: c.yearLimit && c.yearCount > c.yearLimit ? '#b02020' : '#2D3278' }}>
                  {c.yearCount}{c.yearLimit ? ` / ${c.yearLimit}` : ''}
                  {c.yearLimit && c.yearCount > c.yearLimit && ' ⚠️'}
                </td>
                <td style={{ padding:'12px 16px' }}>
                  <Link href={`/clients/${c.clientId}`}
                    style={{ background:'#2D3278', color:'#fff', padding:'8px 16px', borderRadius:8, fontSize:12.5, fontWeight:700, textDecoration:'none', whiteSpace:'nowrap' as const }}>
                    Trabalhar →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
