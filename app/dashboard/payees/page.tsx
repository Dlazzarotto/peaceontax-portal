'use client'
// Listas → Fornecedores e clientes
// Visão de todos os clientes, com o que define o comportamento de cada nome:
// escopo (geral × de um cliente), tipo (vendor/customer) e conta contábil.
// Trocar a conta aqui move os lançamentos em aberto e ajusta a regra que
// classifica o nome — é ela que vale nas próximas importações.
//
// POR QUE A LINHA NÃO TRAZ A LISTA DE CLIENTES
// Esta tela derrubava a aba do navegador (`RESULT_CODE_HUNG`): cada linha
// montava um <select> com TODOS os clientes da firma. São quase mil, e o
// cadastro de fornecedores passa dos milhares — 500 linhas já são 532 mil
// <option> construídos de uma vez, e o Chrome mata a aba muito antes disso.
// O custo não é da lista: é do PRODUTO linhas × clientes, e por isso filtrar
// não salvava (quem abre a tela vê tudo antes de filtrar).
// Duas travas, e as duas precisam existir:
//   · o seletor de escopo só nasce na linha que está sendo editada — trocar
//     escopo é raro e pede confirmação; manter mil opções em cada linha para
//     um clique por mês é o que custou a aba;
//   · a tabela desenha POR_PAGINA linhas por vez. Sem isto, bastaria o
//     cadastro crescer para o mesmo travamento voltar por outro caminho.

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface Payee {
  id: string; name: string; type: string
  clientId: string | null; cliente: string; escopo: 'client' | 'global'
  conta: string | null
  regraId: string | null; regraNome: string | null; regraEscopo: 'client' | 'global' | null
}
interface ClienteRef { id: string; nome: string }
interface Conta { name: string; kind: string }

// Quantas linhas a tabela desenha por vez. O teto é do RENDER, não da busca:
// filtrar e contar continuam valendo sobre o cadastro inteiro.
const POR_PAGINA = 100

