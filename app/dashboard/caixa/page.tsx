'use client'
// /dashboard/caixa — o caixa da PRÓPRIA Peace on Tax
//
// A firma é um cadastro em `clients` marcado com `is_firm` (ver
// lib/caixa-firma.ts): com isso o livro dela usa o MESMO motor dos clientes
// — Plaid, importação, regras, plano de contas, conciliação, P&L, balanço —
// em vez de uma segunda implementação que desandaria na primeira regra nova.
//
// A tela é só do sócio; a rota recusa qualquer outro nível (403) e esta
// página mostra a recusa em vez de fingir que o caixa está vazio.

import { useState, useEffect, useCallback } from 'react'
import Script from 'next/script'
import BookkeepingTab from '@/components/BookkeepingTab'

declare global { interface Window { Plaid: any } }

const CAMPOS: [string, string, string][] = [
  ['name',          'Nome da firma',  'Peace on Tax Corp'],
  ['business_name', 'Razão social',   'deixe em branco para repetir o nome'],
  ['ein',           'EIN',            '00-0000000'],
  ['email',         'E-mail',         'contato@peaceontax.com'],
  ['phone',         'Telefone',       '(781) 000-0000'],
  ['address_line1', 'Endereço',       ''],
  ['city',          'Cidade',         'Malden'],
  ['state',         'Estado',         'MA'],
  ['zip',           'ZIP',            ''],
]

