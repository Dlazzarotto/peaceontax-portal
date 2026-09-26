'use client'
// Conciliação de depósito — o que entrou no banco × os recebimentos.
//
// A tela faz a MESMA conta da rota (lib/deposito-match.ts) só para adiantar
// o que vai acontecer; quem decide é o banco, que recalcula na RPC. Tela e
// trava pedindo coisas diferentes é a falha que mais custou caro aqui.

import { useState, useEffect, useCallback } from 'react'
import { conferirDeposito } from '@/lib/deposito-match'
import { money } from '@/lib/format'

const fmtData = (d: string) => {
  const s = String(d || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}` : s
}

export default function CaixaDepositos({ aoMudar }: { aoMudar?: () => void }) {
  const [d, setD]           = useState<any>(null)
  const [erro, setErro]     = useState('')
  const [msg, setMsg]       = useState('')
  const [busy, setBusy]     = useState(false)
  const [aberto, setAberto] = useState<string | null>(null)
  const [marcados, setMarcados] = useState<Record<string, boolean>>({})
  const [sugestao, setSugestao] = useState<any>(null)

  const carregar = useCallback(async () => {
    try {
      const r = await fetch('/api/caixa/depositos')
      const j = await r.json()
      if (!r.ok) { setErro(j.error || 'Não foi possível abrir a conciliação.'); return }
      setErro(''); setD(j)
    } catch (e) { setErro((e as Error).message) }
  }, [])
  useEffect(() => { carregar() }, [carregar])

  const escolhidos = (d?.transito || []).filter((t: any) => marcados[t.id])
  const deposito   = (d?.depositos || []).find((x: any) => x.id === aberto)
  const conf = deposito ? conferirDeposito(deposito.valor, escolhidos) : null

  const abrir = (id: string) => {
    setAberto(a => (a === id ? null : id))
    setMarcados({}); setSugestao(null); setMsg('')
  }

  const perguntarAoStripe = async () => {
    setBusy(true); setMsg('Perguntando ao Stripe o que veio neste repasse…')
    const r = await fetch('/api/caixa/depositos', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sugerir: aberto }),
    })
    const j = await r.json(); setBusy(false)
    if (!r.ok) { setMsg(`⚠️ ${j.error}`); return }
    setSugestao(j)
    const novos: Record<string, boolean> = {}
    for (const id of j.selecionar || []) novos[id] = true
    setMarcados(novos)
    setMsg(j.aviso ? `⚠️ ${j.aviso}` : `Repasse ${j.repasse.id}: ${j.detalhe.cobrancas} cobrança(s), `
      + `${money(j.detalhe.bruto)} bruto, ${money(j.detalhe.taxa)} de taxa.`)
  }

  const conciliar = async () => {
    setBusy(true); setMsg('')
    const r = await fetch('/api/caixa/depositos', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ depositoId: aberto, recebimentos: escolhidos.map((t: any) => t.id) }),
    })
    const j = await r.json(); setBusy(false)
    if (!r.ok) { setMsg(`⚠️ ${j.error}`); return }
    setMsg(`✓ Conciliado: ${money(j.bruto)} de receita` + (j.taxa > 0 ? `, ${money(j.taxa)} de taxa lançada como despesa.` : '.'))
    setAberto(null); setMarcados({}); setSugestao(null)
    carregar(); aoMudar?.()
  }

  const desfazer = async (id: string) => {
    if (!confirm('Desfazer a conciliação deste depósito? Os recebimentos voltam para o trânsito.')) return
    setBusy(true)
    const r = await fetch(`/api/caixa/depositos?id=${id}`, { method: 'DELETE' })
    const j = await r.json(); setBusy(false)
    setMsg(r.ok ? `✓ Desfeito. ${j.soltos} recebimento(s) de volta ao trânsito.` : `⚠️ ${j.error}`)
    carregar(); aoMudar?.()
  }

  const caixa = (extra: any = {}) => ({
    background: '#fff', borderRadius: 14, border: '1.5px solid #d6e0f0', padding: '16px 18px', ...extra,
  })

  if (erro) return (
    <div style={{ background:'#fee2e2', border:'1.5px solid #b02020', borderRadius:12,
                  padding:'14px 16px', color:'#7a1a1a', fontSize:13.5, marginBottom:20 }}>{erro}</div>
  )
  if (!d) return <p style={{ color:'#6a7a9a', fontSize:14 }}>Carregando a conciliação…</p>

  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontFamily:'Georgia,serif', fontSize:19, color:'#0f2340', margin:'0 0 4px' }}>
        Depósitos × recebimentos
      </h2>
      <p style={{ color:'#6a7a9a', fontSize:13, margin:'0 0 14px', maxWidth:780 }}>
        A receita nasce no recebimento da fatura e fica <b>em trânsito</b> até o depósito
        aparecer no banco. No repasse do Stripe, a diferença entre o bruto e o que caiu
        é a <b>taxa</b> — lançada como despesa, senão a receita bruta nunca fecha.
      </p>

      {(d.sincronia?.avisos || []).map((a: string, i: number) => (
        <div key={i} style={{ background:'#fff7e6', border:'1.5px solid #c06010', borderRadius:10,
                              padding:'10px 14px', color:'#7a4a10', fontSize:12.5, marginBottom:10 }}>⚠️ {a}</div>
      ))}
      {msg && (
        <div style={{ background:'#eaf2ff', border:'1.5px solid #2a5fa8', borderRadius:10,
                      padding:'10px 14px', color:'#123', fontSize:13, marginBottom:12 }}>{msg}</div>
      )}

      <div style={caixa({ marginBottom: 14 })}>
        <div style={{ display:'flex', alignItems:'baseline', gap:10, flexWrap:'wrap' }}>
          <span style={{ fontSize:12.5, fontWeight:700, color:'#6a7a9a' }}>EM TRÂNSITO</span>
          <span style={{ fontSize:24, fontWeight:800, color:'#0f2340' }}>{money(d.saldoEmTransito || 0)}</span>
          <span style={{ fontSize:12.5, color:'#6a7a9a' }}>
            {(d.transito || []).length} recebimento(s) ainda sem depósito no banco
          </span>
        </div>
      </div>

      {(d.depositos || []).length === 0 ? (
        <div style={caixa()}>
          <p style={{ fontSize:13, color:'#6a7a9a', margin:0 }}>
            Nenhum depósito por explicar. Tudo o que entrou no banco já está conciliado.
          </p>
        </div>
      ) : (d.depositos || []).map((dep: any) => (
        <div key={dep.id} style={caixa({ marginBottom: 10, borderColor: aberto === dep.id ? '#2a5fa8' : '#d6e0f0' })}>
          <div onClick={() => abrir(dep.id)}
               style={{ display:'flex', alignItems:'center', gap:12, cursor:'pointer', flexWrap:'wrap' }}>
            <span style={{ fontSize:12.5, color:'#6a7a9a', minWidth:78 }}>{fmtData(dep.data)}</span>
            <span style={{ flex:1, fontWeight:700, color:'#0f2340', fontSize:13.5, minWidth:160 }}>
              {dep.descricao} {dep.pareceStripe && <span style={{ fontSize:11, color:'#6a5acd' }}>· Stripe</span>}
            </span>
            <span style={{ fontSize:16, fontWeight:800, color:'#1a6b4a' }}>{money(dep.valor)}</span>
            <span style={{ fontSize:12, color:'#2a5fa8', fontWeight:700 }}>
              {aberto === dep.id ? 'fechar' : 'conciliar ▸'}
            </span>
          </div>

          {aberto === dep.id && (
            <div style={{ marginTop:14, borderTop:'1px solid #eef2f8', paddingTop:12 }}>
              <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:10 }}>
                <button onClick={perguntarAoStripe} disabled={busy}
                  style={{ padding:'8px 14px', borderRadius:9, border:'1.5px solid #6a5acd', background:'#fff',
                           color:'#6a5acd', fontSize:12.5, fontWeight:800, cursor: busy ? 'default' : 'pointer' }}>
                  🔎 Perguntar ao Stripe
                </button>
                <span style={{ fontSize:12, color:'#6a7a9a', alignSelf:'center' }}>
                  ou marque abaixo os recebimentos deste depósito (cheque, Zelle, espécie)
                </span>
              </div>

              {sugestao?.semRecebimento > 0 && (
                <div style={{ background:'#fff7e6', border:'1.5px solid #c06010', borderRadius:9,
                              padding:'9px 12px', color:'#7a4a10', fontSize:12.5, marginBottom:10 }}>
                  ⚠️ {sugestao.semRecebimento} cobrança(s) deste repasse não têm recebimento lançado em fatura
                  nenhuma. Lance o recebimento antes de conciliar — senão essa parte vira “taxa”.
                </div>
              )}

              <div style={{ maxHeight:280, overflowY:'auto', border:'1px solid #eef2f8', borderRadius:9 }}>
                {(d.transito || []).length === 0 && (
                  <p style={{ fontSize:12.5, color:'#6a7a9a', padding:'10px 12px', margin:0 }}>
                    Nada em trânsito. Se este depósito é de cliente, o recebimento ainda não foi lançado na fatura.
                  </p>
                )}
                {(d.transito || []).map((t: any) => (
                  <label key={t.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 12px',
                                             borderBottom:'1px solid #f3f6fb', fontSize:13, cursor:'pointer' }}>
                    <input type="checkbox" checked={!!marcados[t.id]}
                      onChange={e => setMarcados(m => ({ ...m, [t.id]: e.target.checked }))} />
                    <span style={{ color:'#6a7a9a', minWidth:74, fontSize:12 }}>{fmtData(t.data)}</span>
                    <span style={{ flex:1, color:'#0f2340' }}>{t.descricao}</span>
                    <span style={{ fontWeight:700 }}>{money(t.valor)}</span>
                  </label>
                ))}
              </div>

              <div style={{ display:'flex', gap:14, flexWrap:'wrap', alignItems:'center', marginTop:12 }}>
                <span style={{ fontSize:13 }}>
                  Bruto escolhido <b>{money(conf?.soma || 0)}</b> · no banco <b>{money(dep.valor)}</b>
                  {conf && conf.diferenca > 0 && <> · taxa <b style={{ color:'#c06010' }}>{money(conf.diferenca)}</b></>}
                </span>
                <button onClick={conciliar} disabled={busy || !conf?.podeConciliar}
                  style={{ padding:'10px 18px', borderRadius:10, border:'none', fontSize:13.5, fontWeight:800,
                           color:'#fff', background: busy || !conf?.podeConciliar ? '#9ab' : '#1a6b4a',
                           cursor: busy || !conf?.podeConciliar ? 'default' : 'pointer' }}>
                  Conciliar
                </button>
              </div>
              {conf && !conf.podeConciliar && (
                <p style={{ fontSize:12.5, color:'#b02020', margin:'8px 0 0' }}>{conf.mensagem}</p>
              )}
              {conf?.alerta && (
                <p style={{ fontSize:12.5, color:'#7a4a10', margin:'8px 0 0' }}>⚠️ {conf.alerta}</p>
              )}
            </div>
          )}
        </div>
      ))}

      {(d.conciliados || []).length > 0 && (
        <details style={{ marginTop:14 }}>
          <summary style={{ fontSize:13, color:'#2a5fa8', fontWeight:700, cursor:'pointer' }}>
            Depósitos já conciliados ({d.conciliados.length})
          </summary>
          <div style={caixa({ marginTop:10 })}>
            {d.conciliados.map((c: any) => (
              <div key={c.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'6px 0',
                                       borderBottom:'1px solid #f3f6fb', fontSize:13, flexWrap:'wrap' }}>
                <span style={{ color:'#6a7a9a', minWidth:74, fontSize:12 }}>{fmtData(c.data)}</span>
                <span style={{ flex:1, color:'#0f2340' }}>{c.descricao}</span>
                <span style={{ fontWeight:700 }}>{money(c.valor)}</span>
                <button onClick={() => desfazer(c.id)} disabled={busy}
                  style={{ padding:'4px 10px', borderRadius:8, border:'1.5px solid #d6a0a0', background:'#fff',
                           color:'#b02020', fontSize:11.5, fontWeight:700, cursor:'pointer' }}>
                  Desfazer
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