export default function PayeesPage() {
  const [payees, setPayees] = useState<Payee[]>([])
  const [clientes, setClientes] = useState<ClienteRef[]>([])
  const [contas, setContas] = useState<Conta[]>([])
  const [podeEscopo, setPodeEscopo] = useState(false)
  const [busca, setBusca] = useState('')
  const [cliente, setCliente] = useState('all')
  const [tipo, setTipo] = useState('all')
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [mostrar, setMostrar] = useState(POR_PAGINA)
  // id da linha cujo escopo está sendo editado — e só ela monta o seletor
  // com a lista de clientes.
  const [editandoEscopo, setEditandoEscopo] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const d = await fetch('/api/bookkeeping/payees?all=1').then(r => r.json())
      if (d?.payees) {
        setPayees(d.payees)
        setClientes(d.clientes || [])
        setContas(d.contas || [])
        setPodeEscopo(!!d.podeEscopo)
      } else setMsg(`⚠️ ${d?.error || 'Não foi possível carregar.'}`)
    } catch (e) { setMsg(`⚠️ ${(e as Error).message}`) }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const patch = async (p: Payee, body: any, aviso: string) => {
    setBusy(true); setMsg('')
    const d = await fetch('/api/bookkeeping/payees', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: p.id, ...body }),
    }).then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${aviso}${d.message ? ` — ${d.message}` : ''}`)
    setEditandoEscopo(null)
    load()
  }

  // Escopo: "" = geral (todos os clientes); id = só aquele cliente
  const trocarEscopo = (p: Payee, valor: string) => {
    if (valor === (p.clientId || '')) { setEditandoEscopo(null); return }
    const nomeDestino = valor ? (clientes.find(c => c.id === valor)?.nome || 'esse cliente') : null
    const aviso = nomeDestino
      ? `Deixar "${p.name}" só para ${nomeDestino}?\n\nO cadastro sai da lista geral. Os lançamentos que já usam esse nome em outros clientes continuam como estão — o nome é texto no lançamento.`
      : `Tornar "${p.name}" um fornecedor geral, válido para todos os clientes?`
    if (!confirm(aviso)) { setEditandoEscopo(null); return }
    patch(p, valor ? { scope: 'client', targetClientId: valor } : { scope: 'global' }, 'Escopo atualizado')
  }

  const trocarConta = (p: Payee, conta: string) => {
    if (!conta || conta === p.conta) return
    const onde = p.escopo === 'global' ? 'de todos os clientes' : `de ${p.cliente}`
    if (!confirm(`Classificar "${p.name}" em "${conta}"?\n\nOs lançamentos ${onde} que ainda estão em aberto vão para essa conta. O que já está no registro aprovado não é tocado.`)) { load(); return }
    patch(p, { category: conta }, 'Conta atualizada')
  }

  const apagar = async (p: Payee) => {
    if (!confirm(`Apagar "${p.name}" do cadastro de ${p.cliente}?\n\nSe houver lançamentos com esse nome, o nome sai dos que ainda estão em aberto.`)) return
    setBusy(true); setMsg('')
    const d = await fetch(`/api/bookkeeping/payees?id=${p.id}&limpar=1`, { method: 'DELETE' })
      .then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`)
    load()
  }

  // Filtro novo, contagem nova: sem isto quem já tinha expandido a lista
  // continuaria desenhando centenas de linhas do resultado seguinte.
  useEffect(() => { setMostrar(POR_PAGINA); setEditandoEscopo(null) }, [busca, cliente, tipo])

  const nomesClientes = Array.from(new Set(payees.filter(p => p.escopo === 'client').map(p => p.cliente))).sort()
  const q = busca.trim().toLowerCase()
  const lista = payees
    .filter(p => cliente === 'all' || (cliente === '__global' ? p.escopo === 'global' : p.cliente === cliente))
    .filter(p => tipo === 'all' || p.type === tipo)
    .filter(p => !q || p.name.toLowerCase().includes(q) || p.cliente.toLowerCase().includes(q))

  // O teto é do desenho. `lista` continua inteira para contar e para o botão
  // saber quanto falta.
  const naTela = lista.slice(0, mostrar)

  const card: React.CSSProperties = { background: '#fff', border: '1px solid #E2E8F4', borderRadius: 16, padding: '18px 20px', marginBottom: 16 }
  const inp: React.CSSProperties = { padding: '10px 12px', border: '1.5px solid #E2E8F4', borderRadius: 9, fontSize: 14.5, outline: 'none' }
  const sel: React.CSSProperties = { padding: '6px 10px', border: '1.5px solid #E2E8F4', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', outline: 'none', maxWidth: 190 }

  return (
    <div style={{ maxWidth: 1180 }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 28, color: '#0F2340', margin: '0 0 4px', fontWeight: 400 }}>
          Fornecedores e clientes
        </h1>
        <p style={{ fontSize: 14.5, color: '#6A7A9A', margin: 0, lineHeight: 1.5 }}>
          Cadastro de todos os clientes da firma. Aqui dá para mudar o escopo (geral × de um
          cliente só), o tipo e a conta contábil. A conta vale para os lançamentos em aberto e
          para a regra que classifica o nome nas próximas importações.
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
        <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar nome ou cliente"
          style={{ ...inp, flex: '1 1 240px' }} />
        <select value={cliente} onChange={e => setCliente(e.target.value)} style={{ ...inp, cursor: 'pointer', maxWidth: 240 }}>
          <option value="all">Todos os clientes</option>
          <option value="__global">Só os gerais</option>
          {nomesClientes.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={tipo} onChange={e => setTipo(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
          <option value="all">Vendors e customers</option>
          <option value="vendor">Só vendors</option>
          <option value="customer">Só customers</option>
        </select>
        <span style={{ fontSize: 14, color: '#6A7A9A', fontWeight: 700 }}>{lista.length} de {payees.length}</span>
      </div>

      {loading ? <p style={{ fontSize: 15, color: '#6A7A9A' }}>Carregando…</p> : (
        <div style={{ ...card, overflowX: 'auto' as const }}>
          {lista.length === 0 ? (
            <p style={{ fontSize: 15, color: '#4A5A70', margin: 0 }}>Nenhum registro encontrado.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, minWidth: 980 }}>
              <thead><tr>
                {['Nome', 'Vale para', 'Tipo', 'Conta contábil', 'Regra', ''].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '8px 10px', fontSize: 11, fontWeight: 800,
                    color: '#6A7A9A', textTransform: 'uppercase' as const, borderBottom: '1px solid #E2E8F4' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {naTela.map(p => (
                  <tr key={p.id} style={{ borderBottom: '1px solid #F0F4FA' }}>
                    <td style={{ padding: '10px', fontSize: 15, fontWeight: 700, color: '#0F2340' }}>{p.name}</td>

                    <td style={{ padding: '10px' }}>
                      {/* A lista de clientes só é montada na linha em edição:
                          era ela, repetida em cada linha, que travava a aba. */}
                      {editandoEscopo === p.id ? (
                        <select value={p.clientId || ''} disabled={busy} autoFocus
                          onChange={e => trocarEscopo(p, e.target.value)}
                          // Fechar no blur SEM espera perde a escolha: em
                          // celular o `change` às vezes chega depois do blur,
                          // e o <select> já teria sido desmontado. É a mesma
                          // espera do autocomplete do payee, pelo mesmo motivo.
                          onBlur={() => setTimeout(() => setEditandoEscopo(null), 200)}
                          style={{ ...sel, cursor: 'pointer' }}>
                          <option value="">🌐 Todos os clientes</option>
                          {clientes.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
                        </select>
                      ) : (
                        <button type="button" disabled={busy || !podeEscopo}
                          onClick={() => setEditandoEscopo(p.id)}
                          title={podeEscopo ? 'Geral (todos os clientes) ou só de um cliente' : 'Só gerente ou sócio troca o escopo'}
                          style={{ ...sel, fontFamily: 'inherit', textAlign: 'left' as const,
                            whiteSpace: 'nowrap' as const, overflow: 'hidden' as const,
                            textOverflow: 'ellipsis' as const,
                            cursor: podeEscopo ? 'pointer' : 'not-allowed',
                            color: p.escopo === 'global' ? '#8A5A00' : '#0F2340',
                            background: p.escopo === 'global' ? '#FFF7E6' : '#fff' }}>
                          {p.escopo === 'global' ? '🌐 Todos os clientes' : p.cliente}{podeEscopo ? ' ▾' : ''}
                        </button>
                      )}
                      {p.clientId && (
                        <Link href={`/clients/${p.clientId}`} style={{ display: 'block', marginTop: 4, fontSize: 11.5, color: '#2D3278', fontWeight: 700, textDecoration: 'none' }}>
                          abrir cliente →
                        </Link>
                      )}
                    </td>

                    <td style={{ padding: '10px' }}>
                      <select value={p.type} disabled={busy}
                        onChange={e => patch(p, { type: e.target.value }, 'Tipo atualizado')}
                        style={sel}>
                        <option value="vendor">🏪 Vendor</option>
                        <option value="customer">💰 Customer</option>
                      </select>
                    </td>

                    <td style={{ padding: '10px' }}>
                      <select value={p.conta || ''} disabled={busy}
                        onChange={e => trocarConta(p, e.target.value)}
                        style={{ ...sel, fontWeight: p.conta ? 700 : 400, color: p.conta ? '#0F2340' : '#9AAAB0' }}>
                        <option value="">— sem conta definida</option>
                        {contas.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                      </select>
                    </td>

                    <td style={{ padding: '10px', fontSize: 12.5, color: '#6A7A9A' }}>
                      {p.regraEscopo === 'global' ? <span style={{ color: '#8A5A00', fontWeight: 700 }}>geral</span>
                        : p.regraEscopo === 'client' ? <span style={{ color: '#1A6B4A', fontWeight: 700 }}>do cliente</span>
                        : <span title="Sem regra: a conta escolhida vale só para os lançamentos já importados">sem regra</span>}
                    </td>

                    <td style={{ padding: '10px', whiteSpace: 'nowrap' as const }}>
                      <button onClick={() => {
                          const novo = window.prompt('Novo nome:', p.name)
                          if (novo && novo.trim() && novo.trim() !== p.name) patch(p, { newName: novo.trim() }, 'Renomeado')
                        }} disabled={busy}
                        style={{ background: 'none', border: 'none', color: '#2D3278', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
                        Renomear
                      </button>
                      <button onClick={() => apagar(p)} disabled={busy}
                        style={{ background: 'none', border: 'none', color: '#B02020', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', marginLeft: 10 }}>
                        Apagar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {lista.length > naTela.length && (
            <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const }}>
              <button onClick={() => setMostrar(m => m + POR_PAGINA)}
                style={{ padding: '10px 18px', borderRadius: 9, border: '1.5px solid #2D3278',
                  background: '#fff', color: '#2D3278', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                Mostrar mais {Math.min(POR_PAGINA, lista.length - naTela.length)}
              </button>
              <span style={{ fontSize: 13.5, color: '#6A7A9A' }}>
                mostrando {naTela.length} de {lista.length} — use a busca para chegar direto ao nome
              </span>
            </div>
          )}
        </div>
      )}

      <Link href="/dashboard/accounts" style={{ fontSize: 14.5, color: '#2D3278', fontWeight: 700, textDecoration: 'none' }}>
        Plano de contas →
      </Link>
    </div>
  )
}
