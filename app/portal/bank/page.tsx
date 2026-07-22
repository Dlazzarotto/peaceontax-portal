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

  // Retorno do OAuth (BofA/Chase/etc): o banco redireciona de volta com oauth_state_id —
  // reabrimos o Link com o MESMO token e a URL recebida para concluir a conexão.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!window.location.search.includes('oauth_state_id')) return
    const saved = (() => { try { return localStorage.getItem('plaid_link_token') } catch { return null } })()
    if (!saved || !plaidReady) return
    setBusy(true); setMsg('Concluindo a conexão com o banco…')
    const handler = window.Plaid.create({
      token: saved,
      receivedRedirectUri: window.location.href,
      onSuccess: async (publicToken: string, metadata: any) => {
        const ex = await fetch('/api/plaid/exchange', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ publicToken, institutionName: metadata?.institution?.name || null }),
        }).then(x => x.json())
        setMsg(ex.ok ? `✓ Banco conectado! ${ex.sync?.added ?? 0} transações importadas.` : `Erro: ${ex.error}`)
        try { localStorage.removeItem('plaid_link_token') } catch {}
        window.history.replaceState({}, '', '/portal/bank')
        setBusy(false); load()
      },
      onExit: () => {
        setMsg('Conexão não concluída — tente novamente.')
        try { localStorage.removeItem('plaid_link_token') } catch {}
        window.history.replaceState({}, '', '/portal/bank')
        setBusy(false)
      },
    })
    handler.open()
  }, [plaidReady])

  // Detecta o Plaid mesmo quando o script já está em cache (onLoad não redispara)
  useEffect(() => {
    if (typeof window !== 'undefined' && window.Plaid) { setPlaidReady(true); return }
    const t = setInterval(() => {
      if (typeof window !== 'undefined' && window.Plaid) { setPlaidReady(true); clearInterval(t) }
    }, 300)
    const stop = setTimeout(() => clearInterval(t), 15000)
    return () => { clearInterval(t); clearTimeout(stop) }
  }, [])

  const connect = async () => {
    setBusy(true); setMsg('')
    try {
      const r = await fetch('/api/plaid/link-token', { method: 'POST' }).then(x => x.json())
      if (!r.linkToken) { setMsg(`Erro: ${r.error || 'não foi possível iniciar'}`); setBusy(false); return }
      try { localStorage.setItem('plaid_link_token', r.linkToken) } catch {}

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
        onExit: (err: any, metadata: any) => {
          if (err) {
            const code = err.error_code || ''
            if (code === 'INSTITUTION_NOT_ENABLED' || code === 'INSTITUTION_NO_LONGER_SUPPORTED' || code === 'INSTITUTION_NOT_AVAILABLE' || /oauth/i.test(code)) {
              setMsg('⏳ Este banco ainda está finalizando a aprovação da nossa integração (processo do próprio banco, leva algumas semanas). Avisaremos quando liberar — enquanto isso, envie os extratos em PDF pelo portal.')
            } else if (code === 'INSTITUTION_DOWN' || code === 'INSTITUTION_NOT_RESPONDING') {
              setMsg('O banco está temporariamente indisponível — tente novamente em alguns minutos.')
            } else if (code === 'INVALID_CREDENTIALS') {
              setMsg('Login ou senha do banco incorretos — tente novamente.')
            } else {
              setMsg(`Não foi possível conectar (${err.display_message || code || 'erro'}). Tente novamente ou fale conosco.`)
            }
          } else {
            setMsg('Conexão cancelada. Quando quiser, é só tentar de novo.')
          }
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
        strategy="afterInteractive" onLoad={() => setPlaidReady(true)} />

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
        {busy ? 'Abrindo…' : !plaidReady ? 'Carregando conexão segura…' : '🏦 Conectar banco'}
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
