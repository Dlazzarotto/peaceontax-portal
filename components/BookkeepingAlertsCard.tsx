'use client'
// Card do dashboard: transações em aberto + alertas de débito
import { useState, useEffect } from 'react'
import Link from 'next/link'

export default function BookkeepingAlertsCard() {
  const [data, setData] = useState<any>(null)
  useEffect(() => {
    fetch('/api/bookkeeping/alerts').then(r => r.json()).then(setData).catch(() => null)
  }, [])

  if (!data || (data.totalOpen === 0 && (data.planAlerts || []).length === 0)) return null

  return (
    <div style={{ background:'#fff', borderRadius:14, padding:20, border:'2px solid #F47B20', marginBottom:20 }}>
      <h2 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:'0 0 12px' }}>
        ⚠️ Pendências de bookkeeping
      </h2>

      {data.totalOpen > 0 && (
        <>
          <p style={{ fontSize:13, fontWeight:700, color:'#c06010', margin:'0 0 8px' }}>
            {data.totalOpen} transações aguardando categorização:
          </p>
          <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:12 }}>
            {data.openTransactions.slice(0, 5).map((c: any) => (
              <Link key={c.clientId} href={`/clients/${c.clientId}`} style={{ textDecoration:'none' }}>
                <div style={{ display:'flex', justifyContent:'space-between', padding:'8px 12px', background:'#fff7e0', borderRadius:8, fontSize:13 }}>
                  <span style={{ color:'#1a2a3a', fontWeight:600 }}>{c.name}</span>
                  <span style={{ color:'#c06010', fontWeight:800 }}>{c.count} em aberto →</span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      {(data.planAlerts || []).length > 0 && (
        <>
          <p style={{ fontSize:13, fontWeight:700, color:'#b02020', margin:'0 0 8px' }}>
            Alertas de cobrança:
          </p>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {data.planAlerts.slice(0, 5).map((a: any) => (
              <div key={a.id} style={{ padding:'8px 12px', background:'#fee2e2', borderRadius:8, fontSize:12.5, color:'#7a1a1a' }}>
                {a.message}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
