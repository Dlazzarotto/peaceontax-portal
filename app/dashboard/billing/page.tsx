'use client'
// Financeiro → Faturamento
// Lista de orçamentos e faturas, criação (nasce rascunho), envio,
// recebimento, duplicação e cancelamento — cada botão conforme o nível.

import { useState, useEffect } from 'react'

interface Inv {
  id: string; number: string; doc_type: string; status: string; cliente: string
  issue_date: string; due_date: string | null; total: number; paid_total: number; saldo: number
  payment_plan: string; expected_method: string | null
}
interface Item { description: string; qty: number; unitPrice: number; serviceId?: string }

const STATUS: Record<string, { rotulo: string; cor: string }> = {
  draft:    { rotulo: 'Rascunho',  cor: '#6A7A9A' },
  sent:     { rotulo: 'Enviada',   cor: '#2D3278' },
  accepted: { rotulo: 'Aceito',    cor: '#0A6A8A' },
  declined: { rotulo: 'Recusado',  cor: '#B02020' },
  partial:  { rotulo: 'Parcial',   cor: '#C06010' },
  paid:     { rotulo: 'Paga',      cor: '#1A6B4A' },
  overdue:  { rotulo: 'Vencida',   cor: '#B02020' },
  void:     { rotulo: 'Cancelada', cor: '#9AAAB0' },
}

const FORMAS = [
  ['card', 'Cartão'], ['ach', 'Débito em conta (ACH)'], ['zelle', 'Zelle'],
  ['venmo', 'Venmo'], ['cash', 'Dinheiro'], ['check', 'Cheque'],
  ['wire', 'Wire'], ['external', 'Financiadora'],
]

