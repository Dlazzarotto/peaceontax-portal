'use client'
// Plano de contas geral — pesquisar, editar (nome, grupo, conta-mãe e 1099),
// desativar e apagar.
//
// O que cada mudança pode e o que ela leva junto é de lib/plano-de-contas.ts:
// a tela chama a MESMA função da rota (planoDaEdicao) para mostrar antes de
// salvar o que vai mudar, quantos lançamentos a mudança alcança e se ela pede
// motivo e senha. A rota decide; o banco grava tudo numa transação só.
//
// Cada conta de DESPESA tem o botão do 1099 (decisão do sócio): marcada, toda
// despesa paga nela entra na lista do 1099 de cada cliente, no formulário
// escolhido (NEC para serviço, MISC para aluguel). A regra de quem entra e
// por quanto é de lib/relatorio-1099.ts; a tela só marca.

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ehContaDeDespesa } from '@/lib/relatorio-1099'
import {
  planoDaEdicao, planoDaRemocao, recusaDaDesativacao, pedidoDoFormulario, contaDoSistema,
  partesDoNome, filhasDe, ROTULO_DO_GRUPO, GRUPOS_DO_PLANO, ehGrupoDoPlano, MOTIVO_MINIMO,
  type ContaDoPlano,
} from '@/lib/plano-de-contas'

interface Cat { id: string; name: string; kind: string; active: boolean; usos?: number; regras?: number; form_1099?: string | null }

const COR: Record<string, string> = {
  income: '#1A6B4A', cogs: '#C06010', expense: '#2D3278', other_income: '#0A6A8A',
  other_expense: '#5A1A8A', liability: '#B02020', asset: '#6A7A9A', non_pnl: '#8A9AB0',
}
const GRUPOS = GRUPOS_DO_PLANO.map(key => ({ key, label: ROTULO_DO_GRUPO[key], cor: COR[key] }))

