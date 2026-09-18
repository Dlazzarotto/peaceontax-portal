'use client'
import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ROTULO_SITUACAO, type ResumoTipo, ZERADO } from '@/lib/clientes-grupos'

const STAGES = ['Onboarding','Gathering Docs','In Preparation','Under Review','Filed','Complete']
const STAGE_COLOR: Record<string,string> = {
  'Onboarding':      '#6a7a9a',
  'Gathering Docs':  '#c06010',
  'In Preparation':  '#2D3278',
  'Under Review':    '#5a1a8a',
  'Filed':           '#1a6b4a',
  'Complete':        '#1a6b4a',
}
const STAGE_BG: Record<string,string> = {
  'Onboarding':      '#f0f4fa',
  'Gathering Docs':  '#fff4e8',
  'In Preparation':  '#e8f0ff',
  'Under Review':    '#f0e8ff',
  'Filed':           '#e8f5ee',
  'Complete':        '#e8f5ee',
}

type ViewMode = 'kanban' | 'list'

export default function ClientsPage() {
  // A entrada da tela são dois cartões — Empresas e Pessoa física. O quadro só
  // abre depois de escolher um tipo, e já vem separado. Antes tudo caía num
  // quadro de seis colunas: a fila da temporada escondia quem está parado há
  // meses, e com quase mil cadastros nem dava para ler.
  const router = useRouter()
  const params = useSearchParams()
  const tipo = params.get('tipo') === 'business' ? 'business'
    : params.get('tipo') === 'individual' ? 'individual' : null

  const [clients,  setClients]  = useState<any[]>([])
  const [loading,  setLoading]  = useState(true)
  const [view,     setView]     = useState<ViewMode>('kanban')
  const [search,   setSearch]   = useState('')
  const [filter,   setFilter]   = useState('all')
  const [showNew,  setShowNew]  = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)

  const [resumo, setResumo] = useState<Record<string, ResumoTipo> | null>(null)
  // Quais tipos esta pessoa pode ver. Vem do SERVIDOR: sem `verEmpresas`, a
  // rota não conta nem devolve empresas, então o cartão não tem o que mostrar.
  const [tiposVisiveis, setTiposVisiveis] = useState<string[]>(['business', 'individual'])
  const [enviando, setEnviando] = useState<string | null>(null)
  // Contador de recarga. router.refresh() atualiza o componente de servidor,
  // e os dados desta tela vêm de um fetch no cliente: sem mexer nas
  // dependências do efeito, ele nunca refazia a busca. Depois de importar, os
  // cartões ficavam em zero — como se nada tivesse entrado.
  const [recarga, setRecarga] = useState(0)
  const [aviso, setAviso] = useState('')

  const load = (q = '') => {
    if (!tipo) return
    setLoading(true)
    const busca = new URLSearchParams({ type: tipo })
    if (q) busca.set('search', q)
    if (filter !== 'all' && filter !== 'individual' && filter !== 'business') busca.set('stage', filter)
    fetch(`/api/clients?${busca}`).then(r => r.json()).then(d => { setClients(d.clients || []); setLoading(false) })
  }

  useEffect(() => {
    if (tipo) { load(search); return }
    // Cartões de entrada: só as contagens, feitas no banco
    setLoading(true)
    fetch('/api/clients?resumo=1').then(r => r.json())
      .then(d => {
        setResumo(d.resumo || null)
        if (Array.isArray(d.tipos)) setTiposVisiveis(d.tipos)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [search, filter, tipo, recarga])

  const updateStage = async (clientId: string, newStage: string) => {
    await fetch(`/api/clients/${clientId}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ stage: newStage }) })
    setClients(p => p.map(c => c.id===clientId ? {...c, stage:newStage} : c))
  }

  const byStage = (stage: string) => clients.filter(c => c.stage===stage)

  // Convite do portal, um a um. É o par da importação: ela traz a carteira sem
  // convidar ninguém (seriam quase mil e-mails de uma vez), e daqui a equipe
  // manda o acesso de quem quiser, quando quiser.
  const convidar = async (c: any) => {
    if (!c.email) { setAviso(`⚠️ ${c.name} não tem e-mail cadastrado.`); return }
    const jaTinha = c.acesso === 'convidado'
    if (jaTinha && !confirm(`${c.name} já foi convidado. Enviar de novo?`)) return
    setEnviando(c.id); setAviso('')
    const d = await fetch('/api/send-invite', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: c.id, clientName: c.name, clientEmail: c.email,
        clientType: c.type, language: c.language || 'en',
        assignee: c.assignee || 'Peace on Tax', channels: ['email'],
      }),
    }).then(r => r.json()).catch(e => ({ error: String(e) }))
    setEnviando(null)
    if (d?.error) { setAviso(`⚠️ ${d.error}`); return }
    setAviso(`✓ Convite ${jaTinha ? 'reenviado' : 'enviado'} para ${c.email}. Vale por 7 dias.`)
    setClients(p => p.map(x => x.id === c.id ? { ...x, acesso: 'convidado', convidadoEm: new Date().toISOString() } : x))
  }

  // ───────────── ENTRADA: os dois cartões ─────────────
  if (!tipo) {
    const emp = resumo?.business || ZERADO
    const pf  = resumo?.individual || ZERADO
    const veEmpresas = tiposVisiveis.includes('business')
    return (
      <div>
        {showImport && <ImportarModal onPronto={() => { setShowImport(false); setRecarga(n => n + 1) }} onClose={() => setShowImport(false)} />}
        {showNew && <NewClientModal onSave={() => { setShowNew(false); setRecarga(n => n + 1) }} onClose={() => setShowNew(false)} />}

        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:22, flexWrap:'wrap', gap:12 }}>
          <div>
            <h1 style={{ fontFamily:'Georgia,serif', fontSize:26, color:'#0f2340', margin:'0 0 4px', fontWeight:400 }}>Clientes</h1>
            <p style={{ color:'#6a7a9a', fontSize:14, margin:0 }}>
              {loading ? 'Carregando…'
                : veEmpresas ? `${emp.total + pf.total} cadastros`
                : `${pf.total} cadastros de pessoa física`}
            </p>
          </div>
          <div style={{ display:'flex', gap:10 }}>
            <button onClick={() => setShowImport(true)}
              style={{ background:'#fff', color:'#2D3278', border:'1.5px solid #2D3278', padding:'10px 16px', borderRadius:10, fontSize:14, fontFamily:'Georgia,serif', fontWeight:700, cursor:'pointer' }}>
              ⬆ Importar do QuickBooks
            </button>
            <button onClick={() => setShowNew(true)}
              style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', color:'#fff', border:'none', padding:'10px 20px', borderRadius:10, fontSize:14, fontFamily:'Georgia,serif', fontWeight:700, cursor:'pointer' }}>
              + Novo cliente
            </button>
          </div>
        </div>

        <div className="cli-cartoes" style={veEmpresas ? undefined : { gridTemplateColumns:'minmax(0,1fr)' }}>
          {/* EMPRESAS: atendidas o ano todo, então a situação do trabalho
              importa. Quem não tem `verEmpresas` não vê o cartão — e não vê
              porque o dado não chega, não porque a tela esconde. */}
          {veEmpresas && (
          <button onClick={() => router.push('/clients?tipo=business')} className="cli-cartao" style={{ borderTop:'4px solid #2D3278' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
              <span style={{ fontSize:30 }}>🏢</span>
              <div style={{ textAlign:'left' }}>
                <div style={{ fontFamily:'Georgia,serif', fontSize:19, color:'#0f2340' }}>Empresas</div>
                <div style={{ fontSize:12.5, color:'#9aaab0' }}>atendidas o ano todo</div>
              </div>
            </div>
            <div style={{ fontFamily:'monospace', fontSize:38, fontWeight:800, color:'#2D3278', lineHeight:1 }}>
              {loading ? '—' : emp.total}
            </div>
            <div style={{ fontSize:12, color:'#6a7a9a', margin:'2px 0 16px' }}>cadastros</div>

            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, width:'100%' }}>
              {([['pendente','#C06010'],['trabalhando','#2D3278'],['concluido','#1A6B4A']] as const).map(([k,cor]) => (
                <div key={k} style={{ background:'#f8faff', border:'1px solid #e2e8f4', borderRadius:9, padding:'9px 6px' }}>
                  <div style={{ fontFamily:'monospace', fontSize:19, fontWeight:800, color:cor }}>
                    {loading ? '—' : (emp as any)[k]}
                  </div>
                  <div style={{ fontSize:10.5, color:'#6a7a9a', lineHeight:1.3, marginTop:2 }}>{ROTULO_SITUACAO[k]}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop:14, fontSize:13, fontWeight:700, color:'#2D3278' }}>Abrir o quadro →</div>
          </button>
          )}

          {/* PESSOA FÍSICA: aparece na temporada. Sem trabalho em aberto o ano
              todo, os mesmos números não diriam nada — fica só o total. */}
          <button onClick={() => router.push('/clients?tipo=individual')} className="cli-cartao" style={{ borderTop:'4px solid #5A1A8A' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
              <span style={{ fontSize:30 }}>👤</span>
              <div style={{ textAlign:'left' }}>
                <div style={{ fontFamily:'Georgia,serif', fontSize:19, color:'#0f2340' }}>Pessoa física</div>
                <div style={{ fontSize:12.5, color:'#9aaab0' }}>declaração de temporada</div>
              </div>
            </div>
            <div style={{ fontFamily:'monospace', fontSize:38, fontWeight:800, color:'#5A1A8A', lineHeight:1 }}>
              {loading ? '—' : pf.total}
            </div>
            <div style={{ fontSize:12, color:'#6a7a9a', margin:'2px 0 16px' }}>cadastros</div>
            <div style={{ background:'#faf8ff', border:'1px solid #ece4f6', borderRadius:9, padding:'11px 12px',
              fontSize:12, color:'#6a5a7a', lineHeight:1.55, width:'100%', boxSizing:'border-box' }}>
              O quadro de etapas abre aqui dentro, na temporada. Fora dela não há
              trabalho em aberto, então não há o que contar na entrada.
            </div>
            <div style={{ marginTop:14, fontSize:13, fontWeight:700, color:'#5A1A8A' }}>Abrir o quadro →</div>
          </button>
        </div>

        <style>{`
          .cli-cartoes { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
          .cli-cartao {
            display:flex; flex-direction:column; align-items:flex-start;
            background:#fff; border:1px solid #e2e8f4; border-radius:16px;
            padding:20px 22px; cursor:pointer; text-align:left; font-family:inherit;
            transition:box-shadow .15s, transform .15s;
          }
          .cli-cartao:hover { box-shadow:0 10px 30px rgba(15,35,64,0.12); transform:translateY(-2px); }
          @media (max-width:820px) { .cli-cartoes { grid-template-columns:1fr; } }
        `}</style>
      </div>
    )
  }

  // ───────────── QUADRO DE UM TIPO ─────────────
  const ehEmpresa = tipo === 'business'

  return (
    <div>
      {showNew && <NewClientModal onSave={() => { setShowNew(false); setRecarga(n => n + 1) }} onClose={() => setShowNew(false)} />}
      {showImport && <ImportarModal onPronto={() => { setShowImport(false); setRecarga(n => n + 1) }} onClose={() => setShowImport(false)} />}

      {aviso && (
        <div style={{ marginBottom:14, padding:'11px 15px', borderRadius:10, fontSize:14, fontWeight:600,
          background: aviso.startsWith('✓') ? '#e8f5ee' : '#fff4e8',
          color: aviso.startsWith('✓') ? '#1a6b4a' : '#8a5a00' }}>
          {aviso}
          <button onClick={() => setAviso('')} style={{ float:'right', background:'none', border:'none', cursor:'pointer', fontSize:15, color:'inherit', fontWeight:800 }}>✕</button>
        </div>
      )}

      {/* Cabeçalho do quadro de um tipo. O caminho de volta aos cartões fica
          sempre visível: sem ele, quem entra no quadro não acha a outra lista. */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20, flexWrap:'wrap', gap:12 }}>
        <div>
          <button onClick={() => router.push('/clients')}
            style={{ background:'none', border:'none', padding:0, cursor:'pointer', fontSize:13,
              fontWeight:700, color:'#2D3278', marginBottom:4 }}>
            ← Todos os clientes
          </button>
          <h1 style={{ fontFamily:'Georgia,serif', fontSize:24, color:'#0f2340', margin:'0 0 4px', fontWeight:400 }}>
            {ehEmpresa ? '🏢 Empresas' : '👤 Pessoa física'}
          </h1>
          <p style={{ color:'#6a7a9a', fontSize:13, margin:0 }}>
            {loading ? 'Carregando…' : `${clients.length} cadastro(s)`}
            {search ? ` para "${search}"` : ''}
          </p>
        </div>
        <div style={{ display:'flex', gap:10, alignItems:'center' }}>
          {/* View toggle */}
          <div style={{ display:'flex', background:'#e2e8f4', borderRadius:9, padding:2 }}>
            {([['kanban','🗂 Quadro'],['list','☰ Lista']] as const).map(([v,l]) => (
              <button key={v} onClick={() => setView(v)} style={{ padding:'6px 14px', borderRadius:7, border:'none', cursor:'pointer', fontSize:12, fontWeight:700, background:view===v?'#fff':'transparent', color:view===v?'#2D3278':'#6a7a9a' }}>{l}</button>
            ))}
          </div>
          <button onClick={() => setShowImport(true)} title="Trazer a carteira exportada do QuickBooks"
            style={{ background:'#fff', color:'#2D3278', border:'1.5px solid #2D3278', padding:'10px 16px', borderRadius:10, fontSize:14, fontFamily:'Georgia,serif', fontWeight:700, cursor:'pointer' }}>
            ⬆ Importar do QuickBooks
          </button>
          <button onClick={() => setShowNew(true)} style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', color:'#fff', border:'none', padding:'10px 20px', borderRadius:10, fontSize:14, fontFamily:'Georgia,serif', fontWeight:700, cursor:'pointer' }}>
            + Novo cliente
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10, marginBottom:20 }}>
        {STAGES.map(s => (
          <div key={s} style={{ background:'#fff', borderRadius:10, padding:'12px 14px', border:'1px solid #e2e8f4', cursor:'pointer' }} onClick={() => setFilter(s === filter ? 'all' : s)}>
            <div style={{ fontSize:18, fontWeight:800, color:STAGE_COLOR[s], fontFamily:'monospace' }}>{byStage(s).length}</div>
            <div style={{ fontSize:11, color:'#6a7a9a', marginTop:2 }}>{s}</div>
          </div>
        ))}
      </div>

      {/* Busca. O filtro de individual/business saiu: a tela já é de um tipo. */}
      <div style={{ display:'flex', gap:10, marginBottom:16 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar pelo nome…"
          style={{ flex:1, padding:'9px 14px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:13, outline:'none', fontFamily:'Georgia,serif' }} />
        {filter !== 'all' && (
          <button onClick={() => setFilter('all')}
            style={{ padding:'8px 14px', borderRadius:8, border:'1px solid #e2e8f4', cursor:'pointer', fontSize:12, fontWeight:700, background:'#fff', color:'#6a7a9a' }}>
            limpar filtro: {filter}
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ padding:40, textAlign:'center', color:'#6a7a9a' }}>Carregando…</div>
      ) : clients.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:14, padding:48, textAlign:'center', border:'1px solid #e2e8f4' }}>
          <div style={{ fontSize:48, marginBottom:12 }}>👥</div>
          <div style={{ fontSize:16, fontWeight:700, color:'#0f2340', marginBottom:6 }}>Nenhum cliente aqui</div>
          <div style={{ fontSize:13, color:'#6a7a9a', marginBottom:20 }}>Cadastre o primeiro, ou traga a carteira do QuickBooks</div>
          <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
            <button onClick={() => setShowNew(true)} style={{ background:'#2D3278', color:'#fff', border:'none', padding:'10px 20px', borderRadius:9, cursor:'pointer', fontSize:13, fontWeight:700 }}>+ Cadastrar</button>
            <Link href="/invitations" style={{ background:'#f0f4fa', color:'#2D3278', border:'1px solid #e2e8f4', padding:'10px 20px', borderRadius:9, cursor:'pointer', fontSize:13, fontWeight:700, textDecoration:'none' }}>Enviar convite</Link>
          </div>
        </div>
      ) : view === 'kanban' ? (
        /* KANBAN VIEW */
        <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:12, overflowX:'auto' }}>
          {STAGES.map(stage => (
            <div key={stage}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); if (dragging) { updateStage(dragging, stage); setDragging(null) } }}
              style={{ background:'#f8faff', borderRadius:12, padding:12, border:'1px solid #e2e8f4', minHeight:200 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                <div style={{ fontSize:11, fontWeight:700, color:STAGE_COLOR[stage], textTransform:'uppercase' as const, letterSpacing:0.5 }}>{stage}</div>
                <span style={{ fontSize:11, background:STAGE_BG[stage], color:STAGE_COLOR[stage], padding:'1px 7px', borderRadius:20, fontWeight:700 }}>{byStage(stage).length}</span>
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {byStage(stage).map(c => (
                  <div key={c.id}
                    draggable
                    onDragStart={() => setDragging(c.id)}
                    onDragEnd={() => setDragging(null)}
                    style={{ background:'#fff', borderRadius:9, padding:'10px 12px', border:'1px solid #e2e8f4', cursor:'grab', boxShadow: dragging===c.id ? '0 4px 12px rgba(0,0,0,0.15)' : 'none' }}>
                    <Link href={`/clients/${c.id}`} style={{ textDecoration:'none' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
                        <span style={{ fontSize:12 }}>{c.type==='business'?'🏢':'👤'}</span>
                        <span style={{ fontSize:12, fontWeight:700, color:'#1a2a3a' }}>{c.name}</span>
                      </div>
                      <div style={{ fontSize:10, color:'#9aaab0', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }}>{c.email}</div>
                      {c.assignee && <div style={{ fontSize:10, color:'#6a7a9a', marginTop:3 }}>👤 {c.assignee}</div>}
                    </Link>
                    {/* Stage quick-change */}
                    <select value={c.stage} onChange={e => updateStage(c.id, e.target.value)} onClick={e => e.stopPropagation()}
                      style={{ width:'100%', marginTop:6, padding:'3px 6px', border:'1px solid #e2e8f4', borderRadius:6, fontSize:10, color:'#6a7a9a', outline:'none', background:'#f8faff' }}>
                      {STAGES.map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* LIST VIEW */
        <div style={{ background:'#fff', borderRadius:14, border:'1px solid #e2e8f4', overflow:'hidden' }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ background:'#f8faff' }}>
                {['Cliente','Tipo','Responsável','Etapa','Acesso ao portal',''].map(h => (
                  <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, borderBottom:'1.5px solid #e2e8f4' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clients.map(c => (
                <tr key={c.id} style={{ borderBottom:'1px solid #f0f4fa' }}>
                  <td style={{ padding:'11px 16px' }}>
                    <div style={{ fontWeight:700, fontSize:14, color:'#1a2a3a' }}>{c.name}</div>
                    {c.phone && <div style={{ fontSize:11, color:'#9aaab0' }}>{c.phone}</div>}
                  </td>
                  <td style={{ padding:'11px 16px' }}>
                    <span style={{ fontSize:11, padding:'2px 9px', borderRadius:20, fontWeight:700, background:c.type==='business'?'#e8f0ff':'#f0e8ff', color:c.type==='business'?'#1a3560':'#5a1a8a' }}>
                      {c.type==='business'?'🏢 Business':'👤 Individual'}
                    </span>
                  </td>
                  <td style={{ padding:'11px 16px', fontSize:13, color:'#3a4a5a' }}>{c.assignee||'—'}</td>
                  <td style={{ padding:'11px 16px' }}>
                    <select value={c.stage} onChange={e => updateStage(c.id, e.target.value)}
                      style={{ padding:'4px 10px', border:'1px solid #e2e8f4', borderRadius:7, fontSize:12, color:STAGE_COLOR[c.stage]||'#6a7a9a', fontWeight:700, outline:'none', background:STAGE_BG[c.stage]||'#f0f4fa', cursor:'pointer' }}>
                      {STAGES.map(s => <option key={s}>{s}</option>)}
                    </select>
                  </td>
                  <td style={{ padding:'11px 16px' }}>
                    {c.acesso === 'com_acesso' ? (
                      <span style={{ fontSize:11.5, fontWeight:700, color:'#1a6b4a' }}>✓ tem acesso</span>
                    ) : c.acesso === 'sem_email' ? (
                      <span style={{ fontSize:11.5, color:'#9aaab0' }}>sem e-mail</span>
                    ) : (
                      <button onClick={() => convidar(c)} disabled={enviando === c.id}
                        title={c.acesso === 'convidado'
                          ? `Convite enviado em ${c.convidadoEm ? new Date(c.convidadoEm).toLocaleDateString('en-US') : '—'} — ainda não aceito`
                          : `Enviar o acesso ao portal para ${c.email}`}
                        style={{ fontSize:11.5, fontWeight:700, padding:'5px 11px', borderRadius:7, cursor:enviando===c.id?'wait':'pointer',
                          border: c.acesso === 'convidado' ? '1px solid #e2e8f4' : 'none',
                          background: c.acesso === 'convidado' ? '#fff' : '#2D3278',
                          color: c.acesso === 'convidado' ? '#c06010' : '#fff' }}>
                        {enviando === c.id ? 'enviando…'
                          : c.acesso === 'convidado' ? '↻ reenviar convite' : '✉ enviar convite'}
                      </button>
                    )}
                    <div style={{ fontSize:10.5, color:'#9aaab0', marginTop:3 }}>{c.email}</div>
                  </td>
                  <td style={{ padding:'11px 16px' }}>
                    <Link href={`/clients/${c.id}`} style={{ fontSize:12, fontWeight:700, color:'#2D3278', textDecoration:'none', background:'#f0f4ff', padding:'5px 12px', borderRadius:7, display:'inline-block' }}>
                      Abrir →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function NewClientModal({ onSave, onClose }: { onSave: () => void; onClose: () => void }) {
  const [team, setTeam] = useState<string[]>([])
  const [form, setForm]     = useState({ name:'', email:'', phone:'', type:'individual', assignee:'', stage:'Onboarding', business_name:'', ein:'', business_type:'', filing_status:'', address_line1:'', city:'', state:'MA', zip:'', notes:'' })

  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')
  const set = (k: string, v: string) => setForm(p => ({...p,[k]:v}))

  // Lista de responsáveis para o campo "Assigned to" — antes ficava num efeito
  // da página, que chamava um setTeam inexistente naquele escopo (erro engolido
  // pelo catch), e o campo aparecia sempre vazio.
  useEffect(() => {
    fetch('/api/team').then(r => r.json())
      .then(d => setTeam((d.members || []).map((x: any) => x.name)))
      .catch(() => null)
  }, [])

  const save = async () => {
    if (!form.name || !form.email) { setError('Name and email are required'); return }
    setSaving(true)
    const res = await fetch('/api/clients', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(form) })
    const d = await res.json()
    if (d.error) { setError(d.error); setSaving(false); return }
    onSave()
  }

  const inp = (label: string, key: string, type='text', ph='') => (
    <div style={{ marginBottom:12 }}>
      <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>{label}</label>
      <input type={type} value={(form as any)[key]} onChange={e => set(key,e.target.value)} placeholder={ph}
        style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, boxSizing:'border-box' as const, outline:'none' }} />
    </div>
  )

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(15,35,64,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:20 }}>
      <div style={{ background:'#fff', borderRadius:20, width:'100%', maxWidth:540, maxHeight:'90vh', overflowY:'auto', boxShadow:'0 30px 80px rgba(0,0,0,0.4)' }}>
        <div style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', padding:'18px 24px', borderRadius:'20px 20px 0 0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <h2 style={{ fontFamily:'Georgia,serif', fontSize:17, color:'#fff', margin:0 }}>New Client</h2>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.15)', border:'none', color:'#fff', width:28, height:28, borderRadius:7, cursor:'pointer', fontSize:15 }}>✕</button>
        </div>
        <div style={{ padding:'20px 24px' }}>
          <div style={{ display:'flex', gap:8, marginBottom:16 }}>
            {[['individual','👤 Individual'],['business','🏢 Business']].map(([v,l]) => (
              <button key={v} onClick={() => set('type',v)} style={{ flex:1, padding:'9px', borderRadius:9, cursor:'pointer', border:form.type===v?'2px solid #2D3278':'1.5px solid #e2e8f4', background:form.type===v?'#2D3278':'#fff', color:form.type===v?'#fff':'#6a7a9a', fontFamily:'Georgia,serif', fontSize:13, fontWeight:700 }}>{l}</button>
            ))}
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            {inp('Full Name *','name','text','John Smith')}
            {inp('Email *','email','email','john@example.com')}
            {inp('Phone','phone','tel','(617) 555-0000')}
            <div style={{ marginBottom:12 }}>
              <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>Assignee</label>
              <select value={form.assignee} onChange={e => set('assignee',e.target.value)} style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }}>
                <option value="">— Select —</option>
                {team.map(a => <option key={a}>{a}</option>)}
                {team.length === 0 && <option disabled>Cadastre a equipe em Equipe →</option>}
              </select>
            </div>
          </div>
          {form.type==='business' && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              {inp('Business Name','business_name','text','Greenfield LLC')}
              {inp('EIN','ein','text','12-3456789')}
            </div>
          )}
          {form.type==='individual' && (
            <div style={{ marginBottom:12 }}>
              <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>Filing Status</label>
              <select value={form.filing_status} onChange={e => set('filing_status',e.target.value)} style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }}>
                <option value="">— Select —</option>
                {['Single','Married Filing Jointly','Married Filing Separately','Head of Household'].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            {inp('Address','address_line1','text','123 Main St')}
            {inp('City','city','text','Boston')}
            {inp('ZIP','zip','text','02101')}
            <div style={{ marginBottom:12 }}>
              <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>Stage</label>
              <select value={form.stage} onChange={e => set('stage',e.target.value)} style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }}>
                {STAGES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginBottom:16 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>Notes</label>
            <textarea value={form.notes} onChange={e => set('notes',e.target.value)} rows={2} placeholder="Internal notes about this client…"
              style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, boxSizing:'border-box' as const, outline:'none', resize:'vertical' as const }} />
          </div>
          {error && <div style={{ background:'#fdf0f0', color:'#b02020', padding:'9px 13px', borderRadius:8, fontSize:13, marginBottom:14 }}>{error}</div>}
          <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
            <button onClick={onClose} style={{ padding:'10px 18px', borderRadius:9, border:'1px solid #e2e8f4', background:'#f8faff', color:'#6a7a9a', cursor:'pointer', fontSize:13 }}>Cancel</button>
            <button onClick={save} disabled={saving} style={{ padding:'10px 24px', borderRadius:9, border:'none', background:saving?'#e2e8f4':'linear-gradient(135deg,#2D3278,#1a1f5e)', color:saving?'#9aaab0':'#fff', cursor:saving?'not-allowed':'pointer', fontSize:14, fontFamily:'Georgia,serif', fontWeight:700 }}>
              {saving?'Saving…':'Save Client'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Importação da carteira do QuickBooks. Sempre em duas etapas: primeiro o
// PLANO (o que entra, o que já existe, o que está repetido no arquivo), e só
// depois de conferir é que grava. Importar NÃO envia convite — quase mil
// e-mails de uma vez seria um desastre.
function ImportarModal({ onPronto, onClose }: { onPronto: () => void; onClose: () => void }) {
  const [csv, setCsv]       = useState('')
  const [arquivo, setArq]   = useState('')
  const [previa, setPrevia] = useState<any>(null)
  const [busy, setBusy]     = useState(false)
  const [erro, setErro]     = useState('')
  const [feito, setFeito]   = useState('')
  const [falhas, setFalhas] = useState<string[]>([])
  const [gravados, setGravados] = useState(0)
  // Cliente sem e-mail nunca vai receber o portal. Por padrão fica de fora —
  // a equipe marca quando quiser o cadastro dele para atender no balcão.
  const [comSemEmail, setComSemEmail] = useState(false)

  const escolher = async (f: File | null) => {
    if (!f) return
    setErro(''); setPrevia(null); setFeito('')
    setArq(f.name)
    setCsv(await f.text())
  }

  const chamar = async (aplicar: boolean, forcado?: boolean) => {
    void forcado
    setBusy(true); setErro('')
    const d = await fetch('/api/clients/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ csv, aplicar, incluirSemEmail: comSemEmail }),
    }).then(r => r.json()).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setErro(d?.error || 'Não foi possível ler o arquivo.'); return }
    if (aplicar) { setFeito(d.message); setFalhas(d.falhas || []); setGravados(d.gravados ?? 0); setPrevia(null) } else setPrevia(d)
  }

  const cx: React.CSSProperties = { background:'#fff', borderRadius:20, width:'100%', maxWidth:620, maxHeight:'90vh', overflowY:'auto' }
  const linha = (r: string, v: any, cor = '#0f2340') => (
    <div style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom:'1px solid #f0f4fa', fontSize:13.5 }}>
      <span style={{ color:'#6a7a9a' }}>{r}</span><b style={{ color:cor }}>{v}</b>
    </div>
  )

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(15,35,64,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:20 }}>
      <div style={cx}>
        <div style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', padding:'18px 24px', borderRadius:'20px 20px 0 0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <h2 style={{ fontFamily:'Georgia,serif', fontSize:17, color:'#fff', margin:0 }}>Importar carteira do QuickBooks</h2>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.15)', border:'none', color:'#fff', width:28, height:28, borderRadius:7, cursor:'pointer', fontSize:15 }}>✕</button>
        </div>
        <div style={{ padding:'20px 24px' }}>
          {feito ? (
            <>
              {/* Verde só quando entrou alguém E ninguém foi recusado. A versão
                  anterior pintava de verde qualquer resposta da rota — uma
                  importação que gravou ZERO aparecia como sucesso, e foi assim
                  que uma falha total passou por confirmada. */}
              <div style={{
                background: gravados > 0 && !falhas.length ? '#e8f5ee' : gravados > 0 ? '#fff4e8' : '#fdf0f0',
                color: gravados > 0 && !falhas.length ? '#1a6b4a' : gravados > 0 ? '#8a5a00' : '#b02020',
                padding:'14px 16px', borderRadius:10, fontSize:14, fontWeight:600, lineHeight:1.6 }}>
                {gravados === 0 && <div style={{ fontSize:15, fontWeight:800, marginBottom:4 }}>Nada foi importado.</div>}
                {feito}
              </div>
              {falhas.length > 0 && (
                <div style={{ marginTop:12, background:'#fdf0f0', border:'1px solid #f0c8c8', borderRadius:10, padding:'12px 15px' }}>
                  <div style={{ fontSize:13, fontWeight:700, color:'#b02020', marginBottom:6 }}>Não entraram:</div>
                  <ul style={{ margin:0, paddingLeft:18, fontSize:12, color:'#8a3030', lineHeight:1.7 }}>
                    {falhas.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                </div>
              )}
              <div style={{ display:'flex', justifyContent:'flex-end', marginTop:16 }}>
                <button onClick={() => { setFeito(''); setFalhas([]); setPrevia(null) }}
                  style={{ padding:'10px 18px', borderRadius:9, border:'1px solid #e2e8f4', background:'#f8faff', color:'#6a7a9a', cursor:'pointer', fontSize:13 }}>Tentar de novo</button>
                <button onClick={onPronto} style={{ padding:'10px 24px', borderRadius:9, border:'none', background:'#2D3278', color:'#fff', cursor:'pointer', fontSize:14, fontWeight:700 }}>Ver a lista</button>
              </div>
            </>
          ) : (
            <>
              <p style={{ fontSize:13.5, color:'#6a7a9a', margin:'0 0 14px', lineHeight:1.6 }}>
                No QuickBooks: <b>Clients → Export</b>. O arquivo vem com nome, e-mail, telefone e
                o tipo (pessoa ou empresa). Quem já está cadastrado fica de fora — a comparação é
                pelo nome, então maiúscula, acento e pontuação não atrapalham.
              </p>

              <input type="file" accept=".csv,text/csv" onChange={e => escolher(e.target.files?.[0] || null)}
                style={{ width:'100%', padding:'10px', border:'1.5px dashed #2D3278', borderRadius:10, fontSize:13, marginBottom:12, boxSizing:'border-box' }} />

              {arquivo && !previa && (
                <button onClick={() => chamar(false)} disabled={busy || !csv}
                  style={{ width:'100%', padding:'11px', borderRadius:9, border:'none', background:busy?'#e2e8f4':'#2D3278', color:busy?'#9aaab0':'#fff', cursor:busy?'wait':'pointer', fontSize:14, fontWeight:700 }}>
                  {busy ? 'Conferindo…' : `Conferir ${arquivo}`}
                </button>
              )}

              {previa && (
                <div style={{ marginTop:4 }}>
                  <div style={{ background:'#f8faff', border:'1px solid #e2e8f4', borderRadius:12, padding:'12px 16px', marginBottom:12 }}>
                    {linha('Linhas no arquivo', previa.resumo.lidos)}
                    {linha('Entram agora', previa.resumo.novos, '#1a6b4a')}
                    {linha('Já cadastrados (ficam de fora)', previa.resumo.jaExistem, '#c06010')}
                    {previa.resumo.repetidosNoArquivo > 0 && linha('Repetidos dentro do arquivo', previa.resumo.repetidosNoArquivo, '#c06010')}
                    {linha('— empresas', previa.resumo.empresas)}
                    {linha('— pessoas físicas', previa.resumo.pessoasFisicas)}
                    {previa.resumo.semEmailDeFora > 0 && linha('Sem e-mail (ficam de fora)', previa.resumo.semEmailDeFora, '#6a7a9a')}
                    {previa.resumo.telefonesDescartados > 0 && linha('Telefones inválidos descartados', previa.resumo.telefonesDescartados, '#6a7a9a')}
                  </div>

                  {previa.resumo.semEmail > 0 && (
                    <label style={{ display:'flex', alignItems:'flex-start', gap:9, background:'#f8faff',
                      border:'1px solid #e2e8f4', borderRadius:10, padding:'11px 14px', marginBottom:12,
                      fontSize:13, color:'#4a5a70', cursor:'pointer', lineHeight:1.55 }}>
                      <input type="checkbox" checked={comSemEmail} style={{ marginTop:3 }}
                        onChange={e => { setComSemEmail(e.target.checked); setPrevia(null) }} />
                      <span>
                        <b>Incluir os {previa.resumo.semEmail} sem e-mail</b>
                        <div style={{ fontSize:11.5, color:'#9aaab0', marginTop:2 }}>
                          Eles existem e são atendidos no balcão, mas nunca vão receber acesso ao
                          portal — o convite precisa de e-mail. Desmarcado, ficam de fora desta
                          importação e podem ser trazidos depois.
                        </div>
                      </span>
                    </label>
                  )}

                  {previa.resumo.emailCompartilhado > 0 && (
                    <div style={{ background:'#fff8e8', border:'1px solid #f0d8a8', borderRadius:10, padding:'11px 14px', fontSize:12.5, color:'#5a4a1a', lineHeight:1.6, marginBottom:12 }}>
                      <b>{previa.resumo.emailCompartilhado} e-mail(s) servem a mais de um cadastro</b> — normalmente
                      o dono e a empresa dele. Os dois entram, porque são clientes diferentes. Só lembre que o
                      acesso ao portal é por e-mail e atende um cadastro só.
                      {previa.emailCompartilhado?.[0] && (
                        <div style={{ marginTop:6, fontSize:11.5, color:'#8a7a4a' }}>
                          ex.: {previa.emailCompartilhado[0].email} → {previa.emailCompartilhado[0].nomes.join(' · ')}
                        </div>
                      )}
                    </div>
                  )}

                  {previa.repetidos?.length > 0 && (
                    <div style={{ fontSize:12, color:'#6a7a9a', marginBottom:12 }}>
                      Repetidos no arquivo, entram uma vez: <b>{previa.repetidos.join(', ')}</b>
                    </div>
                  )}

                  <div style={{ background:'#f0f4fa', borderRadius:10, padding:'11px 14px', fontSize:12.5, color:'#4a5a70', lineHeight:1.6, marginBottom:14 }}>
                    <b>Nenhum convite será enviado.</b> Os clientes entram cadastrados; o acesso ao
                    portal você manda depois, de quem quiser, pela ficha do cliente.
                  </div>

                  <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
                    <button onClick={() => { setPrevia(null); setArq(''); setCsv('') }} disabled={busy}
                      style={{ padding:'10px 18px', borderRadius:9, border:'1px solid #e2e8f4', background:'#f8faff', color:'#6a7a9a', cursor:'pointer', fontSize:13 }}>Trocar arquivo</button>
                    <button onClick={() => chamar(true)} disabled={busy || !previa.resumo.novos}
                      style={{ padding:'10px 24px', borderRadius:9, border:'none', background:busy||!previa.resumo.novos?'#e2e8f4':'linear-gradient(135deg,#1a6b4a,#145a3a)', color:busy||!previa.resumo.novos?'#9aaab0':'#fff', cursor:busy?'wait':'pointer', fontSize:14, fontWeight:700 }}>
                      {busy ? 'Importando…' : `Importar ${previa.resumo.novos}`}
                    </button>
                  </div>
                </div>
              )}

              {erro && <div style={{ background:'#fdf0f0', color:'#b02020', padding:'10px 14px', borderRadius:9, fontSize:13, marginTop:12 }}>{erro}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