const money = (v: number) =>
  `$${(Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const dataUS = (d: string | null) => {
  if (!d) return '—'
  const [y, m, dia] = String(d).slice(0, 10).split('-')
  return `${m}/${dia}/${y}`
}

export default function BillingPage() {
  const [dados, setDados] = useState<any>({ invoices: [], clients: [], services: [], perms: null })
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [filtroDoc, setFiltroDoc] = useState('')
  const [filtroStatus, setFiltroStatus] = useState('')
  const [busca, setBusca] = useState('')

  // formulário
  const [abrirNovo, setAbrirNovo] = useState(false)
  const [fCliente, setFCliente] = useState('')
  const [fTipo, setFTipo] = useState('invoice')
  const [fVenc, setFVenc] = useState('')
  const [fPlano, setFPlano] = useState('full')
  const [fForma, setFForma] = useState('')
  const [fDesconto, setFDesconto] = useState('0')
  const [fNotas, setFNotas] = useState('')
  const [itens, setItens] = useState<Item[]>([{ description: '', qty: 1, unitPrice: 0 }])

  // recebimento
  const [receber, setReceber] = useState<Inv | null>(null)
  const [rValor, setRValor] = useState('')
  const [rForma, setRForma] = useState('zelle')
  const [rRef, setRRef] = useState('')

  const perms = dados.perms

  const load = async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (filtroDoc) qs.set('doc', filtroDoc)
      if (filtroStatus) qs.set('status', filtroStatus)
      const d = await fetch(`/api/billing/invoices?${qs}`).then(r => r.json())
      if (d?.invoices) setDados(d)
      else setMsg(`⚠️ ${d?.error || 'Não foi possível carregar.'}`)
    } catch (e) { setMsg(`⚠️ ${(e as Error).message}`) }
    setLoading(false)
  }
  useEffect(() => { load() }, [filtroDoc, filtroStatus])

  const criar = async () => {
    if (!fCliente) { setMsg('⚠️ Escolha o cliente.'); return }
    setBusy(true); setMsg('')
    const d = await fetch('/api/billing/invoices', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: fCliente, docType: fTipo, dueDate: fVenc || null,
        paymentPlan: fPlano, expectedMethod: fForma || null,
        discount: Number(fDesconto) || 0, notes: fNotas, items: itens,
      }),
    }).then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`)
    setAbrirNovo(false); setItens([{ description: '', qty: 1, unitPrice: 0 }])
    setFVenc(''); setFNotas(''); setFDesconto('0')
    load()
  }

  const acao = async (inv: Inv, action: string, pergunta?: string) => {
    if (pergunta && !confirm(pergunta)) return
    setBusy(true); setMsg('')
    const d = await fetch('/api/billing/invoices', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: inv.id, action }),
    }).then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`); load()
  }

  const apagar = async (inv: Inv) => {
    if (!confirm(`Apagar ${inv.number} definitivamente?\n\nSe quiser manter no histórico, use Cancelar.`)) return
    setBusy(true); setMsg('')
    const d = await fetch(`/api/billing/invoices?id=${inv.id}`, { method: 'DELETE' })
      .then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`); load()
  }

  const salvarRecebimento = async () => {
    if (!receber) return
    setBusy(true); setMsg('')
    const d = await fetch('/api/billing/payments', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invoiceId: receber.id, amount: Number(rValor), method: rForma, reference: rRef,
      }),
    }).then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`)
    setReceber(null); setRRef(''); load()
  }

  const card: React.CSSProperties = { background: '#fff', border: '1px solid #E2E8F4', borderRadius: 16, padding: '18px 20px', marginBottom: 16 }
  const inp: React.CSSProperties = { padding: '10px 12px', border: '1.5px solid #E2E8F4', borderRadius: 9, fontSize: 14.5, outline: 'none' }
  const btn = (bg: string, off = false): React.CSSProperties => ({
    padding: '10px 16px', background: off ? '#E2E8F4' : bg, color: off ? '#9AAAB0' : '#fff',
    border: 'none', borderRadius: 9, fontSize: 14, fontWeight: 700, cursor: off ? 'not-allowed' : 'pointer',
  })
  const acaoBtn = (cor: string): React.CSSProperties => ({
    background: 'none', border: 'none', color: cor, fontSize: 13, fontWeight: 700, cursor: 'pointer', marginRight: 10,
  })

  const q = busca.trim().toLowerCase()
  const lista: Inv[] = (dados.invoices || []).filter((i: Inv) =>
    !q || i.number.toLowerCase().includes(q) || i.cliente.toLowerCase().includes(q))

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 28, color: '#0F2340', margin: '0 0 4px', fontWeight: 400 }}>
          Faturamento
        </h1>
        <p style={{ fontSize: 14.5, color: '#6A7A9A', margin: 0, lineHeight: 1.5 }}>
          Orçamentos e faturas. Documentos nascem como rascunho; enviar, receber e cancelar
          são ações de gerente ou sócio.
        </p>
      </div>

      {msg && (
        <div style={{
          marginBottom: 14, padding: '12px 16px', borderRadius: 10, fontSize: 14.5, fontWeight: 700,
          background: msg.startsWith('✓') ? '#E8F5EE' : '#FEE2E2',
          color: msg.startsWith('✓') ? '#1A6B4A' : '#B02020',
        }}>
          {msg}
          <button onClick={() => setMsg('')} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, color: 'inherit', fontWeight: 800 }}>✕</button>
        </div>
      )}

      <div style={{ ...card, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar número ou cliente"
          style={{ ...inp, flex: '1 1 220px' }} />
        <select value={filtroDoc} onChange={e => setFiltroDoc(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
          <option value="">Orçamentos e faturas</option>
          <option value="estimate">Só orçamentos</option>
          <option value="invoice">Só faturas</option>
        </select>
        <select value={filtroStatus} onChange={e => setFiltroStatus(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
          <option value="">Todas as situações</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.rotulo}</option>)}
        </select>
        <button onClick={() => setAbrirNovo(v => !v)} style={btn('#2D3278')}>
          {abrirNovo ? 'Fechar' : '➕ Novo documento'}
        </button>
      </div>

      {abrirNovo && (
        <section style={card}>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 18, color: '#0F2340', margin: '0 0 12px', fontWeight: 400 }}>
            Novo documento
          </h2>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <select value={fCliente} onChange={e => setFCliente(e.target.value)} style={{ ...inp, flex: '2 1 240px', cursor: 'pointer' }}>
              <option value="">— cliente —</option>
              {(dados.clients || []).map((c: any) => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
            <select value={fTipo} onChange={e => setFTipo(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
              <option value="invoice">Fatura</option>
              <option value="estimate">Orçamento</option>
            </select>
            <input type="date" value={fVenc} onChange={e => setFVenc(e.target.value)} style={inp} />
            <select value={fPlano} onChange={e => setFPlano(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
              <option value="full">À vista</option>
              <option value="installments">Parcelado</option>
              <option value="financed">Financiado</option>
              <option value="manual">Combinado</option>
            </select>
            <select value={fForma} onChange={e => setFForma(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
              <option value="">Forma prevista</option>
              {FORMAS.map(([k, r]) => <option key={k} value={k}>{r}</option>)}
            </select>
          </div>

          {itens.map((it, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <input value={it.description} placeholder="Descrição do serviço"
                onChange={e => setItens(a => a.map((x, i) => i === idx ? { ...x, description: e.target.value } : x))}
                style={{ ...inp, flex: '3 1 240px' }} />
              <input type="number" value={it.qty} min={1}
                onChange={e => setItens(a => a.map((x, i) => i === idx ? { ...x, qty: Number(e.target.value) } : x))}
                style={{ ...inp, width: 80 }} />
              <input type="number" value={it.unitPrice} step="0.01" placeholder="0.00"
                onChange={e => setItens(a => a.map((x, i) => i === idx ? { ...x, unitPrice: Number(e.target.value) } : x))}
                style={{ ...inp, width: 120 }} />
              {itens.length > 1 && (
                <button onClick={() => setItens(a => a.filter((_, i) => i !== idx))} style={acaoBtn('#B02020')}>remover</button>
              )}
            </div>
          ))}
          <button onClick={() => setItens(a => [...a, { description: '', qty: 1, unitPrice: 0 }])}
            style={{ ...acaoBtn('#2D3278'), marginBottom: 12 }}>➕ adicionar item</button>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {perms?.darDesconto && (
              <label style={{ fontSize: 13.5, color: '#4A5A70' }}>
                Desconto{' '}
                <input type="number" value={fDesconto} step="0.01"
                  onChange={e => setFDesconto(e.target.value)} style={{ ...inp, width: 110 }} />
              </label>
            )}
            <input value={fNotas} onChange={e => setFNotas(e.target.value)} placeholder="Observações"
              style={{ ...inp, flex: '1 1 220px' }} />
            <span style={{ fontSize: 16, fontWeight: 800, color: '#0F2340' }}>
              {money(itens.reduce((s, i) => s + (i.qty || 1) * (i.unitPrice || 0), 0) - (Number(fDesconto) || 0))}
            </span>
            <button onClick={criar} disabled={busy} style={btn('#1A6B4A', busy)}>Criar rascunho</button>
          </div>
        </section>
      )}

      {loading ? <p style={{ fontSize: 15, color: '#6A7A9A' }}>Carregando…</p> : (
        <div style={{ ...card, overflowX: 'auto' as const }}>
          {lista.length === 0 ? (
            <p style={{ fontSize: 15, color: '#4A5A70', margin: 0 }}>Nenhum documento ainda.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, minWidth: 860 }}>
              <thead><tr>
                {['Número', 'Cliente', 'Emissão', 'Vencimento', 'Total', 'Saldo', 'Situação', ''].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '9px 10px', fontSize: 11, fontWeight: 800,
                    color: '#6A7A9A', textTransform: 'uppercase' as const, borderBottom: '1px solid #E2E8F4', whiteSpace: 'nowrap' as const }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {lista.map(inv => {
                  const st = STATUS[inv.status] || { rotulo: inv.status, cor: '#6A7A9A' }
                  return (
                    <tr key={inv.id} style={{ borderBottom: '1px solid #F0F4FA' }}>
                      <td style={{ padding: '10px', fontSize: 14, fontWeight: 700, color: '#0F2340', whiteSpace: 'nowrap' as const }}>
                        {inv.number}
                        <div style={{ fontSize: 11, color: '#6A7A9A', fontWeight: 500 }}>
                          {inv.doc_type === 'estimate' ? 'orçamento' : 'fatura'}
                        </div>
                      </td>
                      <td style={{ padding: '10px', fontSize: 14 }}>{inv.cliente}</td>
                      <td style={{ padding: '10px', fontSize: 13.5, whiteSpace: 'nowrap' as const }}>{dataUS(inv.issue_date)}</td>
                      <td style={{ padding: '10px', fontSize: 13.5, whiteSpace: 'nowrap' as const }}>{dataUS(inv.due_date)}</td>
                      <td style={{ padding: '10px', fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap' as const }}>{money(inv.total)}</td>
                      <td style={{ padding: '10px', fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap' as const,
                        color: inv.saldo > 0 ? '#B02020' : '#1A6B4A' }}>{money(inv.saldo)}</td>
                      <td style={{ padding: '10px' }}>
                        <span style={{ fontSize: 12.5, fontWeight: 800, padding: '4px 10px', borderRadius: 20,
                          color: st.cor, background: `${st.cor}14`, whiteSpace: 'nowrap' as const }}>{st.rotulo}</span>
                      </td>
                      <td style={{ padding: '10px', whiteSpace: 'nowrap' as const }}>
                        {inv.status === 'draft' && perms?.cancelar && (
                          <button onClick={() => acao(inv, 'send')} disabled={busy} style={acaoBtn('#2D3278')}>Enviar</button>
                        )}
                        {perms?.receber && inv.saldo > 0 && inv.status !== 'void' && inv.status !== 'draft' && (
                          <button onClick={() => { setReceber(inv); setRValor(String(inv.saldo)) }} style={acaoBtn('#1A6B4A')}>Receber</button>
                        )}
                        {perms?.duplicar && (
                          <button onClick={() => acao(inv, 'duplicate')} disabled={busy} style={acaoBtn('#6A7A9A')}>Duplicar</button>
                        )}
                        {perms?.cancelar && inv.status !== 'void' && (
                          <button onClick={() => acao(inv, 'cancel', `Cancelar ${inv.number}? Ela continua no histórico.`)}
                            disabled={busy} style={acaoBtn('#C06010')}>Cancelar</button>
                        )}
                        {perms?.apagar && Number(inv.paid_total) === 0 && (
                          <button onClick={() => apagar(inv)} disabled={busy} style={acaoBtn('#B02020')}>Apagar</button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {receber && (
        <div onClick={() => setReceber(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,35,64,0.55)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: '22px 24px', maxWidth: 460, width: '100%' }}>
            <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 18, color: '#0F2340', margin: '0 0 4px', fontWeight: 400 }}>
              Receber {receber.number}
            </h3>
            <p style={{ fontSize: 13.5, color: '#6A7A9A', margin: '0 0 14px' }}>
              {receber.cliente} · saldo {money(receber.saldo)}
            </p>

            <label style={{ display: 'block', fontSize: 12, fontWeight: 800, color: '#6A7A9A', marginBottom: 3 }}>Valor recebido</label>
            <input type="number" step="0.01" value={rValor} onChange={e => setRValor(e.target.value)}
              style={{ ...inp, width: '100%', marginBottom: 10, boxSizing: 'border-box' as const }} />

            <label style={{ display: 'block', fontSize: 12, fontWeight: 800, color: '#6A7A9A', marginBottom: 3 }}>Forma</label>
            <select value={rForma} onChange={e => setRForma(e.target.value)}
              style={{ ...inp, width: '100%', marginBottom: 10, cursor: 'pointer' }}>
              {FORMAS.map(([k, r]) => <option key={k} value={k}>{r}</option>)}
            </select>
            {['zelle', 'venmo', 'cash'].includes(rForma) && (
              <p style={{ fontSize: 12, color: '#C06010', margin: '0 0 10px', fontWeight: 700 }}>
                Dinheiro, Zelle e Venmo são à vista: informe o valor integral do saldo.
              </p>
            )}

            <label style={{ display: 'block', fontSize: 12, fontWeight: 800, color: '#6A7A9A', marginBottom: 3 }}>Referência (Conf#, nº do cheque)</label>
            <input value={rRef} onChange={e => setRRef(e.target.value)}
              style={{ ...inp, width: '100%', marginBottom: 14, boxSizing: 'border-box' as const }} />

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setReceber(null)} style={btn('#6A7A9A')}>Cancelar</button>
              <button onClick={salvarRecebimento} disabled={busy} style={btn('#1A6B4A', busy)}>Registrar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
