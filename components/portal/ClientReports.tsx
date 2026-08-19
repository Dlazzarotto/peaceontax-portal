'use client'
import { useState } from 'react'

export default function ClientReports({ clientId, displayName }: {
  clientId: string
  displayName: string
}) {
  const thisYear = new Date().getFullYear()
  const [year, setYear] = useState(thisYear - 1)

  const open = (path: string, extra = '') => {
    window.open(`/api/bookkeeping/${path}?clientId=${clientId}&year=${year}${extra}`, '_blank')
  }

  const card = (accent: string): React.CSSProperties => ({
    display:'flex', alignItems:'center', gap:14, width:'100%', textAlign:'left' as const,
    padding:'18px 18px', background:'#fff', border:'1.5px solid #e2e8f4', borderLeft:`5px solid ${accent}`,
    borderRadius:12, fontSize:15.5, fontWeight:700, color:'#0f2340', cursor:'pointer', marginBottom:10,
  })

  return (
    <div style={{ maxWidth:760 }}>
      <h1 style={{ fontFamily:'Georgia,serif', fontSize:22, color:'#0f2340', margin:'0 0 4px' }}>
        📊 Contabilidade
      </h1>
      <p style={{ fontSize:13.5, color:'#6a7a9a', margin:'0 0 20px', lineHeight:1.55 }}>
        {displayName} · documentos gerados pela nossa equipe a partir dos lançamentos já revisados.
        Abrem em uma nova aba, prontos para <b>imprimir ou salvar em PDF</b>.
      </p>

      <div style={{ background:'#fff', borderRadius:14, padding:'14px 18px', border:'1px solid #e2e8f4', marginBottom:16,
        display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
        <span style={{ fontSize:13.5, fontWeight:700, color:'#4a5a70' }}>Ano fiscal:</span>
        <select value={year} onChange={e => setYear(Number(e.target.value))}
          style={{ padding:'11px 14px', border:'1.5px solid #e2e8f4', borderRadius:10, fontSize:15,
            fontWeight:700, color:'#0f2340', outline:'none', cursor:'pointer', background:'#fff' }}>
          {Array.from({ length: 7 }, (_, i) => thisYear - i).map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      <button onClick={() => open('pnl')} style={card('#2D3278')}>
        <span style={{ fontSize:22 }}>📈</span>
        <span style={{ flex:1 }}>
          Demonstrativo de Resultado (P&amp;L)
          <div style={{ fontSize:12, fontWeight:400, color:'#6a7a9a', marginTop:2 }}>
            Receitas, custos e despesas do ano
          </div>
        </span>
        <span style={{ color:'#9aaab0' }}>→</span>
      </button>

      <button onClick={() => open('balance-sheet')} style={card('#1a6b4a')}>
        <span style={{ fontSize:22 }}>⚖️</span>
        <span style={{ flex:1 }}>
          Balanço Patrimonial (Balance Sheet)
          <div style={{ fontSize:12, fontWeight:400, color:'#6a7a9a', marginTop:2 }}>
            O que a empresa tem, o que deve e o patrimônio no fim do período
          </div>
        </span>
        <span style={{ color:'#9aaab0' }}>→</span>
      </button>

      <button onClick={() => open('vendors', '&report=vendors')} style={card('#5a1a8a')}>
        <span style={{ fontSize:22 }}>🏪</span>
        <span style={{ flex:1 }}>
          Fornecedores e clientes
          <div style={{ fontSize:12, fontWeight:400, color:'#6a7a9a', marginTop:2 }}>
            Quanto foi pago a cada fornecedor e recebido de cada cliente
          </div>
        </span>
        <span style={{ color:'#9aaab0' }}>→</span>
      </button>

      <button onClick={() => open('vendors', '&report=1099')} style={card('#8a4a0a')}>
        <span style={{ fontSize:22 }}>📋</span>
        <span style={{ flex:1 }}>
          1099 — prestadores de serviço
          <div style={{ fontSize:12, fontWeight:400, color:'#6a7a9a', marginTop:2 }}>
            Quem recebeu US$ 600 ou mais em serviços no ano
          </div>
        </span>
        <span style={{ color:'#9aaab0' }}>→</span>
      </button>

      <p style={{ fontSize:12, color:'#9aaab0', lineHeight:1.6, marginTop:18 }}>
        Os relatórios são somente para consulta e refletem o que já foi conferido e lançado nos livros —
        movimentações recentes em revisão podem não aparecer. Encontrou algo que precisa de ajuste?
        Fale com a gente pelo chat que nossa equipe corrige.
      </p>
    </div>
  )
}
