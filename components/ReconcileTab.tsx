'use client'
// ReconcileTab — Reconciliação bancária (estilo QuickBooks)
// Saldo inicial + saldo final do extrato → marcar os lançamentos batidos →
// diferença zero → fechar. Só considera o que está no REGISTRO (aprovado).

import { useState, useEffect, useCallback, memo } from 'react'
import { apurarConciliacao, sinalDoExtrato } from '@/lib/conciliacao-bancaria'

interface Acc { id: string; name: string; type?: string | null }
interface Props { clientId: string; accounts: Acc[] }

// Datas no padrão dos EUA (MM/DD/YYYY)
const fmtDate = (d: string | null | undefined) => {
  if (!d) return '—'
  const [y, m, day] = String(d).slice(0, 10).split('-')
  return (y && m && day) ? `${m}/${day}/${y}` : String(d)
}

const money = (v: number) =>
  `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * Pede e lê a resposta como TEXTO antes de tentar JSON. Quando a Vercel corta
 * o pedido (tempo esgotado, resposta grande demais) ela devolve uma PÁGINA de
 * erro, e `r.json()` estourava com "Unexpected token…": a pessoa via uma frase
 * sem sentido, ou a tela parada. Aqui a falha vira uma frase que diz o que houve.
 */
async function pedir(url: string, init?: RequestInit): Promise<any> {
  let r: Response, bruto: string
  try { r = await fetch(url, init); bruto = await r.text() }
  catch (e) { return { error: `Sem resposta do servidor (${(e as Error).message}). Confira a conexão e tente de novo.` } }
  try { return JSON.parse(bruto) }
  catch {
    if (r.status === 504) return { error: 'O servidor demorou demais para responder (HTTP 504). Tente de novo; se repetir, use uma data final mais antiga.' }
    if (r.status === 413) return { error: 'A resposta ficou grande demais para o servidor entregar (HTTP 413). Use uma data final mais antiga.' }
    return { error: `O servidor respondeu HTTP ${r.status} sem dados legíveis. Tente de novo em instantes.` }
  }
}

/**
 * Uma linha da lista. `memo`: com milhares de lançamentos, marcar UM refazia a
 * tabela inteira — medido em 12 mil linhas, ~350 ms por clique. Agora só a
 * linha que mudou se redesenha.
 */
const Linha = memo(function Linha({ t, on, alternar }: { t: any; on: boolean; alternar: (id: string) => void }) {
  return (
    <tr onClick={() => alternar(t.id)}
      style={{ borderBottom:'1px solid #f0f4fa', cursor:'pointer', background: on ? '#f0f9f4' : '#fff' }}>
      <td style={{ padding:'8px 12px' }}>
        <input type="checkbox" checked={on} onChange={() => alternar(t.id)}
          onClick={e => e.stopPropagation()} style={{ width:17, height:17, cursor:'pointer' }} />
      </td>
      <td style={{ padding:'8px 12px', whiteSpace:'nowrap' as const, color:'#4a5a70' }}>{fmtDate(t.tx_date)}</td>
      <td style={{ padding:'8px 12px' }} title={String(t.description ?? '')}>{String(t.description ?? '').slice(0, 70)}</td>
      <td style={{ padding:'8px 12px', color:'#6a7a9a' }}>{t.payee || '—'}</td>
      <td style={{ padding:'8px 12px', textAlign:'right' as const, fontWeight:700,
        color: Number(t.amount) < 0 ? '#b02020' : '#1a6b4a', whiteSpace:'nowrap' as const }}>
        {money(Number(t.amount))}
      </td>
    </tr>
  )
})

export default function ReconcileTab({ clientId, accounts }: Props) {
  const [accountId, setAccountId] = useState('')
  const [statementDate, setStatementDate] = useState('')
  const [beginning, setBeginning] = useState('0')
  const [ending, setEnding] = useState('')
  const [txs, setTxs] = useState<any[]>([])
  const [cleared, setCleared] = useState<Set<string>>(new Set())
  const [historico, setHistorico] = useState<any[]>([])
  const [pendentes, setPendentes] = useState(0)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [carregado, setCarregado] = useState(false)
  // Lançamento que falta no extrato (como o register do QuickBooks)
  const [novoAberto, setNovoAberto] = useState(false)
  const [nData, setNData] = useState(''); const [nDesc, setNDesc] = useState('')
  const [nValor, setNValor] = useState(''); const [nSentido, setNSentido] = useState('out')
  const [nConta, setNConta] = useState(''); const [nPayee, setNPayee] = useState('')
  const [categorias, setCategorias] = useState<{ name: string; kind: string }[]>([])
  const [erroCategorias, setErroCategorias] = useState('')

  // Cartão: a pessoa digita os saldos como na FATURA (a dívida, positiva); a
  // conta e o banco usam o sinal do livro. A tela converte na ida e na volta
  // (sinalDoExtrato) — sem isso, cartão sem lançamento no mês fechava com o
  // saldo invertido e o Balanço lia a dívida ao contrário.
  const sinal = sinalDoExtrato(accounts.find(a => a.id === accountId)?.type)

  // Ao trocar de conta: histórico e saldo inicial sugerido
  useEffect(() => {
    if (!accountId) return
    setCarregado(false); setTxs([]); setCleared(new Set()); setMsg('')
    pedir(`/api/bookkeeping/reconciliation?clientId=${clientId}&accountId=${accountId}`)
      .then(d => {
        if (!d?.ok) { setMsg(`Erro: ${d?.error}`); return }
        setHistorico(d.historico || [])
        setBeginning(String(sinal * Number(d.saldoInicialSugerido ?? 0)))
        if (d.emAberto) {
          setStatementDate(d.emAberto.statement_date || '')
          setEnding(d.emAberto.ending_balance == null ? '' : String(sinal * Number(d.emAberto.ending_balance)))
          setMsg('↻ Existe uma conciliação em andamento nesta conta — carregue os lançamentos para continuar.')
        }
      })
  }, [accountId, clientId, sinal])

  useEffect(() => {
    // Lista que falha não é "nenhuma conta": o seletor vazio diria isso.
    pedir('/api/bookkeeping/categories').then(d => {
      if (Array.isArray(d?.categories)) setCategorias(d.categories)
      else setErroCategorias(d?.error || 'resposta sem a lista de contas')
    })
  }, [])

  const incluirLancamento = async () => {
    if (!nData || !nDesc.trim() || !Number(nValor) || !nConta) {
      setMsg('⚠️ Preencha data, descrição, valor e conta contábil.'); return
    }
    setBusy(true); setMsg('')
    const d = await pedir('/api/bookkeeping/manual-entry', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId, accountId, date: nData, description: nDesc,
        amount: Number(nValor), direction: nSentido, category: nConta, payee: nPayee,
      }),
    })
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}${d.aviso ? ` — ${d.aviso}` : ''}`)
    setNDesc(''); setNValor(''); setNPayee(''); setNovoAberto(false)
    carregar()   // recarrega a conciliação com o lançamento novo
  }

  const carregar = async () => {
    if (!accountId || !statementDate) { setMsg('Escolha a conta e a data final do extrato.'); return }
    setBusy(true); setMsg('')
    const d = await pedir(
      `/api/bookkeeping/reconciliation?clientId=${clientId}&accountId=${accountId}&statementDate=${statementDate}`)
    setBusy(false)
    // Volume acima do teto não é defeito: a rota diz quantos são e o que fazer.
    if (d?.excesso) { setCarregado(false); setTxs([]); setCleared(new Set()); setMsg(`⚠️ ${d.error}`); return }
    if (!d?.ok) { setMsg(`Erro: ${d?.error}`); return }
    setTxs(d.elegiveis || [])
    setCleared(new Set(d.jaMarcados || []))
    setPendentes(d.pendentesNaoAprovados || 0)
    setHistorico(d.historico || [])
    setCarregado(true)
  }

  const salvar = async (action: 'save' | 'finish') => {
    setBusy(true); setMsg('')
    const d = await pedir('/api/bookkeeping/reconciliation', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action, clientId, accountId, statementDate,
        beginningBalance: sinal * (Number(beginning) || 0),
        endingBalance: sinal * (Number(ending) || 0),
        clearedIds: Array.from(cleared),
      }),
    })
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    const aviso = d.aviso ? ` — ${d.aviso}` : ''
    setMsg(action === 'finish'
      ? `✅ Conciliação de ${fmtDate(statementDate)} fechada com ${cleared.size} lançamentos — diferença zero.${aviso}`
      : `Progresso salvo (${cleared.size} marcados). Você pode continuar depois.${aviso}`)
    if (action === 'finish') { setTxs([]); setCleared(new Set()); setCarregado(false) }
    carregarHistorico()
  }

  const carregarHistorico = () => {
    pedir(`/api/bookkeeping/reconciliation?clientId=${clientId}&accountId=${accountId}`)
      .then(d => { if (d?.ok) setHistorico(d.historico || []) })
  }

  const reabrir = async (id: string) => {
    if (!confirm('Reabrir esta conciliação? Os lançamentos voltam a ficar livres para conciliar.')) return
    const d = await pedir(`/api/bookkeeping/reconciliation?id=${id}`, { method: 'DELETE' })
    if (!d?.ok) { setMsg(`Erro: ${d?.error}`); return }
    setMsg('Conciliação reaberta.'); carregarHistorico()
  }

  // Estável entre renders: é o que deixa a `Linha` memorizada pular o redesenho.
  const toggle = useCallback((id: string) => setCleared(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n
  }), [])

  // A MESMA conta da rota (lib/conciliacao-bancaria.ts): a tela dizia
  // "diferença 0.00" e a rota recusava, porque cada uma somava de um jeito.
  const conta = apurarConciliacao({ saldoInicial: sinal * (Number(beginning) || 0), saldoFinal: sinal * (Number(ending) || 0), elegiveis: txs, marcados: cleared })
  const fechado = conta.fecha && conta.naoElegiveis.length === 0 && carregado && ending !== ''

  const card: React.CSSProperties = { background:'#fff', borderRadius:14, padding:'16px 18px', border:'1px solid #e2e8f4', marginBottom:14 }
  const inp: React.CSSProperties = { padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, outline:'none' }
  const btn = (bg: string, off = false): React.CSSProperties => ({
    padding:'10px 16px', background: off ? '#e2e8f4' : bg, color: off ? '#9aaab0' : '#fff',
    border:'none', borderRadius:9, fontSize:13.5, fontWeight:700, cursor: off ? 'not-allowed' : 'pointer',
  })

  return (
    <div>
      {msg && (
        <div style={{ marginBottom:14, padding:'11px 16px', borderRadius:10, fontSize:13.5, fontWeight:700,
          background: msg.startsWith('✅') ? '#e8f5ee' : msg.startsWith('⚠️') ? '#fee2e2' : '#f0f4ff',
          color: msg.startsWith('✅') ? '#1a6b4a' : msg.startsWith('⚠️') ? '#b02020' : '#2D3278' }}>
          {msg}
          <button onClick={() => setMsg('')} style={{ float:'right', background:'none', border:'none', cursor:'pointer', fontSize:14, color:'inherit', fontWeight:800 }}>✕</button>
        </div>
      )}

      <div style={card}>
        <h3 style={{ fontFamily:'Georgia,serif', fontSize:15, color:'#0f2340', margin:'0 0 4px' }}>
          ✅ Reconciliação bancária
        </h3>
        <p style={{ fontSize:12.5, color:'#6a7a9a', margin:'0 0 14px', lineHeight:1.5 }}>
          Informe o saldo final do extrato do banco e marque os lançamentos que aparecem nele.
          A conciliação fecha quando a diferença chega a <b>zero</b>. Só entram lançamentos já <b>aprovados no registro</b>.
        </p>

        <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'flex-end' }}>
          <div>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>Conta</label>
            <select value={accountId} onChange={e => setAccountId(e.target.value)} style={{ ...inp, cursor:'pointer' }}>
              <option value="">— escolher —</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>Data final do extrato</label>
            <input type="date" value={statementDate} onChange={e => setStatementDate(e.target.value)} style={inp} />
          </div>
          <div>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>{sinal < 0 ? 'Saldo anterior da fatura (dívida)' : 'Saldo inicial'}</label>
            <input value={beginning} onChange={e => setBeginning(e.target.value)} style={{ ...inp, width:120 }} />
          </div>
          <div>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', marginBottom:3 }}>{sinal < 0 ? 'Saldo final da fatura (dívida)' : 'Saldo final do extrato'}</label>
            <input value={ending} onChange={e => setEnding(e.target.value)} placeholder="0.00" style={{ ...inp, width:140 }} />
          </div>
          <button onClick={carregar} disabled={busy || !accountId || !statementDate} style={btn('#2D3278', busy || !accountId || !statementDate)}>
            {busy ? 'Carregando…' : '📋 Carregar lançamentos'}
          </button>
        </div>
        {sinal < 0 && (
          <p style={{ fontSize:12, color:'#2D3278', margin:'10px 0 0', lineHeight:1.5 }}>
            💳 Cartão de crédito: digite os saldos <b>como aparecem na fatura</b> — o que se deve, em número positivo.
          </p>
        )}
        {/* Antes daqui o cartão só fechava com o saldo NEGATIVO, e o hábito fica. Num mês
            sem lançamento no sistema o negativo ainda fecha (inicial = final) — e gravaria a
            dívida ao contrário: o Balanço leria o cartão como dinheiro. A diferença não pega
            esse caso; o aviso pega. Negativo de verdade (crédito na fatura) existe, por isso
            avisa e não recusa. */}
        {sinal < 0 && (Number(beginning) < 0 || Number(ending) < 0) && (
          <p style={{ fontSize:12, color:'#8a5a00', background:'#fff8e6', border:'1px solid #f0d48a', borderRadius:8, padding:'8px 10px', margin:'8px 0 0', lineHeight:1.5 }}>
            ⚠️ Saldo negativo na fatura do cartão é <b>crédito</b> a favor do cliente (pagou mais do que devia).
            Se é dívida, digite em número positivo, como aparece na fatura — negativo aqui faz o Balanço ler o cartão como dinheiro.
          </p>
        )}
      </div>

      {carregado && (
        <>
          <div style={{ ...card, position:'sticky' as const, top:0, zIndex:20 }}>
            <div style={{ display:'flex', gap:22, flexWrap:'wrap', alignItems:'center' }}>
              <div>
                <div style={{ fontSize:10.5, color:'#6a7a9a', fontWeight:700, textTransform:'uppercase' as const }}>Entradas marcadas</div>
                <div style={{ fontSize:16, fontWeight:800, color:'#1a6b4a' }}>{conta.qtdEntradas} · {money(conta.entradas)}</div>
              </div>
              <div>
                <div style={{ fontSize:10.5, color:'#6a7a9a', fontWeight:700, textTransform:'uppercase' as const }}>Saídas marcadas</div>
                <div style={{ fontSize:16, fontWeight:800, color:'#b02020' }}>{conta.qtdSaidas} · {money(conta.saidas)}</div>
              </div>
              <div>
                <div style={{ fontSize:10.5, color:'#6a7a9a', fontWeight:700, textTransform:'uppercase' as const }}>Saldo calculado</div>
                <div style={{ fontSize:16, fontWeight:800, color:'#0f2340' }}>{money(sinal * conta.saldoCalculado)}</div>
              </div>
              <div style={{ marginLeft:'auto', textAlign:'right' as const }}>
                <div style={{ fontSize:10.5, color:'#6a7a9a', fontWeight:700, textTransform:'uppercase' as const }}>Diferença</div>
                <div style={{ fontSize:22, fontWeight:800, color: fechado ? '#1a6b4a' : '#b02020' }}>
                  {fechado ? '✓ 0.00' : money(sinal * conta.diferenca)}
                </div>
              </div>
            </div>

            <div style={{ display:'flex', gap:8, marginTop:12, flexWrap:'wrap' }}>
              <button onClick={() => salvar('finish')} disabled={!fechado || busy} style={btn('#1a6b4a', !fechado || busy)}>
                ✅ Concluir conciliação
              </button>
              <button onClick={() => salvar('save')} disabled={busy} style={btn('#2D3278', busy)}>
                💾 Salvar progresso
              </button>
              <button onClick={() => setCleared(new Set(txs.map(t => t.id)))} style={btn('#6a7a9a')}>Marcar todos</button>
              <button onClick={() => setCleared(new Set())} style={btn('#6a7a9a')}>Limpar marcações</button>
              <button onClick={() => { setNovoAberto(v => !v); setNData(statementDate) }}
                style={btn('#c06010')}>
                {novoAberto ? 'Fechar' : '➕ Falta um lançamento'}
              </button>
            </div>

            {pendentes > 0 && (
              <p style={{ fontSize:12, color:'#6a5a10', background:'#fff7e0', border:'1px solid #e0c060',
                borderRadius:8, padding:'8px 11px', margin:'10px 0 0', lineHeight:1.5 }}>
                ⚠️ Há {pendentes} lançamento(s) desta conta no período que ainda <b>não foram aprovados</b> —
                eles não aparecem aqui. Aprove no Banking se fizerem parte do extrato.
              </p>
            )}
          </div>

          {novoAberto && (
            <div style={{ ...card, border:'1.5px solid #c06010' }}>
              <div style={{ fontSize:13, fontWeight:800, color:'#c06010', marginBottom:4 }}>
                ➕ Incluir lançamento que falta no extrato
              </div>
              <p style={{ fontSize:12.5, color:'#6a7a9a', margin:'0 0 12px', lineHeight:1.5 }}>
                Para o que aconteceu de verdade mas não veio no banco — cheque que não compensou,
                dinheiro em espécie, ajuste. Entra direto no registro desta conta.
              </p>
              <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'center' }}>
                <input type="date" value={nData} onChange={e => setNData(e.target.value)} style={inp} />
                <input value={nDesc} onChange={e => setNDesc(e.target.value)} placeholder="Descrição"
                  style={{ ...inp, flex:'2 1 200px' }} />
                <select value={nSentido} onChange={e => setNSentido(e.target.value)} style={{ ...inp, cursor:'pointer' }}>
                  <option value="out">Saída</option>
                  <option value="in">Entrada</option>
                </select>
                <input type="number" step="0.01" value={nValor} onChange={e => setNValor(e.target.value)}
                  placeholder="0.00" style={{ ...inp, width:120 }} />
                <select value={nConta} onChange={e => setNConta(e.target.value)} style={{ ...inp, flex:'1 1 180px', cursor:'pointer' }}>
                  <option value="">{erroCategorias ? `⚠️ contas não carregaram: ${erroCategorias}` : '— conta contábil —'}</option>
                  {categorias.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
                <input value={nPayee} onChange={e => setNPayee(e.target.value)} placeholder="Payee (opcional)"
                  style={{ ...inp, flex:'1 1 150px' }} />
                <button onClick={incluirLancamento} disabled={busy} style={btn('#1a6b4a', busy)}>Incluir</button>
              </div>
            </div>
          )}

          <div style={{ background:'#fff', borderRadius:14, border:'1px solid #e2e8f4', overflow:'hidden' }}>
            <table style={{ width:'100%', borderCollapse:'collapse' as const, fontSize:13 }}>
              <thead>
                <tr style={{ background:'#f8fafc' }}>
                  {['', 'Data', 'Descrição', 'Payee', 'Valor'].map((h, i) => (
                    <th key={i} style={{ textAlign: i === 4 ? 'right' as const : 'left' as const, padding:'9px 12px',
                      fontSize:10.5, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const,
                      borderBottom:'1px solid #e2e8f4' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {txs.map(t => <Linha key={t.id} t={t} on={cleared.has(t.id)} alternar={toggle} />)}
                {txs.length === 0 && (
                  <tr><td colSpan={5} style={{ padding:'18px 12px', color:'#9aaab0', fontSize:13 }}>
                    Nenhum lançamento aprovado nesta conta até a data informada.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {historico.length > 0 && (
        <div style={{ ...card, marginTop:14 }}>
          <div style={{ fontSize:13, fontWeight:700, color:'#0f2340', marginBottom:10 }}>📚 Conciliações desta conta</div>
          {historico.map(h => (
            <div key={h.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 0', borderBottom:'1px solid #f0f4fa', fontSize:13 }}>
              <span style={{ fontWeight:700, color:'#0f2340', minWidth:96 }}>{fmtDate(h.statement_date)}</span>
              <span style={{ color:'#6a7a9a' }}>
                {h.status === 'completed' ? '✅ fechada' : '↻ em andamento'} · {h.cleared_count ?? '—'} lançamentos
              </span>
              <span style={{ marginLeft:'auto', fontWeight:700 }}>{money(sinal * Number(h.ending_balance))}</span>
              <button onClick={() => reabrir(h.id)}
                style={{ background:'none', border:'none', color:'#b02020', fontSize:11.5, fontWeight:700, cursor:'pointer', textDecoration:'underline' }}>
                reabrir
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
