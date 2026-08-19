'use client'
// components/AtendimentoResumo.tsx — bloco do painel da equipe
// Some sozinho para quem não é sócio/gerente (a rota devolve 403).

import { useEffect, useState } from 'react'
import { waBrowser } from '@/lib/wa-browser'

export default function AtendimentoResumo() {
  const [r, setR] = useState<any>(null)
  const [visivel, setVisivel] = useState(true)

  useEffect(() => {
    let vivo = true
    const buscar = async () => {
      const { data } = await waBrowser.auth.getSession()
      const token = data.session?.access_token
      if (!token) return
      const res = await fetch('/api/whatsapp/conversations?filtro=ativas', {
        headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
      })
      if (res.status === 403) { if (vivo) setVisivel(false); return }
      const j = await res.json().catch(() => null)
      if (vivo && j?.resumo) setR(j.resumo)
    }
    buscar()
    const t = setInterval(() => { if (document.visibilityState === 'visible') buscar() }, 30000)
    return () => { vivo = false; clearInterval(t) }
  }, [])

  if (!visivel || !r) return null

  const urgente = (r.precisa_de_voce ?? 0) > 0
  return (
    <a href="/dashboard/atendimento" style={{
      display: 'block', textDecoration: 'none', background: '#fff',
      border: `2px solid ${urgente ? '#b3261e' : '#e3e5f0'}`,
      borderRadius: 16, padding: 20, color: '#1a1a1a',
    }}>
      <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '.4px', textTransform: 'uppercase', color: '#5b6070' }}>
        💬 Atendimento
      </div>
      <div style={{ fontSize: 34, fontWeight: 800, color: '#2D3278', marginTop: 8 }}>
        {r.esperando ?? 0} <span style={{ fontSize: 18, fontWeight: 700 }}>esperando resposta</span>
      </div>
      <div style={{ marginTop: 8, fontSize: 17, color: '#5b6070' }}>
        {r.comigo ?? 0} comigo · {r.bot ?? 0} com o bot
      </div>
      {urgente && (
        <div style={{ marginTop: 12, background: '#b3261e', color: '#fff', fontWeight: 800, padding: '10px 14px', borderRadius: 10, fontSize: 16 }}>
          {r.precisa_de_voce} parada(s) há mais de 30 minutos
        </div>
      )}
    </a>
  )
}
