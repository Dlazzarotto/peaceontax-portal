'use client'
// Contas a pagar da firma — o caixa DIÁRIO.
//
// Não é contabilidade: a despesa continua nascendo no extrato. Aqui se
// registra a obrigação antes de o dinheiro sair, para não esquecer de pagar
// e para projetar o caixa; pagar é LIGAR a conta ao débito que já apareceu
// no banco.

import { useState, useEffect, useCallback } from 'react'
import { money } from '@/lib/format'

const fmtData = (d: string) => {
  const s = String(d || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}` : s
}
const COR: Record<string, string> = {
  vencida: '#b02020', vence_hoje: '#c06010', a_vencer: '#1a6b4a',
  paga: '#6a7a9a', cancelada: '#9aa5b8',
}
const ROTULO: Record<string, string> = {
  vencida: 'vencida', vence_hoje: 'vence hoje', a_vencer: 'a vencer',
  paga: 'paga', cancelada: 'cancelada',
}

export default function CaixaContas() {
  const [d, setD]         = useState<any>(null)
  const [erro, setErro]   = useState('')
  const [msg, setMsg]     = useState('')
  const [busy, setBusy]   = useState(false)
  const [nova, setNova]   = useState<Record<string, string>>({})
  const [abrindo, setAbrindo] = useState(false)
  const [pagando, setPagando] = useState<string | null>(null)
  const [cands, setCands] = useState<any[] | null>(null)

  const carregar = useCallback(async () => {
    try {
      const r = await fetch('/api/caixa/contas')
      const j = await r.json()
      if (!r.ok) { setErro(j.error || 'Não foi possível abrir as contas a pagar.'); return }
      setErro(''); setD(j)
    } catch (e) { setErro((e as Error).message) }
  }, [])
  useEffect(() => { carregar() }, [carregar])

  const criar = async () => {
    setBusy(true); setMsg('')
    const r = await fetch('/api/caixa/contas', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...nova, amount: nova.amount }),
    })
    const j = await r.json(); setBusy(false)
    if (!r.ok) { setMsg(`⚠️ ${j.error}`); return }
    setMsg(j.aviso ? `✓ Conta lançada. ⚠️ ${j.aviso}` : '✓ Conta lançada.')
    setNova({}); setAbrindo(false); carregar()
  }

  const procurarPagamento = async (id: string) => {
    setPagando(id); setCands(null); setBusy(true); setMsg('')
    const r = await fetch('/api/caixa/contas', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sugerir: id }),
    })
    const j = await r.json(); setBusy(false)
    if (!r.ok) { setMsg(`⚠️ ${j.error}`); setPagando(null); return }
    setCands(j.candidatos || [])
  }

  const acao = async (corpo: any, feito: string) => {
    setBusy(true); setMsg('')
    const r = await fetch('/api/caixa/contas', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    })
    const j = await r.json(); setBusy(false)
    if (!r.ok) { setMsg(`⚠️ ${j.error}`); return }
    setMsg(feito); setPagando(null); setCands(null); carregar()
  }

  const cancelar = (id: string) => {
    const motivo = prompt('Por que está cancelando esta conta? (fica registrado)')
    if (motivo === null) return
    acao({ id, acao: 'cancelar', motivo }, '✓ Conta cancelada — ela continua no histórico.')
  }

  const caixa = (extra: any = {}) => ({
    background: '#fff', borderRadius: 14, border: '1.5px solid #d6e0f0', padding: '16px 18px', ...extra,
  })
  const campo = { width: '100%', padding: '9px 11px', borderRadius: 9, border: '1.5px solid #cfdaea', fontSize: 14 }

  if (erro) return (
    <div style={{ background:'#fee2e2', border:'1.5px solid #b02020', borderRadius:12,
                  padding:'14px 16px', color:'#7a1a1a', fontSize:13.5, marginBottom:20 }}>{erro}</div>
  )
  if (!d) return <p style={{ color:'#6a7a9a', fontSize:14 }}>Carregando as contas a pagar…</p>

  const a = d.aging || {}

  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontFamily:'Georgia,serif', fontSize:19, color:'#0f2340', margin:'0 0 4px' }}>
        Contas a pagar
      </h2>
      <p style={{ color:'#6a7a9a', fontSize:13, margin:'0 0 14px', maxWidth:780 }}>
        O que a firma deve e quando vence. <b>Não é contabilidade</b> — a despesa continua
        nascendo no extrato. Pagar aqui é ligar a conta ao débito que já apareceu no banco.
      </p>

      {msg && (
        <div style={{ background:'#eaf2ff', border:'1.5px solid #2a5fa8', borderRadius:10,
                      padding:'10px 14px', color:'#123', fontSize:13, marginBottom:12 }}>{msg}</div>
      )}

      <div style={{ display:'flex', gap:12, flexWrap:'wrap', marginBottom:14 }}>
        {[['A vencer', a.aVencer, '#1a6b4a'], ['Vencido', a.vencido, '#b02020'],
          ['Total em aberto', a.total, '#0f2340']].map(([r, v, c]: any) => (
          <div key={r} style={caixa({ minWidth:160, flex:1, padding:'14px 18px' })}>
            <div style={{ fontSize:24, fontWeight:800, color:c }}>{money(v || 0)}</div>
            <div style={{ fontSize:12.5, fontWeight:700, color:'#6a7a9a' }}>{r}</div>
          </div>
        ))}
      </div>

      {a.vencido > 0 && (
        <div style={{ fontSize:12.5, color:'#6a7a9a', marginBottom:14 }}>
          Atraso: até 30d <b>{money(a.ate30)}</b> · 31–60d <b>{money(a.ate60)}</b> ·
          61–90d <b>{money(a.ate90)}</b> · mais de 90d <b>{money(a.mais90)}</b>
        </div>
      )}

      {/* ── Lançar conta ── */}
      {!abrindo ? (
        <button onClick={() => setAbrindo(true)}
          style={{ padding:'10px 16px', borderRadius:10, border:'none', fontSize:13.5, fontWeight:800,
                   color:'#fff', background:'#2a5fa8', cursor:'pointer', marginBottom:14 }}>
          + Lançar conta a pagar
        </button>
      ) : (
        <div style={caixa({ marginBottom:14, maxWidth:720 })}>
          <div style={{ fontWeight:800, color:'#0f2340', marginBottom:10 }}>Nova conta</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(170px,1fr))', gap:10 }}>
            <label>
              <span style={{ display:'block', fontSize:12, fontWeight:700, color:'#334', marginBottom:3 }}>Fornecedor</span>
              <input list="fornecedores-da-firma" value={nova.payee || ''} style={campo}
                onChange={e => setNova(n => ({ ...n, payee: e.target.value }))} />
              <datalist id="fornecedores-da-firma">
                {(d.fornecedores || []).map((f: string) => <option key={f} value={f} />)}
              </datalist>
            </label>
            {[['description', 'Descrição'], ['category', 'Conta contábil (opcional)']].map(([k, r]) => (
              <label key={k}>
                <span style={{ display:'block', fontSize:12, fontWeight:700, color:'#334', marginBottom:3 }}>{r}</span>
                <input value={nova[k] || ''} style={campo}
                  onChange={e => setNova(n => ({ ...n, [k]: e.target.value }))} />
              </label>
            ))}
            <label>
              <span style={{ display:'block', fontSize:12, fontWeight:700, color:'#334', marginBottom:3 }}>Valor (US$)</span>
              <input type="number" step="0.01" min="0" value={nova.amount || ''} style={campo}
                onChange={e => setNova(n => ({ ...n, amount: e.target.value }))} />
            </label>
            {[['issue_date', 'Emissão (opcional)'], ['due_date', 'Vencimento']].map(([k, r]) => (
              <label key={k}>
                <span style={{ display:'block', fontSize:12, fontWeight:700, color:'#334', marginBottom:3 }}>{r}</span>
                <input type="date" value={nova[k] || ''} style={campo}
                  onChange={e => setNova(n => ({ ...n, [k]: e.target.value }))} />
              </label>
            ))}
          </div>
          <div style={{ display:'flex', gap:10, marginTop:12 }}>
            <button onClick={criar} disabled={busy || !nova.payee || !nova.amount || !nova.due_date}
              style={{ padding:'10px 18px', borderRadius:10, border:'none', fontSize:13.5, fontWeight:800,
                       color:'#fff', background: busy || !nova.payee || !nova.amount || !nova.due_date ? '#9ab' : '#1a6b4a',
                       cursor:'pointer' }}>Lançar</button>
            <button onClick={() => { setAbrindo(false); setNova({}) }}
              style={{ padding:'10px 16px', borderRadius:10, border:'1.5px solid #cfdaea',
                       background:'#fff', color:'#334', fontSize:13.5, fontWeight:700, cursor:'pointer' }}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* ── Abertas ── */}
      {(d.abertas || []).length === 0 ? (
        <div style={caixa()}>
          <p style={{ fontSize:13, color:'#6a7a9a', margin:0 }}>Nenhuma conta em aberto.</p>
        </div>
      ) : (d.abertas || []).map((c: any) => (
        <div key={c.id} style={caixa({ marginBottom:10, borderColor: c.situacao === 'vencida' ? '#e0b4b4' : '#d6e0f0' })}>
          <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
            <span style={{ fontSize:12.5, color:'#6a7a9a', minWidth:78 }}>{fmtData(c.due_date)}</span>
            <span style={{ flex:1, minWidth:160 }}>
              <b style={{ color:'#0f2340', fontSize:13.5 }}>{c.payee}</b>
              {c.description && <span style={{ color:'#6a7a9a', fontSize:12.5 }}> — {c.description}</span>}
            </span>
            <span style={{ fontSize:11.5, fontWeight:800, color: COR[c.situacao] }}>{ROTULO[c.situacao]}</span>
            <span style={{ fontSize:16, fontWeight:800, color:'#0f2340' }}>{money(c.amount)}</span>
            <button onClick={() => procurarPagamento(c.id)} disabled={busy}
              style={{ padding:'6px 12px', borderRadius:8, border:'none', background:'#1a6b4a',
                       color:'#fff', fontSize:12, fontWeight:800, cursor:'pointer' }}>
              Pagar
            </button>
            <button onClick={() => cancelar(c.id)} disabled={busy}
              style={{ padding:'6px 10px', borderRadius:8, border:'1.5px solid #d6a0a0', background:'#fff',
                       color:'#b02020', fontSize:11.5, fontWeight:700, cursor:'pointer' }}>
              Cancelar
            </button>
          </div>

          {pagando === c.id && (
            <div style={{ marginTop:12, borderTop:'1px solid #eef2f8', paddingTop:12 }}>
              <div style={{ fontSize:12.5, color:'#6a7a9a', marginBottom:8 }}>
                Débitos do extrato de <b>{money(c.amount)}</b> por volta do vencimento.
                Pagar não lança despesa — ela já veio do banco.
              </div>
              {cands === null ? <p style={{ fontSize:13, color:'#6a7a9a' }}>Procurando…</p>
               : cands.length === 0 ? (
                <p style={{ fontSize:13, color:'#b02020', margin:0 }}>
                  Nenhum débito de {money(c.amount)} no extrato por volta desta data. Se o pagamento
                  acabou de sair, espere o banco trazer o lançamento — ou confira o valor.
                </p>
              ) : cands.map((t: any) => (
                <div key={t.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 0',
                                         borderBottom:'1px solid #f3f6fb', fontSize:13, flexWrap:'wrap' }}>
                  <span style={{ color:'#6a7a9a', minWidth:74, fontSize:12 }}>{fmtData(t.tx_date)}</span>
                  <span style={{ flex:1, color:'#0f2340' }}>
                    {t.description}
                    {t.pareceOFornecedor && <span style={{ color:'#1a6b4a', fontSize:11 }}> · nome bate</span>}
                  </span>
                  <span style={{ fontWeight:700 }}>{money(t.valor)}</span>
                  <button onClick={() => acao({ id: c.id, acao: 'pagar', txId: t.id }, '✓ Conta fechada com o débito do extrato.')}
                    disabled={busy}
                    style={{ padding:'5px 10px', borderRadius:8, border:'none', background:'#2a5fa8',
                             color:'#fff', fontSize:11.5, fontWeight:800, cursor:'pointer' }}>
                    foi este
                  </button>
                </div>
              ))}
              <button onClick={() => { setPagando(null); setCands(null) }}
                style={{ marginTop:10, padding:'6px 12px', borderRadius:8, border:'1.5px solid #cfdaea',
                         background:'#fff', color:'#334', fontSize:12, fontWeight:700, cursor:'pointer' }}>
                fechar
              </button>
            </div>
          )}
        </div>
      ))}

      {(d.fechadas || []).length > 0 && (
        <details style={{ marginTop:14 }}>
          <summary style={{ fontSize:13, color:'#2a5fa8', fontWeight:700, cursor:'pointer' }}>
            Pagas e canceladas ({d.fechadas.length})
          </summary>
          <div style={caixa({ marginTop:10 })}>
            {d.fechadas.map((c: any) => (
              <div key={c.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'6px 0',
                                       borderBottom:'1px solid #f3f6fb', fontSize:13, flexWrap:'wrap' }}>
                <span style={{ color:'#6a7a9a', minWidth:74, fontSize:12 }}>{fmtData(c.due_date)}</span>
                <span style={{ flex:1, color:'#0f2340' }}>
                  {c.payee}
                  {c.cancel_reason && <span style={{ color:'#9aa5b8', fontSize:12 }}> — {c.cancel_reason}</span>}
                </span>
                <span style={{ fontSize:11.5, fontWeight:800, color: COR[c.situacao] }}>{ROTULO[c.situacao]}</span>
                <span style={{ fontWeight:700 }}>{money(c.amount)}</span>
                {c.status === 'paga' && (
                  <button onClick={() => acao({ id: c.id, acao: 'reabrir' }, '✓ Pagamento desfeito — a conta voltou a aberta.')}
                    disabled={busy}
                    style={{ padding:'4px 10px', borderRadius:8, border:'1.5px solid #cfdaea', background:'#fff',
                             color:'#334', fontSize:11.5, fontWeight:700, cursor:'pointer' }}>
                    Desfazer
                  </button>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
