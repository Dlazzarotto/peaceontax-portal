'use client'
// app/dashboard/atendimento/page.tsx — Atendimento (WhatsApp)
// Sócio e gerente. Assistente recebe 403 nas rotas, não só menu escondido.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { waBrowser } from '@/lib/wa-browser'

const NAVY = '#2D3278'
const LARANJA = '#F47B20'

type Conversa = {
  id: string; phone: string; canal: string; status: string
  cliente: string; cadastrado: boolean; client_id: string | null
  minha: boolean; nao_lidas: number; ultima_mensagem: string | null
  janela_aberta: boolean; janela_min: number
  precisa_de_voce: boolean; parada_min: number
}
type Mensagem = {
  id: string; direction: string; autor: string; autor_nome: string | null
  body: string; anexo: string | null; status: string | null; erro: string | null
  template: string | null; created_at: string
}

const FILTROS = [
  { chave: 'ativas', rotulo: 'Ativas' },
  { chave: 'fila', rotulo: 'Esperando' },
  { chave: 'minhas', rotulo: 'Comigo' },
  { chave: 'bot', rotulo: 'Bot' },
  { chave: 'resolvida', rotulo: 'Resolvidas' },
]

export default function Atendimento() {
  const [filtro, setFiltro] = useState('ativas')
  const [conversas, setConversas] = useState<Conversa[]>([])
  const [resumo, setResumo] = useState<any>({})
  const [aberta, setAberta] = useState<string | null>(null)
  const [thread, setThread] = useState<any>(null)
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [carregando, setCarregando] = useState(true)
  const [semAcesso, setSemAcesso] = useState(false)
  const [tplId, setTplId] = useState('')
  const [tplVars, setTplVars] = useState<string[]>([])
  const fim = useRef<HTMLDivElement>(null)

  const chamar = useCallback(async (caminho: string, init?: RequestInit) => {
    const { data } = await waBrowser.auth.getSession()
    const token = data.session?.access_token
    if (!token) { setSemAcesso(true); throw new Error('Sessão expirada. Entre de novo.') }
    const r = await fetch(caminho, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
      cache: 'no-store',
    })
    const j = await r.json().catch(() => ({}))
    if (r.status === 403) { setSemAcesso(true); throw new Error(j.erro || 'Sem permissão.') }
    if (!r.ok) throw Object.assign(new Error(j.erro || 'Falhou.'), { corpo: j, status: r.status })
    return j
  }, [])

  const carregarFila = useCallback(async () => {
    try {
      const j = await chamar(`/api/whatsapp/conversations?filtro=${filtro}`)
      setConversas(j.conversas || []); setResumo(j.resumo || {}); setErro(null)
    } catch (e: any) { setErro(e.message) } finally { setCarregando(false) }
  }, [chamar, filtro])

  const carregarConversa = useCallback(async (id: string, marcarLida = false) => {
    try {
      const j = await chamar(`/api/whatsapp/messages?id=${id}${marcarLida ? '&ler=1' : ''}`)
      setThread(j)
    } catch (e: any) { setErro(e.message) }
  }, [chamar])

  useEffect(() => { carregarFila() }, [carregarFila])

  // Atualização periódica (RLS fechada de propósito: Realtime não se aplica)
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      carregarFila()
      if (aberta) carregarConversa(aberta)
    }, 8000)
    return () => clearInterval(t)
  }, [carregarFila, carregarConversa, aberta])

  useEffect(() => { fim.current?.scrollIntoView({ behavior: 'smooth' }) }, [thread?.mensagens?.length])

  function abrir(id: string) {
    setAberta(id); setThread(null); setTexto(''); setTplId(''); setTplVars([])
    carregarConversa(id, true).then(carregarFila)
  }

  async function acao(nome: string, extra: any = {}) {
    if (!aberta) return
    try {
      await chamar('/api/whatsapp/assign', { method: 'POST', body: JSON.stringify({ conversa_id: aberta, acao: nome, ...extra }) })
      await carregarConversa(aberta); await carregarFila()
    } catch (e: any) { setErro(e.message) }
  }

  async function enviar() {
    if (!aberta || enviando) return
    const janelaFechada = thread?.conversa && !thread.conversa.janela_aberta
    if (janelaFechada && !tplId) { setErro('Janela de 24h fechada — escolha um template.'); return }
    if (!janelaFechada && !texto.trim()) return
    setEnviando(true); setErro(null)
    try {
      await chamar('/api/whatsapp/send', {
        method: 'POST',
        body: JSON.stringify(janelaFechada
          ? { conversa_id: aberta, template_id: tplId, variaveis: tplVars }
          : { conversa_id: aberta, texto }),
      })
      setTexto(''); setTplId(''); setTplVars([])
      await carregarConversa(aberta); await carregarFila()
    } catch (e: any) { setErro(e.message) } finally { setEnviando(false) }
  }

  const conversa = thread?.conversa
  const contexto = thread?.contexto
  const templates = thread?.templates || []
  const tplEscolhido = useMemo(() => templates.find((t: any) => t.id === tplId), [templates, tplId])

  if (semAcesso) {
    return (
      <div className="wa-vazio">
        <Estilo />
        <h1>Atendimento</h1>
        <p>Esta tela é do sócio e do gerente. As conversas trazem dados fiscais dos clientes.</p>
        <a className="wa-btn" href="/dashboard">Voltar ao painel</a>
      </div>
    )
  }

  return (
    <div className="wa-app">
      <Estilo />

      <header className="wa-topo">
        <a href="/dashboard" className="wa-voltar" aria-label="Voltar ao painel">←</a>
        <h1>💬 Atendimento</h1>
        <div className="wa-chips">
          <span className="wa-chip wa-chip-esperando">{resumo.esperando ?? 0} esperando</span>
          <span className="wa-chip">{resumo.comigo ?? 0} comigo</span>
          {(resumo.precisa_de_voce ?? 0) > 0 && (
            <span className="wa-chip wa-chip-alerta">{resumo.precisa_de_voce} parada(s) +30 min</span>
          )}
        </div>
      </header>

      {erro && <div className="wa-erro" role="alert">{erro}</div>}

      <div className={`wa-grade ${aberta ? 'wa-com-conversa' : ''}`}>
        {/* ── Fila ───────────────────────────────────────────── */}
        <aside className="wa-fila">
          <div className="wa-filtros" role="tablist">
            {FILTROS.map((f) => (
              <button key={f.chave} role="tab" aria-selected={filtro === f.chave}
                className={`wa-filtro ${filtro === f.chave ? 'ativo' : ''}`}
                onClick={() => setFiltro(f.chave)}>{f.rotulo}</button>
            ))}
          </div>

          <div className="wa-lista">
            {carregando && <p className="wa-nota">Carregando…</p>}
            {!carregando && conversas.length === 0 && (
              <p className="wa-nota">Nenhuma conversa aqui. Quando um cliente escrever no WhatsApp, ela aparece nesta lista.</p>
            )}
            {conversas.map((c) => (
              <button key={c.id} onClick={() => abrir(c.id)}
                className={`wa-item ${aberta === c.id ? 'ativo' : ''} ${c.precisa_de_voce ? 'alerta' : ''}`}>
                <div className="wa-item-topo">
                  <strong>{c.cliente}</strong>
                  {c.nao_lidas > 0 && <span className="wa-badge">{c.nao_lidas}</span>}
                </div>
                <div className="wa-item-meta">
                  <span className={`wa-estado wa-e-${c.status}`}>{rotuloEstado(c.status)}</span>
                  {!c.cadastrado && <span className="wa-estado wa-e-novo">não cadastrado</span>}
                  <span className="wa-tempo">{desde(c.ultima_mensagem)}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* ── Conversa ───────────────────────────────────────── */}
        <section className="wa-conversa">
          {!aberta && <div className="wa-placeholder">Escolha uma conversa à esquerda.</div>}

          {aberta && !conversa && <div className="wa-placeholder">Abrindo…</div>}

          {aberta && conversa && (
            <>
              <div className="wa-cabecalho">
                <button className="wa-voltar wa-so-mobile" onClick={() => { setAberta(null); setThread(null) }} aria-label="Voltar para a fila">←</button>
                <div>
                  <strong>{contexto?.nome || conversa.nome_exibicao || 'Não cadastrado'}</strong>
                  <div className="wa-sub">{conversa.telefone_formatado} · {rotuloEstado(conversa.status)}</div>
                </div>
                <div className="wa-acoes">
                  {conversa.status !== 'humano' && <button className="wa-btn" onClick={() => acao('assumir')}>Assumir</button>}
                  {conversa.status === 'humano' && conversa.minha && <button className="wa-btn wa-btn-secundario" onClick={() => acao('liberar')}>Liberar</button>}
                  {conversa.status !== 'resolvida' && <button className="wa-btn wa-btn-secundario" onClick={() => acao('resolver')}>Resolver</button>}
                  {conversa.status === 'resolvida' && <button className="wa-btn" onClick={() => acao('reabrir')}>Reabrir</button>}
                </div>
              </div>

              <div className="wa-mensagens">
                {(thread.mensagens || []).map((m: Mensagem) => (
                  <div key={m.id} className={`wa-msg ${m.direction === 'inbound' ? 'entrada' : 'saida'} ${m.autor === 'bot' ? 'bot' : ''}`}>
                    {m.direction === 'outbound' && (
                      <div className="wa-autor">
                        {m.autor === 'bot' ? '🤖 Bot' : `👤 ${m.autor_nome || 'Equipe'}`}
                        {m.template && <span className="wa-tpl"> · template {m.template}</span>}
                      </div>
                    )}
                    <p>{m.body}</p>
                    {m.anexo && <a className="wa-anexo" href={m.anexo} target="_blank" rel="noreferrer">📎 Abrir anexo</a>}
                    <div className="wa-rodape-msg">
                      {hora(m.created_at)}
                      {m.direction === 'outbound' && <span className={`wa-status ${m.status === 'failed' ? 'falhou' : ''}`}> · {rotuloEntrega(m.status)}</span>}
                    </div>
                    {m.erro && <div className="wa-msg-erro">{m.erro}</div>}
                  </div>
                ))}
                <div ref={fim} />
              </div>

              {/* ── Caixa de resposta ─────────────────────────── */}
              <div className="wa-responder">
                {conversa.janela_aberta ? (
                  <>
                    <div className="wa-janela ok">Janela aberta · {Math.floor(conversa.janela_min / 60)}h{String(conversa.janela_min % 60).padStart(2, '0')} restantes</div>
                    <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={3}
                      placeholder="Escreva a resposta. O cliente vê Peace on Tax, não o seu nome."
                      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) enviar() }} />
                    <div className="wa-envio">
                      <span className="wa-nota-pequena">{texto.length}/1500</span>
                      <button className="wa-btn" onClick={enviar} disabled={enviando || !texto.trim()}>
                        {enviando ? 'Enviando…' : 'Enviar'}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="wa-janela fechada">
                      Janela de 24h fechada. O WhatsApp só entrega template aprovado até o cliente escrever de novo.
                    </div>
                    {templates.length === 0 ? (
                      <p className="wa-nota">Nenhum template aprovado cadastrado ainda. Cadastre em <code>wa_templates</code> depois da aprovação na Meta.</p>
                    ) : (
                      <>
                        <select className="wa-select" value={tplId}
                          onChange={(e) => { setTplId(e.target.value); setTplVars([]) }}>
                          <option value="">Escolha o template…</option>
                          {templates.map((t: any) => <option key={t.id} value={t.id}>{t.nome}</option>)}
                        </select>
                        {tplEscolhido && (
                          <>
                            <p className="wa-previa">{tplEscolhido.corpo}</p>
                            {Array.from({ length: tplEscolhido.variaveis || 0 }).map((_, i) => (
                              <input key={i} className="wa-input" placeholder={`Variável ${i + 1}`}
                                value={tplVars[i] || ''}
                                onChange={(e) => { const v = [...tplVars]; v[i] = e.target.value; setTplVars(v) }} />
                            ))}
                          </>
                        )}
                        <div className="wa-envio">
                          <span />
                          <button className="wa-btn" onClick={enviar} disabled={enviando || !tplId}>
                            {enviando ? 'Enviando…' : 'Enviar template'}
                          </button>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </section>

        {/* ── Contexto ───────────────────────────────────────── */}
        {aberta && conversa && (
          <aside className="wa-contexto">
            <h2>Cliente</h2>
            {contexto ? (
              <dl>
                <dt>Nome</dt><dd>{contexto.nome}</dd>
                {contexto.email && (<><dt>E-mail</dt><dd>{contexto.email}</dd></>)}
                {contexto.etapa && (<><dt>Etapa</dt><dd>{contexto.etapa}</dd></>)}
                {contexto.tipo && (<><dt>Tipo</dt><dd>{contexto.tipo}</dd></>)}
                {contexto.responsavel && (<><dt>Responsável</dt><dd>{contexto.responsavel}</dd></>)}
                {contexto.faturas_abertas != null && (<><dt>Faturas abertas</dt><dd>{contexto.faturas_abertas}</dd></>)}
                {contexto.documentos != null && (<><dt>Documentos</dt><dd>{contexto.documentos}</dd></>)}
                <dt>Ficha</dt><dd><a href={`/dashboard/clients/${contexto.id}`}>Abrir ficha completa</a></dd>
              </dl>
            ) : (
              <VincularCliente chamar={chamar} onVincular={(id) => acao('vincular', { client_id: id })} />
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

function VincularCliente({ chamar, onVincular }: { chamar: any; onVincular: (id: string) => void }) {
  const [q, setQ] = useState('')
  const [lista, setLista] = useState<any[]>([])
  useEffect(() => {
    if (q.trim().length < 2) { setLista([]); return }
    const t = setTimeout(async () => {
      try { const j = await chamar(`/api/whatsapp/assign?q=${encodeURIComponent(q)}`); setLista(j.clientes || []) } catch { }
    }, 350)
    return () => clearTimeout(t)
  }, [q, chamar])
  return (
    <>
      <p className="wa-nota">Este número não está em nenhum cadastro. Vincule para a equipe ver o histórico.</p>
      <input className="wa-input" placeholder="Buscar cliente…" value={q} onChange={(e) => setQ(e.target.value)} />
      {lista.map((c) => (
        <button key={c.id} className="wa-btn wa-btn-secundario wa-largo" onClick={() => onVincular(c.id)}>{c.nome}</button>
      ))}
    </>
  )
}

// ── Auxiliares ─────────────────────────────────────────────
function rotuloEstado(s: string) {
  return { bot: 'Bot atendendo', fila: 'Esperando', humano: 'Com a equipe', resolvida: 'Resolvida' }[s] || s
}
function rotuloEntrega(s: string | null) {
  return { queued: 'na fila', sent: 'enviada', delivered: 'entregue', read: 'lida', failed: 'FALHOU', undelivered: 'não entregue' }[s || ''] || s || ''
}
function hora(iso: string) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function desde(iso: string | null) {
  if (!iso) return ''
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function Estilo() {
  return (
    <style>{`
.wa-app{font-family:Inter,system-ui,sans-serif;color:#1a1a1a;font-size:18px;max-width:1500px;margin:0 auto;padding:16px}
.wa-topo{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.wa-topo h1{font-size:26px;font-weight:800;color:${NAVY};margin:0}
.wa-voltar{display:inline-flex;align-items:center;justify-content:center;min-width:48px;min-height:48px;font-size:26px;color:${NAVY};text-decoration:none;background:#fff;border:2px solid #d7d9e8;border-radius:12px;cursor:pointer}
.wa-chips{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
.wa-chip{background:#eef0f8;color:${NAVY};font-weight:700;font-size:15px;padding:8px 14px;border-radius:999px}
.wa-chip-esperando{background:${LARANJA};color:#fff}
.wa-chip-alerta{background:#b3261e;color:#fff}
.wa-erro{background:#fdecea;border:2px solid #b3261e;color:#7a1a14;padding:14px 16px;border-radius:12px;margin-bottom:14px;font-weight:600}
.wa-grade{display:grid;grid-template-columns:340px 1fr 300px;gap:16px;align-items:start}
.wa-fila,.wa-conversa,.wa-contexto{background:#fff;border:2px solid #e3e5f0;border-radius:16px}
.wa-fila{overflow:hidden}
.wa-filtros{display:flex;flex-wrap:wrap;gap:6px;padding:12px;border-bottom:2px solid #eef0f8}
.wa-filtro{min-height:44px;padding:8px 14px;border-radius:10px;border:2px solid transparent;background:#f4f5fa;color:${NAVY};font-weight:700;font-size:15px;cursor:pointer}
.wa-filtro.ativo{background:${NAVY};color:#fff}
.wa-lista{max-height:70vh;overflow-y:auto}
.wa-item{display:block;width:100%;text-align:left;padding:16px;border:0;border-bottom:1px solid #eef0f8;background:#fff;cursor:pointer;min-height:76px}
.wa-item:hover{background:#f7f8fd}
.wa-item.ativo{background:#eef0f8;box-shadow:inset 5px 0 0 ${LARANJA}}
.wa-item.alerta{box-shadow:inset 5px 0 0 #b3261e}
.wa-item-topo{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:18px}
.wa-item-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
.wa-badge{background:${LARANJA};color:#fff;border-radius:999px;min-width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;padding:0 8px}
.wa-estado{font-size:13px;font-weight:800;padding:4px 10px;border-radius:6px;background:#eef0f8;color:${NAVY};text-transform:uppercase;letter-spacing:.3px}
.wa-e-fila{background:#fdecea;color:#8c1d18}
.wa-e-bot{background:#e8f1ff;color:#14448c}
.wa-e-humano{background:#e6f4ea;color:#14502a}
.wa-e-resolvida{background:#eceff1;color:#455a64}
.wa-e-novo{background:#fff3e0;color:#8a4b00}
.wa-tempo{margin-left:auto;color:#5b6070;font-size:15px}
.wa-conversa{display:flex;flex-direction:column;min-height:70vh}
.wa-placeholder{padding:48px 24px;color:#5b6070;text-align:center}
.wa-cabecalho{display:flex;gap:12px;align-items:center;padding:16px;border-bottom:2px solid #eef0f8;flex-wrap:wrap}
.wa-cabecalho strong{font-size:20px;color:${NAVY}}
.wa-sub{color:#5b6070;font-size:16px;margin-top:2px}
.wa-acoes{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
.wa-btn{min-height:48px;padding:12px 20px;border-radius:12px;border:0;background:${NAVY};color:#fff;font-weight:800;font-size:16px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
.wa-btn:disabled{opacity:.45;cursor:not-allowed}
.wa-btn-secundario{background:#fff;color:${NAVY};border:2px solid ${NAVY}}
.wa-largo{width:100%;margin-top:8px}
.wa-mensagens{flex:1;overflow-y:auto;max-height:52vh;padding:16px;display:flex;flex-direction:column;gap:12px;background:#fafbfe}
.wa-msg{max-width:78%;padding:12px 16px;border-radius:16px;line-height:1.5}
.wa-msg p{margin:0;white-space:pre-wrap;word-break:break-word}
.wa-msg.entrada{align-self:flex-start;background:#fff;border:2px solid #e3e5f0}
.wa-msg.saida{align-self:flex-end;background:${NAVY};color:#fff}
.wa-msg.saida.bot{background:#3f4a8a}
.wa-autor{font-size:14px;font-weight:800;opacity:.85;margin-bottom:6px}
.wa-tpl{font-weight:600;opacity:.8}
.wa-rodape-msg{font-size:13px;opacity:.75;margin-top:8px}
.wa-status.falhou{color:#ffb4ab;font-weight:800}
.wa-msg-erro{margin-top:6px;font-size:14px;background:#b3261e;color:#fff;padding:6px 10px;border-radius:8px}
.wa-anexo{display:inline-block;margin-top:8px;font-weight:800;color:inherit}
.wa-responder{border-top:2px solid #eef0f8;padding:16px}
.wa-responder textarea{width:100%;font-family:inherit;font-size:18px;padding:14px;border-radius:12px;border:2px solid #c9cce0;resize:vertical}
.wa-janela{font-size:15px;font-weight:800;padding:10px 14px;border-radius:10px;margin-bottom:10px}
.wa-janela.ok{background:#e6f4ea;color:#14502a}
.wa-janela.fechada{background:#fff3e0;color:#8a4b00}
.wa-envio{display:flex;justify-content:space-between;align-items:center;margin-top:12px;gap:12px}
.wa-nota{color:#5b6070;padding:16px;line-height:1.5}
.wa-nota-pequena{color:#5b6070;font-size:14px}
.wa-select,.wa-input{width:100%;min-height:48px;font-size:17px;padding:12px;border-radius:12px;border:2px solid #c9cce0;margin-bottom:10px;font-family:inherit}
.wa-previa{background:#f4f5fa;border-left:5px solid ${LARANJA};padding:12px;border-radius:8px;font-size:16px}
.wa-contexto{padding:16px}
.wa-contexto h2{font-size:18px;color:${NAVY};margin:0 0 12px}
.wa-contexto dt{font-size:13px;text-transform:uppercase;color:#5b6070;font-weight:800;letter-spacing:.3px;margin-top:12px}
.wa-contexto dd{margin:4px 0 0;font-size:17px;word-break:break-word}
.wa-contexto a{color:${NAVY};font-weight:800}
.wa-vazio{max-width:640px;margin:64px auto;padding:32px;text-align:center;font-family:Inter,system-ui,sans-serif;font-size:18px}
.wa-vazio h1{color:${NAVY}}
.wa-so-mobile{display:none}
@media(max-width:1100px){
  .wa-grade{grid-template-columns:1fr}
  .wa-contexto{order:3}
  .wa-so-mobile{display:inline-flex}
  .wa-com-conversa .wa-fila{display:none}
  .wa-lista{max-height:none}
  .wa-mensagens{max-height:none}
}
    `}</style>
  )
}
