'use client'
// components/ContratosDoCliente.tsx — os contratos de UM cliente, na ficha dele
//
// Era a aba "📆 Planos" (components/PlansTab.tsx), um segundo cadastro do
// mesmo acordo: os planos cobravam, os contratos do Financeiro tinham a regra
// (itens, desconto, prazo, intervalo) — decisão do sócio: juntar e eliminar
// os planos. Agora o contrato mora num lugar só, Financeiro → Contratos, e
// aqui ele só APARECE: criar, editar, ativar, pausar e encerrar são de lá,
// onde a trava é uma só. Duas telas que mexem no mesmo acordo divergem no
// primeiro ajuste — foi assim que os dois cadastros nasceram.
//
// A lista vem da MESMA rota da aba do Financeiro (/api/billing/contratos),
// com o mesmo escopo por tipo: quem não pode abrir empresa não vê o contrato
// dela aqui também.

import { useEffect, useState } from 'react'
import { money, fmtUS } from '@/lib/format'
import { porPeriodo } from '@/lib/contrato-unico'

export default function ContratosDoCliente({ clientId }: { clientId: string }) {
  const [contratos, setContratos] = useState<any[] | null>(null)
  const [erro, setErro] = useState('')

  useEffect(() => {
    let vivo = true
    fetch('/api/billing/contratos')
      .then(r => r.json().catch(() => ({ error: `Resposta inválida (${r.status})` })))
      .then(d => {
        if (!vivo) return
        // O erro vem PRIMEIRO: "não tem contrato" é uma afirmação, e consulta
        // que falha não pode virar afirmação.
        if (d?.error) { setErro(d.error); return }
        setContratos((d?.contratos || []).filter((c: any) => c.client_id === clientId))
      })
      .catch(e => vivo && setErro(String(e)))
    return () => { vivo = false }
  }, [clientId])

  const link = `/dashboard/billing?aba=contratos&cliente=${clientId}`
  return (
    <div style={{ background: '#fff', borderRadius: 14, padding: 22, border: '1px solid #e2e8f4' }}>
      <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 17, color: '#0f2340', margin: '0 0 6px', fontWeight: 400 }}>
        Contratos recorrentes
      </h3>
      <p style={{ fontSize: 13.5, color: '#4a5a70', margin: '0 0 14px', lineHeight: 1.55 }}>
        Ficam num lugar só: o Financeiro → Contratos. Lá se cria, edita, ativa, pausa e encerra — por
        fatura do sistema ou débito automático, mensal, trimestral ou anual. Parcelamento de fatura fica
        em Financeiro → Parcelamentos.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <a href={link}
          style={{ padding: '10px 18px', background: '#1A6B4A', color: '#fff', borderRadius: 10, fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>
          📆 Novo contrato
        </a>
        <a href={link}
          style={{ padding: '10px 18px', background: '#f0f4fa', color: '#2D3278', border: '1px solid #e2e8f4', borderRadius: 10, fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>
          Abrir os contratos deste cliente
        </a>
        <a href="/dashboard/billing?aba=parcelamentos"
          style={{ padding: '10px 18px', background: '#f0f4fa', color: '#2D3278', border: '1px solid #e2e8f4', borderRadius: 10, fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>
          Parcelamentos
        </a>
      </div>

      {erro && <div style={{ fontSize: 13.5, fontWeight: 700, color: '#b02020' }}>⚠️ {erro}</div>}
      {!erro && contratos === null && <div style={{ fontSize: 13.5, color: '#6a7a9a' }}>Carregando…</div>}
      {!erro && contratos && contratos.length === 0 && (
        <div style={{ fontSize: 13.5, color: '#6a7a9a' }}>Este cliente não tem contrato recorrente.</div>
      )}
      {!erro && contratos && contratos.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {contratos.map((c: any) => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
              padding: '10px 14px', borderRadius: 10, background: '#f8faff', border: '1px solid #e2e8f4',
              opacity: ['concluído', 'encerrado'].includes(c.situacao) ? 0.6 : 1 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#0f2340' }}>{c.description}</div>
                <div style={{ fontSize: 12.5, color: '#6a7a9a' }}>
                  {c.collection_method === 'fatura' ? 'fatura' : 'débito'} · dia {c.due_day}
                  {c.next_charge_date && !['concluído', 'encerrado'].includes(c.situacao) ? ` · próxima ${fmtUS(c.next_charge_date)}` : ''}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#2D3278' }}>
                  {money(c.monthly_amount)}<span style={{ fontSize: 12, fontWeight: 600, color: '#6a7a9a' }}>{porPeriodo(c.billing_interval)}</span>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: c.situacao === 'ativo' ? '#1a6b4a' : '#c06010' }}>{c.situacao}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