export default function CaixaDaFirma() {
  const [dados, setDados]   = useState<any>(null)
  const [erro, setErro]     = useState('')
  const [msg, setMsg]       = useState('')
  const [busy, setBusy]     = useState(false)
  const [form, setForm]     = useState<Record<string, string>>({})
  const [plaidPronto, setPlaidPronto] = useState(false)

  const carregar = useCallback(async () => {
    try {
      const r = await fetch('/api/caixa/firma')
      const d = await r.json()
      if (!r.ok) { setErro(d.error || 'Não foi possível abrir o caixa.'); setDados(null); return }
      setErro(''); setDados(d)
    } catch (e) {
      setErro((e as Error).message)
    }
  }, [])
  useEffect(() => { carregar() }, [carregar])

  // Detecta o Plaid mesmo com o script em cache (onLoad não redispara)
  useEffect(() => {
    if (typeof window !== 'undefined' && window.Plaid) { setPlaidPronto(true); return }
    const t = setInterval(() => {
      if (typeof window !== 'undefined' && window.Plaid) { setPlaidPronto(true); clearInterval(t) }
    }, 300)
    const stop = setTimeout(() => clearInterval(t), 12000)
    return () => { clearInterval(t); clearTimeout(stop) }
  }, [])

  const firma = dados?.firma || null

  const trocar = async (publicToken: string, institutionName: string | null) => {
    const ex = await fetch('/api/plaid/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicToken, institutionName, clientId: firma.id }),
    }).then(x => x.json())
    setMsg(ex.ok ? `✓ Banco conectado. ${ex.sync?.added ?? 0} lançamentos importados.` : `Erro: ${ex.error}`)
    setBusy(false); carregar()
  }

  // Retorno do OAuth do banco (BofA, Chase, Wells Fargo): volta para cá com
  // oauth_state_id e o Link reabre com o MESMO token.
  useEffect(() => {
    if (typeof window === 'undefined' || !plaidPronto || !firma) return
    if (!window.location.search.includes('oauth_state_id')) return
    const salvo = (() => { try { return localStorage.getItem('plaid_link_token_caixa') } catch { return null } })()
    if (!salvo) return
    setBusy(true); setMsg('Concluindo a conexão com o banco…')
    window.Plaid.create({
      token: salvo,
      receivedRedirectUri: window.location.href,
      onSuccess: (pt: string, meta: any) => {
        try { localStorage.removeItem('plaid_link_token_caixa') } catch {}
        window.history.replaceState({}, '', '/dashboard/caixa')
        trocar(pt, meta?.institution?.name || null)
      },
      onExit: () => {
        try { localStorage.removeItem('plaid_link_token_caixa') } catch {}
        window.history.replaceState({}, '', '/dashboard/caixa')
        setMsg('Conexão não concluída.'); setBusy(false)
      },
    }).open()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plaidPronto, firma])

  const conectar = async () => {
    setBusy(true); setMsg('')
    try {
      const r = await fetch('/api/plaid/link-token', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: firma.id }),
      }).then(x => x.json())
      if (!r.linkToken) { setMsg(`Erro: ${r.error || 'não foi possível iniciar'}`); setBusy(false); return }
      if (r.aviso) setMsg(`⚠️ ${r.aviso}`)
      try { localStorage.setItem('plaid_link_token_caixa', r.linkToken) } catch {}
      window.Plaid.create({
        token: r.linkToken,
        onSuccess: (pt: string, meta: any) => {
          setMsg('Conectando a conta…'); trocar(pt, meta?.institution?.name || null)
        },
        onExit: (err: any) => {
          setMsg(err ? `Não foi possível conectar (${err.display_message || err.error_code || 'erro'}).`
                     : 'Conexão cancelada.')
          setBusy(false)
        },
      }).open()
    } catch (e) {
      setMsg(`Erro: ${(e as Error).message}`); setBusy(false)
    }
  }

  const desconectar = async (id: string, nome: string) => {
    if (!confirm(`Desconectar ${nome}? Os lançamentos já importados continuam no livro.`)) return
    await fetch(`/api/plaid/items?id=${id}`, { method: 'DELETE' })
    carregar()
  }

  const sincronizar = async () => {
    setBusy(true); setMsg('Buscando no banco…')
    const r = await fetch('/api/plaid/sync', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: firma.id }),
    }).then(x => x.json())
    setMsg(r.error ? `Erro: ${r.error}` : `✓ ${r.added ?? 0} lançamentos novos.`)
    setBusy(false); carregar()
  }

  const criar = async () => {
    setBusy(true); setMsg('')
    const r = await fetch('/api/caixa/firma', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    }).then(x => x.json())
    setBusy(false)
    if (r.error) { setMsg(`Erro: ${r.error}`); return }
    setMsg('✓ Caixa da firma criado. Agora conecte a conta bancária.')
    carregar()
  }

  const titulo = (
    <h1 style={{ fontFamily:'Georgia,serif', fontSize:24, color:'#0f2340', margin:'0 0 4px' }}>
      🏦 Caixa da firma
    </h1>
  )

  if (erro) return (
    <div>
      {titulo}
      <div style={{ background:'#fee2e2', border:'1.5px solid #b02020', borderRadius:12,
                    padding:'14px 16px', color:'#7a1a1a', fontSize:13.5, maxWidth:720 }}>{erro}</div>
    </div>
  )
  if (!dados) return <p style={{ color:'#6a7a9a', fontSize:14 }}>Carregando…</p>

  if (dados.migracaoPendente) return (
    <div>
      {titulo}
      <div style={{ background:'#fff7e6', border:'1.5px solid #c06010', borderRadius:12,
                    padding:'14px 16px', color:'#7a4a10', fontSize:13.5, maxWidth:720 }}>
        {dados.aviso}
      </div>
    </div>
  )

  return (
    <div>
      <Script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js" strategy="afterInteractive"
              onLoad={() => setPlaidPronto(true)} />
      {titulo}
      <p style={{ color:'#6a7a9a', fontSize:13.5, margin:'0 0 20px', maxWidth:760 }}>
        O livro da própria Peace on Tax. Usa o mesmo motor dos clientes — extrato pelo
        Plaid, regras, plano de contas e conciliação. Só o sócio abre esta tela.
      </p>

      {msg && (
        <div style={{ background:'#eaf2ff', border:'1.5px solid #2a5fa8', borderRadius:10,
                      padding:'10px 14px', color:'#123', fontSize:13, marginBottom:16, maxWidth:760 }}>{msg}</div>
      )}

      {!firma ? (
        <div style={{ background:'#fff', borderRadius:14, padding:'18px 20px', maxWidth:620,
                      border:'1.5px solid #d6e0f0' }}>
          <div style={{ fontWeight:800, color:'#0f2340', marginBottom:4 }}>Criar o caixa</div>
          <p style={{ fontSize:12.5, color:'#6a7a9a', margin:'0 0 14px' }}>
            Os dados da firma. Ela não entra na lista de clientes nem nas contagens —
            é um cadastro reservado.
          </p>
          {CAMPOS.map(([k, rotulo, dica]) => (
            <label key={k} style={{ display:'block', marginBottom:10 }}>
              <span style={{ display:'block', fontSize:12, fontWeight:700, color:'#334', marginBottom:3 }}>{rotulo}</span>
              <input value={form[k] || ''} placeholder={dica}
                onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                style={{ width:'100%', padding:'9px 11px', borderRadius:9, border:'1.5px solid #cfdaea', fontSize:14 }} />
            </label>
          ))}
          <button onClick={criar} disabled={busy || !form.name}
            style={{ marginTop:6, padding:'11px 18px', borderRadius:10, border:'none', fontSize:14,
                     fontWeight:800, color:'#fff', background: busy || !form.name ? '#9ab' : '#1a6b4a',
                     cursor: busy || !form.name ? 'default' : 'pointer' }}>
            Criar caixa da firma
          </button>
        </div>
      ) : (
        <>
          <div style={{ display:'flex', gap:12, flexWrap:'wrap', marginBottom:18 }}>
            <div style={{ background:'#fff', borderRadius:14, padding:'14px 18px',
                          border:'1.5px solid #d6e0f0', minWidth:190, flex:1 }}>
              <div style={{ fontSize:12, color:'#6a7a9a', fontWeight:700 }}>FIRMA</div>
              <div style={{ fontSize:17, fontWeight:800, color:'#0f2340' }}>
                {firma.business_name || firma.name}
              </div>
              {firma.ein && <div style={{ fontSize:12, color:'#6a7a9a' }}>EIN {firma.ein}</div>}
            </div>
            <div style={{ background:'#fff', borderRadius:14, padding:'14px 18px',
                          border:'1.5px solid #d6e0f0', minWidth:150 }}>
              <div style={{ fontSize:28, fontWeight:800, color:'#0f2340' }}>{dados.livro?.total ?? 0}</div>
              <div style={{ fontSize:12.5, fontWeight:700, color:'#6a7a9a' }}>lançamentos</div>
            </div>
            <div style={{ background:'#fff', borderRadius:14, padding:'14px 18px',
                          border:'1.5px solid #d6e0f0', minWidth:150 }}>
              <div style={{ fontSize:28, fontWeight:800, color:'#c06010' }}>{dados.livro?.pendentes ?? 0}</div>
              <div style={{ fontSize:12.5, fontWeight:700, color:'#6a7a9a' }}>sem classificação</div>
            </div>
            <div style={{ background:'#fff', borderRadius:14, padding:'14px 18px',
                          border:'1.5px solid #d6e0f0', minWidth:150 }}>
              <div style={{ fontSize:28, fontWeight:800, color:'#2a5fa8' }}>{dados.livro?.aguardando ?? 0}</div>
              <div style={{ fontSize:12.5, fontWeight:700, color:'#6a7a9a' }}>aguardando aprovação</div>
            </div>
          </div>

          <div style={{ background:'#fff', borderRadius:14, padding:'16px 18px',
                        border:'1.5px solid #d6e0f0', marginBottom:20, maxWidth:760 }}>
            <div style={{ fontWeight:800, color:'#0f2340', marginBottom:8 }}>Conta bancária</div>
            {(dados.conexoes || []).length === 0 ? (
              <p style={{ fontSize:13, color:'#6a7a9a', margin:'0 0 12px' }}>
                Nenhum banco conectado. O extrato entra sozinho depois de conectar.
              </p>
            ) : (
              <div style={{ marginBottom:12 }}>
                {(dados.conexoes || []).map((c: any) => (
                  <div key={c.id} style={{ display:'flex', alignItems:'center', gap:10,
                                           padding:'7px 0', borderBottom:'1px solid #eef2f8', fontSize:13.5 }}>
                    <span style={{ fontWeight:700, color:'#0f2340', flex:1 }}>
                      {c.institution_name || 'Banco'}
                    </span>
                    <span style={{ fontSize:12, color:'#6a7a9a' }}>
                      {c.last_synced_at ? `sincronizado ${new Date(c.last_synced_at).toLocaleDateString('en-US')}` : 'nunca sincronizado'}
                    </span>
                    <button onClick={() => desconectar(c.id, c.institution_name || 'Banco')}
                      style={{ padding:'5px 10px', borderRadius:8, border:'1.5px solid #d6a0a0',
                               background:'#fff', color:'#b02020', fontSize:12, fontWeight:700, cursor:'pointer' }}>
                      Desconectar
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
              <button onClick={conectar} disabled={busy || !plaidPronto}
                style={{ padding:'10px 16px', borderRadius:10, border:'none', fontSize:13.5, fontWeight:800,
                         color:'#fff', background: busy || !plaidPronto ? '#9ab' : '#2a5fa8',
                         cursor: busy || !plaidPronto ? 'default' : 'pointer' }}>
                {plaidPronto ? '🔗 Conectar banco' : 'Carregando o Plaid…'}
              </button>
              {(dados.conexoes || []).length > 0 && (
                <button onClick={sincronizar} disabled={busy}
                  style={{ padding:'10px 16px', borderRadius:10, border:'1.5px solid #2a5fa8',
                           background:'#fff', color:'#2a5fa8', fontSize:13.5, fontWeight:800,
                           cursor: busy ? 'default' : 'pointer' }}>
                  ⟳ Buscar lançamentos
                </button>
              )}
            </div>
          </div>

          {/* O MESMO livro dos clientes, apontado para a firma. */}
          <BookkeepingTab clientId={firma.id} clientName={firma.business_name || firma.name} />
        </>
      )}
    </div>
  )
}