export default function ChartOfAccountsPage() {
  const [cats, setCats] = useState<Cat[]>([])
  const [busca, setBusca] = useState('')
  const [grupo, setGrupo] = useState('all')
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [novoNome, setNovoNome] = useState('')
  const [novoKind, setNovoKind] = useState('expense')
  const [novoPai, setNovoPai] = useState('')
  // A migração do 1099 ainda não rodou: o botão some e a tela diz por quê
  const [migracao1099, setMigracao1099] = useState<string | null>(null)

  // Editar: uma conta aberta por vez
  const [editId, setEditId] = useState<string | null>(null)
  const [editNome, setEditNome] = useState('')
  const [editMae, setEditMae] = useState('')
  const [editKind, setEditKind] = useState('')
  const [editForm, setEditForm] = useState('')
  const [editMotivo, setEditMotivo] = useState('')
  const [editSenha, setEditSenha] = useState('')

  // Apagar: o destino e o motivo, na própria linha
  const [apagarId, setApagarId] = useState<string | null>(null)
  const [destino, setDestino] = useState('')
  const [motivoApagar, setMotivoApagar] = useState('')

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

  const plano: ContaDoPlano[] = cats.map(c => ({ id: String(c.id), name: c.name, kind: c.kind, active: c.active !== false, form_1099: c.form_1099 ?? null }))
  const usos: Record<string, number> = Object.fromEntries(cats.map(c => [c.name, c.usos || 0]))
  const contaDe = (c: Cat) => plano.find(x => x.id === String(c.id))!

  const enviar = async (metodo: 'PATCH' | 'DELETE', url: string, body: any): Promise<boolean> => {
    setBusy(true); setMsg('')
    const d = await fetch(url, {
      method: metodo, headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return false }
    setMsg(`✓ ${d.message}`)
    load()
    return true
  }
  const patch = (body: any) => enviar('PATCH', '/api/bookkeeping/categories', body)

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

  const abrirEdicao = (c: Cat) => {
    const p = partesDoNome(c.name)
    setApagarId(null)
    setEditId(c.id); setEditNome(p.base); setEditMae(p.mae || '')
    setEditKind(ehGrupoDoPlano(c.kind) ? c.kind : '')
    setEditForm(c.form_1099 || ''); setEditMotivo(''); setEditSenha('')
  }

  // O pedido leva só o que mudou (campo ausente é "mantém" para a regra)
  const pedidoDaEdicao = (c: Cat) => pedidoDoFormulario(
    contaDe(c), { nome: editNome, mae: editMae, kind: editKind, form1099: editForm }, plano, !migracao1099)

  const salvarEdicao = async (c: Cat, previa: ReturnType<typeof planoDaEdicao>) => {
    if (previa.ok === false) return
    const ok = await patch({
      id: c.id, ...pedidoDaEdicao(c),
      ...(previa.exigeMotivo ? { motivo: editMotivo } : {}),
      ...(previa.exigeSenha ? { senha: editSenha } : {}),
    })
    if (ok) setEditId(null)
  }

  const abrirRemocao = (c: Cat) => {
    setEditId(null)
    setApagarId(c.id); setDestino(''); setMotivoApagar('')
  }

  const apagar = async (c: Cat) => {
    const url = `/api/bookkeeping/categories?id=${encodeURIComponent(c.id)}` + (destino ? `&moveTo=${encodeURIComponent(destino)}` : '')
    const ok = await enviar('DELETE', url, { motivo: motivoApagar })
    if (ok) setApagarId(null)
  }

  const desativar = (c: Cat) => {
    const recusa = recusaDaDesativacao(contaDe(c), c.usos || 0, c.regras || 0)
    if (recusa) { setMsg(`⚠️ ${recusa}`); return }
    patch({ id: c.id, active: false })
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
  const link = (cor: string): React.CSSProperties => ({ background: 'none', border: 'none', color: cor, fontSize: 13.5, fontWeight: 700, cursor: 'pointer' })
  const rotuloCampo: React.CSSProperties = { display: 'block', fontSize: 12.5, fontWeight: 800, color: '#4A5A70', marginBottom: 4 }
  const painel: React.CSSProperties = { marginTop: 10, padding: '14px 16px', background: '#F7F9FC', border: '1px solid #E2E8F4', borderRadius: 12 }

  const painelDeEdicao = (c: Cat) => {
    const conta = contaDe(c)
    const sistema = contaDoSistema(c.name)
    const filhas = filhasDe(conta, plano)
    const mae = plano.find(x => x.name === editMae)
    const kindFinal = editMae ? (mae?.kind ?? c.kind) : editKind
    const pedido = pedidoDaEdicao(c)
    const nadaMudou = Object.keys(pedido).length === 0
    const previa = planoDaEdicao({ conta, pedido, plano, usos })
    const faltaMotivo = previa.ok && previa.exigeMotivo && editMotivo.trim().length < MOTIVO_MINIMO
    const faltaSenha = previa.ok && previa.exigeSenha && !editSenha.trim()
    const pode = previa.ok && !faltaMotivo && !faltaSenha && !busy
    // A mãe atual entra mesmo inativa: sem ela, o seletor mostraria "conta
    // principal" para uma sub-conta — e a prévia diz o que fazer.
    const maeAtual = partesDoNome(c.name).mae
    const maes = plano.filter(x => !x.name.includes(':') && x.id !== conta.id && (x.active || x.name === maeAtual))
      .sort((a, b) => a.name.localeCompare(b.name))

    return (
      <div style={painel}>
        {sistema && (
          <p style={{ fontSize: 13.5, color: '#4A5A70', margin: '0 0 10px', lineHeight: 1.5 }}>
            🔒 <b>Conta do sistema:</b> {sistema}. Nome, grupo e conta-mãe dela não mudam — renomear faria o
            sistema seguir gravando o nome antigo, numa conta que o plano não tem, e o P&amp;L a contaria como despesa.
          </p>
        )}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ flex: '2 1 220px' }}>
            <span style={rotuloCampo}>Nome</span>
            <input value={editNome} onChange={e => setEditNome(e.target.value)} disabled={!!sistema}
              style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
          </label>
          <label style={{ flex: '1 1 200px' }}>
            <span style={rotuloCampo}>Conta-mãe</span>
            <select value={editMae} onChange={e => setEditMae(e.target.value)} disabled={!!sistema || filhas.length > 0}
              title={filhas.length > 0 ? `Tem ${filhas.length} sub-conta(s): fica conta principal` : undefined}
              style={{ ...inp, width: '100%', cursor: 'pointer' }}>
              <option value="">— conta principal —</option>
              {maes.map(m => <option key={m.id} value={m.name}>sub de: {m.name}{m.active ? '' : ' (inativa)'}</option>)}
            </select>
          </label>
          <label style={{ flex: '1 1 170px' }}>
            <span style={rotuloCampo}>Grupo</span>
            {editMae ? (
              <div style={{ ...inp, background: '#EEF2F8', color: '#4A5A70' }}
                title="A sub-conta fica no grupo da conta-mãe">
                {ehGrupoDoPlano(kindFinal) ? ROTULO_DO_GRUPO[kindFinal] : kindFinal} (o da mãe)
              </div>
            ) : (
              <select value={editKind} onChange={e => setEditKind(e.target.value)} disabled={!!sistema}
                style={{ ...inp, width: '100%', cursor: 'pointer' }}>
                {!ehGrupoDoPlano(c.kind) && <option value="">— escolha (era &quot;{c.kind}&quot;) —</option>}
                {GRUPOS.map(g => <option key={g.key} value={g.key}>{g.label}</option>)}
              </select>
            )}
          </label>
          {!migracao1099 && ehContaDeDespesa(kindFinal) && (
            <label style={{ flex: '1 1 170px' }}>
              <span style={rotuloCampo}>1099</span>
              <select value={editForm} onChange={e => setEditForm(e.target.value)}
                style={{ ...inp, width: '100%', cursor: 'pointer' }}>
                <option value="">Fora do 1099</option>
                <option value="NEC">1099-NEC — serviço</option>
                <option value="MISC">1099-MISC — aluguel</option>
              </select>
            </label>
          )}
        </div>

        {!nadaMudou && (
          previa.ok === true ? (
            <div style={{ marginTop: 12, fontSize: 13.5, color: '#0F2340', lineHeight: 1.55 }}>
              <div><b>Vai mudar:</b> {previa.resumo}</div>
              {previa.avisos.map((a, i) => (
                <div key={i} style={{ color: /TODOS os clientes/.test(a) ? '#B02020' : '#8A4A0A', fontWeight: /TODOS os clientes/.test(a) ? 700 : 600 }}>
                  ⚠️ {a}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ marginTop: 12, fontSize: 13.5, color: '#B02020', fontWeight: 700 }}>⚠️ {previa.erro}</div>
          )
        )}

        {previa.ok && (previa.exigeMotivo || previa.exigeSenha) && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
            {previa.exigeMotivo && (
              <label style={{ flex: '2 1 260px' }}>
                <span style={rotuloCampo}>Motivo (fica na trilha) — mínimo {MOTIVO_MINIMO} caracteres</span>
                <input value={editMotivo} onChange={e => setEditMotivo(e.target.value)}
                  placeholder="Por que esta conta está mudando?"
                  style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
              </label>
            )}
            {previa.exigeSenha && (
              <label style={{ flex: '1 1 200px' }}>
                <span style={rotuloCampo}>A sua senha (mudar o grupo muda relatórios passados)</span>
                <input type="password" value={editSenha} onChange={e => setEditSenha(e.target.value)}
                  autoComplete="current-password"
                  style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
              </label>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={() => salvarEdicao(c, previa)} disabled={!pode} style={btn('#1A6B4A', !pode)}>
            {busy ? 'Salvando…' : 'Salvar'}
          </button>
          <button onClick={() => setEditId(null)} style={btn('#6A7A9A')}>Cancelar</button>
        </div>
      </div>
    )
  }

  const painelDeRemocao = (c: Cat) => {
    const conta = contaDe(c)
    const usosDela = c.usos || 0
    const regrasDela = c.regras || 0
    const emUso = usosDela + regrasDela > 0
    const previa = planoDaRemocao({ conta, plano, lancamentos: usosDela, regras: regrasDela, destino: destino || null })
    const destinos = plano.filter(x => x.kind === c.kind && x.active && x.id !== conta.id)
      .sort((a, b) => a.name.localeCompare(b.name))
    const faltaMotivo = previa.ok && previa.exigeMotivo && motivoApagar.trim().length < MOTIVO_MINIMO
    const pode = previa.ok && !faltaMotivo && !busy

    return (
      <div style={{ ...painel, background: '#FFF7F7', borderColor: '#F3D4D4' }}>
        <p style={{ fontSize: 13.5, color: '#4A5A70', margin: '0 0 10px', lineHeight: 1.5 }}>
          {emUso
            ? <>&quot;{c.name}&quot; está em {usosDela} lançamento(s) e {regrasDela} regra(s). Tudo vai para a conta que você escolher, do mesmo grupo, e então ela sai do plano.</>
            : <>&quot;{c.name}&quot; não tem lançamento nem regra: ela sai do plano.</>}
        </p>
        {emUso && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ flex: '1 1 220px' }}>
              <span style={rotuloCampo}>Mover para</span>
              <select value={destino} onChange={e => setDestino(e.target.value)} style={{ ...inp, width: '100%', cursor: 'pointer' }}>
                <option value="">— escolha a conta —</option>
                {destinos.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
              </select>
            </label>
            {usosDela > 0 && (
              <label style={{ flex: '2 1 260px' }}>
                <span style={rotuloCampo}>Motivo (fica na trilha) — mínimo {MOTIVO_MINIMO} caracteres</span>
                <input value={motivoApagar} onChange={e => setMotivoApagar(e.target.value)}
                  placeholder="Por que juntar estas contas?"
                  style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
              </label>
            )}
          </div>
        )}
        {/* "Escolha o destino" já é o seletor acima; qualquer outra recusa aparece na hora */}
        {previa.ok === false && !('emUso' in previa) && (
          <div style={{ marginTop: 10, fontSize: 13.5, color: '#B02020', fontWeight: 700 }}>⚠️ {previa.erro}</div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={() => apagar(c)} disabled={!pode} style={btn('#B02020', !pode)}>
            {busy ? 'Apagando…' : 'Apagar de vez'}
          </button>
          <button onClick={() => setApagarId(null)} style={btn('#6A7A9A')}>Cancelar</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 28, color: '#0F2340', margin: '0 0 4px', fontWeight: 400 }}>
          Plano de contas
        </h1>
        <p style={{ fontSize: 14.5, color: '#6A7A9A', margin: 0, lineHeight: 1.5 }}>
          As contas usadas na classificação de todos os clientes. <b>Editar</b> muda o nome, o grupo, a
          conta-mãe e o 1099; os lançamentos, as regras, as contas a pagar e as sub-contas vão junto, numa
          gravação só, e a mudança fica na trilha. Conta em uso pede motivo; mudar o <b>grupo</b> de uma conta
          em uso pede também a sua senha, porque muda os relatórios de anos passados. As contas 🔒 do sistema
          não mudam de nome nem de grupo. Alteração restrita a sócio e gerente.
        </p>
        <p style={{ fontSize: 14, color: '#6A7A9A', margin: '8px 0 0', lineHeight: 1.5 }}>
          <b>1099:</b> marque as contas de despesa cujo pagamento a prestador vai para o 1099. Toda despesa
          paga numa conta marcada entra na lista do 1099 de cada cliente. NEC é serviço; MISC é aluguel.
          Pagamento no cartão de crédito ou por PayPal, Venmo e Cash App fica fora, porque vai no 1099-K.
        </p>
        {migracao1099 && (
          <p style={{ fontSize: 13.5, color: '#B02020', fontWeight: 700, margin: '8px 0 0' }}>
            ⚠️ O botão do 1099 e o Editar aparecem depois da migração {migracao1099}.
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
            const sistema = contaDoSistema(c.name)
            return (
              <div key={c.id} style={{ padding: '11px 0', borderTop: '1px solid #F0F4FA' }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                    <span style={{ fontSize: 15.5, fontWeight: sub ? 500 : 700, color: c.active ? '#0F2340' : '#9AAAB0' }}>
                      {sub ? '↳ ' : ''}{c.name}
                    </span>
                    {sistema && (
                      <span title={`Conta do sistema: ${sistema}`}
                        style={{ fontSize: 12, fontWeight: 800, color: '#4A5A70', background: '#EEF2F8', borderRadius: 20, padding: '2px 8px', marginLeft: 8 }}>
                        🔒 do sistema
                      </span>
                    )}
                    {!c.active && <span style={{ fontSize: 12, color: '#B02020', marginLeft: 8 }}>inativa</span>}
                  </div>
                  {g ? (
                    <span style={{ fontSize: 12.5, fontWeight: 800, padding: '4px 10px', borderRadius: 20, color: g.cor, background: `${g.cor}14` }}>
                      {g.label}
                    </span>
                  ) : (
                    <span title="Grupo fora da lista: a conta não entra em nenhuma seção do P&L nem do Balanço. Edite e escolha o grupo."
                      style={{ fontSize: 12.5, fontWeight: 800, padding: '4px 10px', borderRadius: 20, color: '#B02020', background: '#FEE2E2' }}>
                      ⚠️ {c.kind || 'sem grupo'}
                    </span>
                  )}
                  <span style={{ fontSize: 12.5, color: '#6A7A9A', minWidth: 78, textAlign: 'right' as const }}>
                    {(c.usos ?? 0) > 0 ? `${c.usos} lanç.` : 'sem uso'}
                    {(c.regras ?? 0) > 0 ? ` · ${c.regras} regra(s)` : ''}
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
                  {!migracao1099 && (
                    <button onClick={() => editId === c.id ? setEditId(null) : abrirEdicao(c)}
                      style={{ ...link('#2D3278'), textDecoration: editId === c.id ? 'underline' : 'none' }}>
                      ✏️ Editar
                    </button>
                  )}
                  {!sistema && (
                    <button onClick={() => apagarId === c.id ? setApagarId(null) : abrirRemocao(c)} disabled={busy}
                      style={link('#B02020')}>
                      Apagar
                    </button>
                  )}
                  {!sistema && (c.active ? (
                    <button onClick={() => desativar(c)} disabled={busy} style={link('#B02020')}>
                      Desativar
                    </button>
                  ) : (
                    <button onClick={() => patch({ id: c.id, active: true })} disabled={busy} style={link('#1A6B4A')}>
                      Reativar
                    </button>
                  ))}
                </div>
                {editId === c.id && painelDeEdicao(c)}
                {apagarId === c.id && painelDeRemocao(c)}
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
