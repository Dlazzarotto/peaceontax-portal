'use client'
// /portal/bank — cliente conecta contas bancárias via Plaid Link
// Mobile-first: botões grandes, textos claros, PT como padrão.

import { useState, useEffect } from 'react'
import Script from 'next/script'

declare global { interface Window { Plaid: any } }

export default function BankConnectPage() {
  const [items, setItems] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [plaidReady, setPlaidReady] = useState(false)

  const load = () => fetch('/api/plaid/items').then(r => r.json()).then(d => setItems(d.items || []))
  useEffect(() => { load() }, [])

  const connect = async () => {
    setBusy(true); setMsg('')
    try {
      const r = await fetch('/api/plaid/link-token', { method: 'POST' }).then(x => x.json())
      if (!r.linkToken) { setMsg(`Erro: ${r.error || 'não foi possível iniciar'}`); setBusy(false); return }

      const handler = window.Plaid.create({
        token: r.linkToken,
        onSuccess: async (publicToken: string, metadata: any) => {
          setMsg('Conectando sua conta…')
          const ex = await fetch('/api/plaid/exchange', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              publicToken,
              institutionName: metadata?.institution?.name || null,
            }),
          }).then(x => x.json())
          if (ex.ok) {
            setMsg(`✓ Banco conectado! ${ex.sync?.added ?? 0} transações importadas. Nossa equipe cuida do resto.`)
            load()
          } else setMsg(`Erro: ${ex.error}`)
          setBusy(false)
        },
        onExit: (err: any) => {
          if (err) setMsg('Conexão cancelada.')
          setBusy(false)
        },
      })
      handler.open()
    } catch (e) {
      setMsg(`Erro: ${(e as Error).message}`)
      setBusy(false)
    }
  }

  const disconnect = async (id: string, name: string) => {
    if (!confirm(`Desconectar ${name}? As transações já importadas permanecem no seu bookkeeping.`)) return
    await fetch(`/api/plaid/items?id=${id}`, { method: 'DELETE' })
    load()
  }

  return (
    <div style={{ maxWidth: 620, margin: '0 auto' }}>
      <Script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"
        onLoad={() => setPlaidReady(true)} />

      <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: '#0f2340', margin: '0 0 6px' }}>
        🏦 Contas bancárias
      </h1>
      <p style={{ fontSize: 14.5, color: '#5a6a7a', lineHeight: 1.7, margin: '0 0 20px' }}>
        Conecte a conta do seu negócio para que suas transações cheguem automaticamente
        à nossa equipe de bookkeeping — sem precisar enviar extratos todo mês.
        A conexão é feita pela <b>Plaid</b>, tecnologia segura usada pelos maiores aplicativos
        financeiros dos EUA. <b>Nunca vemos sua senha do banco.</b>
      </p>

      <button onClick={connect} disabled={busy || !plaidReady}
        style={{ width: '100%', padding: '17px', background: busy || !plaidReady ? '#e2e8f4' : '#2D3278',
          color: busy || !plaidReady ? '#9aaab0' : '#fff', border: 'none', borderRadius: 14,
          fontSize: 17, fontWeight: 800, cursor: busy || !plaidReady ? 'not-allowed' : 'pointer',
          minHeight: 56, marginBottom: 16 }}>
        {busy ? 'Abrindo…' : '🏦 Conectar banco'}
      </button>

      {msg && (
        <p style={{ fontSize: 14, fontWeight: 600, padding: '12px 14px', borderRadius: 10,
          background: msg.startsWith('✓') ? '#e8f5ee' : '#fff7e0',
          color: msg.startsWith('✓') ? '#1a6b4a' : '#c06010', margin: '0 0 16px' }}>
          {msg}
        </p>
      )}

      {items.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f4', overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', fontSize: 13, fontWeight: 800, color: '#6a7a9a',
            textTransform: 'uppercase' as const, borderBottom: '1px solid #f0f4fa' }}>
            Contas conectadas
          </div>
          {items.map(it => (
            <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 12,
              padding: '14px 16px', borderBottom: '1px solid #f0f4fa', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#0f2340' }}>
                  {it.institution_name || 'Banco'}
                </div>
                <div style={{ fontSize: 12, color: '#8a9ab0', marginTop: 2 }}>
                  {it.status === 'error' ? '⚠️ Reconectar necessário'
                    : it.last_synced_at ? `Sincronizado ${new Date(it.last_synced_at).toLocaleDateString()}`
                    : 'Conectado'}
                </div>
              </div>
              <button onClick={() => disconnect(it.id, it.institution_name || 'este banco')}
                style={{ padding: '10px 14px', background: '#fff', color: '#b02020',
                  border: '1.5px solid #f0c0c0', borderRadius: 9, fontSize: 13, fontWeight: 700,
                  cursor: 'pointer', minHeight: 44 }}>
                Desconectar
              </button>
            </div>
          ))}
        </div>
      )}

      <p style={{ fontSize: 12, color: '#9aaab0', lineHeight: 1.6, marginTop: 18 }}>
        Ao conectar, você autoriza a Peace on Tax a receber as transações desta conta
        exclusivamente para os serviços de bookkeeping contratados, conforme nossa{' '}
        <a href="/privacidade" style={{ color: '#F47B20' }}>Política de Privacidade</a>.
        Você pode desconectar a qualquer momento.
      </p>
    </div>
  )
}
