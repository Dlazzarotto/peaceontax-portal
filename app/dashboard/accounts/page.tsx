'use client'
// Plano de contas geral — pesquisar, renomear, mudar o grupo e desativar.
// Renomear propaga para os lançamentos, regras e sub-contas.
//
// Cada conta de DESPESA tem o botão do 1099 (decisão do sócio): marcada, toda
// despesa paga nela entra na lista do 1099 de cada cliente, no formulário
// escolhido (NEC para serviço, MISC para aluguel). A regra de quem entra e
// por quanto é de lib/relatorio-1099.ts; a tela só marca.

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ehContaDeDespesa } from '@/lib/relatorio-1099'

interface Cat { id: string; name: string; kind: string; active: boolean; usos?: number; form_1099?: string | null }

const GRUPOS: { key: string; label: string; cor: string }[] = [
  { key: 'income',        label: 'Receitas',            cor: '#1A6B4A' },
  { key: 'cogs',          label: 'Custo dos serviços',  cor: '#C06010' },
  { key: 'expense',       label: 'Despesas',            cor: '#2D3278' },
  { key: 'other_income',  label: 'Outras receitas',     cor: '#0A6A8A' },
  { key: 'other_expense', label: 'Outras despesas',     cor: '#5A1A8A' },
  { key: 'liability',     label: 'Passivo',             cor: '#B02020' },
  { key: 'asset',         label: 'Ativo',               cor: '#6A7A9A' },
  { key: 'non_pnl',       label: 'Fora do resultado',   cor: '#8A9AB0' },
]

export default function ChartOfAccountsPage() {
  const [cats, setCats] = useState<Cat[]>([])
  const [busca, setBusca] = useState('')
  const [grupo, setGrupo] = useState('all')
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editKind, setEditKind] = useState('expense')
  const [busy, setBusy] = useState(false)
  const [novoNome, setNovoNome] = useState('')
  const [novoKind, setNovoKind] = useState('expense')
  const [novoPai, setNovoPai] = useState('')
  // A migração do 1099 ainda não rodou: o botão some e a tela diz por quê
  const [migracao1099, setMigracao1099] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const d = await fetch('/api/bookkeeping/categories?all=1').then(r => r.json())
      if (d?.error) setMsg(`⚠️ ${d.error}`)
      else if (d?.categories) { setCats(d.categories); setMigracao1099(d.semColuna1099 ? d.migracao1099 : null) }
      else setMsg('⚠️ Não foi possível carregar.')
    } catch (e) { setMsg(`⚠️ ${(e as Error).message}`) }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const patch = async (body: any) => {
    setBusy(true); setMsg('')
    const d = await fetch('/api/bookkeeping/categories', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`)
    setEditId(null); load()
  }

  const criar = async () => {
    if (novoNome.trim().length < 2) { setMsg('⚠️ Informe o nome da conta.'); return }
    setBusy(true); setMsg('')
    const d = await fetch('/api/bookkeeping/categories', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: novoNome, kind: novoKind, parent: novoPai || undefined }),
    }).then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ Conta "${novoNome}" criada.`)
    setNovoNome(''); setNovoPai(''); load()
  }

  const apagar = async (c: Cat) => {
    const usos = c.usos || 0
    let destino = ''
    if (usos > 0) {
      const opcoes = cats.filter(x => x.kind === c.kind && x.id !== c.id && x.active).map(x => x.name)
      destino = window.prompt(
        `"${c.name}" está em ${usos} lançamento(s).\n\n` +
        `Para qual conta mover antes de apagar? Copie um nome da lista:\n\n` +
        opcoes.slice(0, 30).join('\n'), opcoes[0] || '') || ''
      if (!destino.trim()) return
    } else if (!confirm(`Apagar "${c.name}" definitivamente?`)) return

    setBusy(true); setMsg('')
    const url = `/api/bookkeeping/categories?id=${c.id}` + (destino ? `&moveTo=${encodeURIComponent(destino.trim())}` : '')
    const d = await fetch(url, { method: 'DELETE' }).then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`)
    load()
  }

  const marcar1099 = (c: Cat, form: 'NEC' | 'MISC' | null) => patch({ id: c.id, form1099: form })

  const q = busca.trim().toLowerCase()
  const lista = cats
    .filter(c => (grupo === 'all' || (grupo === '1099' ? !!c.form_1099 : c.kind === grupo)))
    .filter(c => !q || c.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))

  const card: React.CSSProperties = { background: '#fff', border: '1px solid #E2E8F4', borderRadius: 16, padding: '18px 20px', marginBottom: 16 }
  const inp: React.CSSProperties = { padding: '10px 12px', border: '1.5px solid #E2E8F4', borderRadius: 9, fontSize: 14.5, outline: 'none' }
  const btn = (bg: string, off = false): React.CSSProperties => ({
    padding: '8px 14px', background: off ? '#E2E8F4' : bg, color: off ? '#9AAAB0' : '#fff',
    border: 'none', borderRadius: 9, fontSize: 13.5, fontWeight: 700, cursor: off ? 'not-allowed' : 'pointer',
  })

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 28, color: '#0F2340', margin: '0 0 4px', fontWeight: 400 }}>
          Plano de contas
        </h1>
        <p style={{ fontSize: 14.5, color: '#6A7A9A', margin: 0, lineHeight: 1.5 }}>
          As contas usadas na classificação de todos os clientes. Ao renomear, os lançamentos,
          as regras e as sub-contas são atualizados junto. Alteração restrita a sócio e gerente.
        </p>
        <p style={{ fontSize: 14, color: '#6A7A9A', margin: '8px 0 0', lineHeight: 1.5 }}>
          <b>1099:</b> marque as contas de despesa cujo pagamento a prestador vai para o 1099. Toda despesa
          paga numa conta marcada entra na lista do 1099 de cada cliente. NEC é serviço; MISC é aluguel.
          Pagamento no cartão de crédito ou por PayPal, Venmo e Cash App fica fora, porque vai no 1099-K.
        </p>
        {migracao1099 && (
          <p style={{ fontSize: 13.5, color: '#B02020', fontWeight: 700, margin: '8px 0 0' }}>
            ⚠️ O botão do 1099 aparece depois da migração {migracao1099}.
          </p>
        )}
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

      <section style={card}>
        <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 17, color: '#0F2340', margin: '0 0 10px', fontWeight: 400 }}>
          Nova conta
        </h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input value={novoNome} onChange={e => setNovoNome(e.target.value)} placeholder="Nome da conta"
            style={{ ...inp, flex: '2 1 200px' }} />
          <select value={novoKind} onChange={e => { setNovoKind(e.target.value); setNovoPai('') }}
            style={{ ...inp, flex: '1 1 150px', cursor: 'pointer' }}>
            {GRUPOS.map(g => <option key={g.key} value={g.key}>{g.label}</option>)}
          </select>
          <select value={novoPai} onChange={e => setNovoPai(e.target.value)}
            style={{ ...inp, flex: '1 1 170px', cursor: 'pointer' }}>
            <option value="">Conta principal</option>
            {cats.filter(c => c.kind === novoKind && c.active && !c.name.includes(':'))
              .map(c => <option key={c.id} value={c.name}>sub de: {c.name}</option>)}
          </select>
          <button onClick={criar} disabled={busy} style={btn('#2D3278', busy)}>Criar</button>
        </div>
      </section>

      <div style={{ ...card, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar conta"
          style={{ ...inp, flex: '1 1 240px' }} />
        <select value={grupo} onChange={e => setGrupo(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
          <option value="all">Todos os grupos</option>
          {GRUPOS.map(g => <option key={g.key} value={g.key}>{g.label}</option>)}
          {!migracao1099 && <option value="1099">Só as do 1099</option>}
        </select>
        <span style={{ fontSize: 14, color: '#6A7A9A', fontWeight: 700 }}>
          {lista.length} de {cats.length}
        </span>
      </div>

      {loading ? <p style={{ fontSize: 15, color: '#6A7A9A' }}>Carregando…</p> : (
        <div style={card}>
          {lista.length === 0 ? (
            <p style={{ fontSize: 15, color: '#4A5A70', margin: 0 }}>Nenhuma conta encontrada.</p>
          ) : lista.map(c => {
            const g = GRUPOS.find(x => x.key === c.kind)
            const sub = c.name.includes(':')
            return (
              <div key={c.id} style={{ padding: '11px 0', borderTop: '1px solid #F0F4FA' }}>
                {editId === c.id ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input value={editName} onChange={e => setEditName(e.target.value)}
                      style={{ ...inp, flex: '1 1 220px' }} />
                    <select value={editKind} onChange={e => setEditKind(e.target.value)}
                      style={{ ...inp, cursor: 'pointer' }}>
                      {GRUPOS.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
                    </select>
                    <button onClick={() => patch({ id: c.id, name: editName, kind: editKind })}
                      disabled={busy} style={btn('#1A6B4A', busy)}>Salvar</button>
                    <button onClick={() => setEditId(null)} style={btn('#6A7A9A')}>Cancelar</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                      <span style={{ fontSize: 15.5, fontWeight: sub ? 500 : 700, color: c.active ? '#0F2340' : '#9AAAB0' }}>
                        {sub ? '↳ ' : ''}{c.name}
                      </span>
                      {!c.active && <span style={{ fontSize: 12, color: '#B02020', marginLeft: 8 }}>inativa</span>}
                    </div>
                    {g && (
                      <span style={{ fontSize: 12.5, fontWeight: 800, padding: '4px 10px', borderRadius: 20, color: g.cor, background: `${g.cor}14` }}>
                        {g.label}
                      </span>
                    )}
                    <span style={{ fontSize: 12.5, color: '#6A7A9A', minWidth: 78, textAlign: 'right' as const }}>
                      {(c.usos ?? 0) > 0 ? `${c.usos} lanç.` : 'sem uso'}
                    </span>
                    {!migracao1099 && ehContaDeDespesa(c.kind) && (c.form_1099 ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span title="Toda despesa paga nesta conta entra na lista do 1099"
                          style={{ fontSize: 12.5, fontWeight: 800, padding: '4px 10px', borderRadius: 20, color: '#8A4A0A', background: '#FFF1DC' }}>
                          1099-{c.form_1099}
                        </span>
                        <button onClick={() => marcar1099(c, c.form_1099 === 'NEC' ? 'MISC' : 'NEC')} disabled={busy}
                          title={c.form_1099 === 'NEC' ? 'Trocar para 1099-MISC (aluguel)' : 'Trocar para 1099-NEC (serviço)'}
                          style={{ background: 'none', border: 'none', color: '#8A4A0A', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                          {c.form_1099 === 'NEC' ? '→ MISC' : '→ NEC'}
                        </button>
                        <button onClick={() => marcar1099(c, null)} disabled={busy} title="Tirar esta conta do 1099"
                          style={{ background: 'none', border: 'none', color: '#B02020', fontSize: 13, fontWeight: 800, cursor: 'pointer' }}>
                          ✕
                        </button>
                      </span>
                    ) : (
                      <button onClick={() => marcar1099(c, 'NEC')} disabled={busy}
                        title="Toda despesa paga nesta conta passa a entrar na lista do 1099"
                        style={{ background: '#fff', border: '1.5px solid #E0A860', color: '#8A4A0A', borderRadius: 20,
                                 padding: '3px 10px', fontSize: 12.5, fontWeight: 800, cursor: 'pointer' }}>
                        ＋ 1099
                      </button>
                    ))}
                    <button onClick={() => { setEditId(c.id); setEditName(c.name.includes(':') ? c.name.split(':')[1].trim() : c.name); setEditKind(c.kind) }}
                      style={{ background: 'none', border: 'none', color: '#2D3278', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
                      Renomear
                    </button>
                    <button onClick={() => apagar(c)} disabled={busy}
                      style={{ background: 'none', border: 'none', color: '#B02020', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
                      Apagar
                    </button>
                    {c.active ? (
                      <button onClick={() => patch({ id: c.id, active: false })} disabled={busy}
                        style={{ background: 'none', border: 'none', color: '#B02020', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
                        Desativar
                      </button>
                    ) : (
                      <button onClick={() => patch({ id: c.id, active: true })} disabled={busy}
                        style={{ background: 'none', border: 'none', color: '#1A6B4A', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
                        Reativar
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <Link href="/dashboard" style={{ fontSize: 14.5, color: '#2D3278', fontWeight: 700, textDecoration: 'none' }}>
        ← Voltar ao painel
      </Link>
    </div>
  )
}
