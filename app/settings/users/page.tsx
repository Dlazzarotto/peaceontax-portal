'use client'
// /settings/users — a EQUIPE num lugar só (decisão do sócio)
//
// Juntou três telas que discordavam entre si:
//   /team                  o nome de responsável no CRM, com um "rótulo" de
//                          função que qualquer assistente trocava
//   Settings → Team        os logins, o convite e as autorizações
//   Minha Conta → Equipe   o nível de verdade, trocado sem senha nem motivo
//
// Agora cada pessoa é UMA linha (lib/equipe.ts): com login ou só como
// responsável no CRM, com o nível, o PIN e as autorizações. O nível muda por
// um ato próprio do sócio, com senha e motivo, e fica na trilha. Quem não é
// sócio vê a lista (o gerente via isto em Minha Conta) e não age.
//
// O texto de cada nível descreve O QUE O SISTEMA FAZ (padraoDoNivel em
// lib/permissoes.ts, o escopo por tipo e o de faturas). Mudou a matriz, muda
// o texto. O que estava aqui antes prometia "All clients" ao Staff e ao
// Manager — desde o escopo por tipo, o assistente só atende Pessoa física.

import { useState, useEffect } from 'react'
import GrantsModal from '@/components/GrantsModal'
import { ROTULO_DO_NIVEL, NIVEIS, type PessoaDaEquipe, type StaffLevel } from '@/lib/equipe'
import { fmtUS } from '@/lib/format'

const DESCRICAO: Record<StaffLevel, string> = {
  owner:   'Tudo: a equipe e os níveis, relatórios e totais do negócio, o caixa da firma, todas as faturas.',
  manager: 'O dia a dia: recebe, envia, edita e estorna (com senha e motivo), cancela, atende Empresa, baixa arquivo e atende o WhatsApp. Não vê relatórios nem totais e não mexe na equipe.',
  junior:  'O balcão: emite fatura (fica em rascunho até alguém enviar), atende só Pessoa física e vê só as faturas que emitiu no dia. Não recebe, não envia ao cliente, não edita cadastro e não baixa arquivo.',
}
const COR: Record<StaffLevel, { c: string; bg: string }> = {
  owner:   { c: '#2D3278', bg: '#e8eaff' },
  manager: { c: '#5a1a8a', bg: '#f0e8ff' },
  junior:  { c: '#1a3560', bg: '#e8f0ff' },
}

type Modal =
  | { tipo: 'convite'; nome?: string; email?: string }
  | { tipo: 'nivel'; p: PessoaDaEquipe }
  | { tipo: 'editar'; p: PessoaDaEquipe }
  | { tipo: 'crm'; p?: PessoaDaEquipe }
  | null

export default function EquipePage() {
  const [pessoas, setPessoas] = useState<PessoaDaEquipe[]>([])
  const [eu, setEu] = useState('')
  const [pode, setPode] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)
  const [erro, setErro] = useState('')
  const [msg, setMsg] = useState('')
  const [carregando, setCarregando] = useState(true)
  const [verInativos, setVerInativos] = useState(false)
  const [modal, setModal] = useState<Modal>(null)
  const [grants, setGrants] = useState<{ id: string; name: string } | null>(null)
  const [ocupado, setOcupado] = useState<string | null>(null)

  const carregar = async () => {
    setCarregando(true)
    try {
      const r = await fetch('/api/firm/users')
      const d = await r.json()
      if (!r.ok) { setErro(d?.error || `Erro ${r.status}`); setPessoas([]) }
      else {
        setErro('')
        setPessoas(d.pessoas || [])
        setEu(d.eu || '')
        // Ação só sem pendência de migração: a gravação recusaria.
        setPode(!!d.podeGerenciar && !d.semMigracao)
        setAviso(d.aviso || null)
      }
    } catch (e) { setErro((e as Error).message) }
    setCarregando(false)
  }
  useEffect(() => { carregar() }, [])

  const chamar = async (chave: string, url: string, init: RequestInit, ok: string) => {
    setOcupado(chave); setMsg('')
    try {
      const r = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || d?.error) setMsg(`⚠️ ${d?.error || `Erro ${r.status}`}`)
      else setMsg(`✓ ${ok}${d?.aviso ? ` — atenção: ${d.aviso}` : ''}${d?.renomeados ? ` · ${d.renomeados} cliente(s) com o nome novo` : ''}`)
    } catch (e) { setMsg(`⚠️ ${(e as Error).message}`) }
    setOcupado(null)
    carregar()
  }

  const desativar = (p: PessoaDaEquipe) => {
    if (p.userId) {
      if (!confirm(`Desativar ${p.nome}? O login deixa de entrar, o PIN deixa de aprovar e o nome sai do seletor de responsável. O histórico fica.`)) return
      chamar(p.chave, `/api/firm/users/${p.userId}`, { method: 'DELETE' }, `${p.nome} saiu da equipe.`)
    } else {
      if (!confirm(`Tirar ${p.nome} do seletor de responsável? Os clientes já atribuídos continuam mostrando o nome.`)) return
      chamar(p.chave, '/api/team', { method: 'PATCH', body: JSON.stringify({ id: p.memberId, active: false }) }, `${p.nome} saiu da equipe.`)
    }
  }
  const reativar = (p: PessoaDaEquipe) => {
    if (!confirm(`Reativar ${p.nome}?${p.userId ? ` Volta com o nível de antes (${ROTULO_DO_NIVEL[p.nivel || 'junior']}).` : ''}`)) return
    if (p.userId) chamar(p.chave, `/api/firm/users/${p.userId}`, { method: 'PATCH', body: JSON.stringify({ acao: 'reativar' }) }, `${p.nome} voltou para a equipe.`)
    else chamar(p.chave, '/api/team', { method: 'PATCH', body: JSON.stringify({ id: p.memberId, active: true }) }, `${p.nome} voltou para a equipe.`)
  }
  const zerarPin = (p: PessoaDaEquipe) => {
    const motivo = prompt(`Apagar o PIN de aprovação de ${p.nome}? A pessoa define um novo em Minha Conta.\n\nMotivo (fica na trilha):`)
    if (motivo === null) return
    chamar(p.chave, `/api/firm/users/${p.userId}`, { method: 'PATCH', body: JSON.stringify({ acao: 'zerarPin', motivo }) }, `PIN de ${p.nome} apagado.`)
  }
  const reenviar = (p: PessoaDaEquipe) => {
    if (!p.email) return
    chamar(p.chave, '/api/firm/users', {
      method: 'POST',
      body: JSON.stringify({ email: p.email, name: p.nome, nivel: p.conviteNivel || 'junior', title: p.title, phone: p.phone }),
    }, `Convite novo enviado a ${p.email} — o link anterior deixou de valer.`)
  }

  const visiveis = pessoas.filter(p => verInativos || p.situacao !== 'inativo')
  const inativos = pessoas.filter(p => p.situacao === 'inativo').length
  const comLogin = pessoas.filter(p => p.userId && p.situacao !== 'inativo').length

  const botao = (cor: string, fundo: string): React.CSSProperties => ({
    fontSize: 12, padding: '6px 11px', borderRadius: 8, border: '1px solid #e2e8f4',
    background: fundo, color: cor, cursor: 'pointer', fontWeight: 700,
  })

  return (
    <div>
      {modal?.tipo === 'convite' && <ConviteModal inicial={modal} onFim={(m) => { setModal(null); if (m) setMsg(m); carregar() }} />}
      {modal?.tipo === 'nivel' && <NivelModal p={modal.p} onFim={(m) => { setModal(null); if (m) setMsg(m); carregar() }} />}
      {modal?.tipo === 'editar' && <EditarModal p={modal.p} onFim={(m) => { setModal(null); if (m) setMsg(m); carregar() }} />}
      {modal?.tipo === 'crm' && <CrmModal p={modal.p} onFim={(m) => { setModal(null); if (m) setMsg(m); carregar() }} />}
      {grants && <GrantsModal user={grants} onClose={() => { setGrants(null); carregar() }} />}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 24, color: '#0f2340', margin: '0 0 4px' }}>Equipe</h1>
          <p style={{ color: '#6a7a9a', fontSize: 13.5, margin: 0, lineHeight: 1.5, maxWidth: 620 }}>
            Quem entra no sistema, com que nível, e quem aparece como responsável nos clientes — num lugar só.
            {' '}{comLogin} com login{inativos ? ` · ${inativos} fora da equipe` : ''}.
          </p>
        </div>
        {pode && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setModal({ tipo: 'crm' })} style={botao('#2D3278', '#f0f4ff')}>＋ Só responsável (sem login)</button>
            <button onClick={() => setModal({ tipo: 'convite' })}
              style={{ background: 'linear-gradient(135deg,#2D3278,#1a1f5e)', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
              ＋ Convidar para o sistema
            </button>
          </div>
        )}
      </div>

      {aviso && <Faixa cor="#7a5a10" fundo="#fff8e8">⚠️ {aviso}</Faixa>}
      {erro && <Faixa cor="#b02020" fundo="#fdf0f0">⚠️ {erro}</Faixa>}
      {msg && (
        <Faixa cor={msg.startsWith('✓') ? '#1a6b4a' : '#b02020'} fundo={msg.startsWith('✓') ? '#e8f5ee' : '#fdf0f0'}>
          {msg}
          <button onClick={() => setMsg('')} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontWeight: 800 }}>✕</button>
        </Faixa>
      )}
      {!pode && !erro && !aviso && !carregando && (
        <Faixa cor="#4a5a70" fundo="#f0f4fa">Só o sócio altera a equipe. Aqui você vê quem é quem.</Faixa>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10, marginBottom: 18 }}>
        {NIVEIS.map(n => (
          <div key={n} style={{ background: '#fff', borderRadius: 10, padding: '12px 14px', border: `1.5px solid ${COR[n].c}20` }}>
            <span style={{ fontSize: 11.5, padding: '2px 9px', borderRadius: 20, fontWeight: 700, background: COR[n].bg, color: COR[n].c }}>{ROTULO_DO_NIVEL[n]}</span>
            <div style={{ fontSize: 12, color: '#4a5a70', lineHeight: 1.45, marginTop: 6 }}>{DESCRICAO[n]}</div>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 12.5, color: '#6a7a9a', margin: '-6px 0 16px' }}>
        🔑 Autorizações somam ou tiram uma permissão de uma pessoa sem mudar o nível dela.
      </p>

      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f4' }}>
        {carregando ? (
          <div style={{ padding: 32, textAlign: 'center', color: '#6a7a9a' }}>Carregando…</div>
        ) : visiveis.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: '#6a7a9a' }}>{erro ? '' : 'Ninguém na equipe ainda.'}</div>
        ) : visiveis.map(p => {
          const souEu = !!p.userId && p.userId === eu
          const cor = p.nivel ? COR[p.nivel] : { c: '#6a7a9a', bg: '#f0f4fa' }
          const age = pode && !souEu && ocupado !== p.chave
          return (
            <div key={p.chave} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderTop: '1px solid #f0f4fa', flexWrap: 'wrap', opacity: p.situacao === 'inativo' ? 0.6 : 1 }}>
              <div style={{ width: 38, height: 38, borderRadius: 11, background: p.situacao === 'inativo' ? '#e2e8f4' : '#2D327814', color: '#2D3278', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13.5, fontWeight: 800, flexShrink: 0 }}>
                {p.nome.trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase() || '?'}
              </div>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#0F2340' }}>
                  {p.nome}{souEu && <span style={{ fontSize: 11.5, color: '#6a7a9a', fontWeight: 600 }}> · você</span>}
                </div>
                <div style={{ fontSize: 12.5, color: '#6a7a9a', overflowWrap: 'anywhere' }}>
                  {[p.email, p.title].filter(Boolean).join(' · ') || '—'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flex: '1 1 220px' }}>
                {p.nivel && p.situacao !== 'convidado' && (
                  <span style={{ fontSize: 11.5, padding: '3px 10px', borderRadius: 20, fontWeight: 700, background: cor.bg, color: cor.c }}>{ROTULO_DO_NIVEL[p.nivel]}</span>
                )}
                <Situacao p={p} />
                {p.temPin && <span style={{ fontSize: 11.5, color: '#1a6b4a' }}>🔑 PIN</span>}
                {p.userId && (
                  <span style={{ fontSize: 11.5, color: '#9aaab0' }}>
                    {p.ultimoAcesso ? `último acesso ${fmtUS(p.ultimoAcesso)}` : 'nunca entrou'}
                  </span>
                )}
              </div>
              {age && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {p.userId && p.situacao !== 'inativo' && <>
                    <button onClick={() => setModal({ tipo: 'nivel', p })} style={botao('#2D3278', '#f0f4ff')}>Nível</button>
                    {p.nivel !== 'owner' && (
                      <button onClick={() => setGrants({ id: p.userId!, name: p.nome })} style={botao('#7a5a10', '#fff8e8')}>🔑 Autorizações</button>
                    )}
                    <button onClick={() => setModal({ tipo: 'editar', p })} style={botao('#2D3278', '#fff')}>Editar</button>
                    {p.temPin && <button onClick={() => zerarPin(p)} style={botao('#b02020', '#fff')}>Zerar PIN</button>}
                    <button onClick={() => desativar(p)} style={botao('#b02020', '#fff5f5')}>Desativar</button>
                  </>}
                  {p.situacao === 'convidado' && (
                    <button onClick={() => reenviar(p)} style={botao('#1a6b4a', '#f0f4fa')}>↻ Reenviar convite</button>
                  )}
                  {!p.userId && p.memberId && p.situacao !== 'inativo' && <>
                    {p.situacao === 'sem-login' && (
                      <button onClick={() => setModal({ tipo: 'convite', nome: p.nome, email: p.email || '' })} style={botao('#1a6b4a', '#e8f5ee')}>Convidar para o sistema</button>
                    )}
                    <button onClick={() => setModal({ tipo: 'crm', p })} style={botao('#2D3278', '#fff')}>Renomear</button>
                    <button onClick={() => desativar(p)} style={botao('#b02020', '#fff5f5')}>Desativar</button>
                  </>}
                  {p.situacao === 'inativo' && (p.userId || p.memberId) && (
                    <button onClick={() => reativar(p)} style={botao('#1a6b4a', '#e8f5ee')}>↺ Reativar</button>
                  )}
                </div>
              )}
              {ocupado === p.chave && <span style={{ fontSize: 12, color: '#6a7a9a' }}>…</span>}
            </div>
          )
        })}
      </div>

      {inativos > 0 && (
        <button onClick={() => setVerInativos(!verInativos)} style={{ ...botao('#6a7a9a', '#f0f4fa'), marginTop: 12 }}>
          {verInativos ? 'Esconder quem saiu' : `Mostrar quem saiu (${inativos})`}
        </button>
      )}
    </div>
  )
}

function Faixa({ cor, fundo, children }: { cor: string; fundo: string; children: React.ReactNode }) {
  return <div style={{ marginBottom: 14, padding: '11px 14px', borderRadius: 10, fontSize: 13.5, fontWeight: 600, background: fundo, color: cor, lineHeight: 1.45 }}>{children}</div>
}

function Situacao({ p }: { p: PessoaDaEquipe }) {
  const s = (t: string, c: string, bg: string) =>
    <span style={{ fontSize: 11.5, padding: '3px 9px', borderRadius: 20, fontWeight: 700, background: bg, color: c }}>{t}</span>
  switch (p.situacao) {
    case 'convidado':    return s(`✉️ convite até ${fmtUS(p.conviteExpira)}${p.conviteNivel ? ` · ${ROTULO_DO_NIVEL[p.conviteNivel]}` : ''}`, '#1a6b4a', '#e8f5ee')
    case 'sem-login':    return s('só responsável no CRM · sem login', '#6a7a9a', '#f0f4fa')
    case 'sem-cadastro': return s('⚠️ sem cadastro na equipe — o nível vem do login; confirme o nível (botão Nível) para acertar', '#7a5a10', '#fff8e8')
    case 'inativo':      return s('saiu da equipe', '#9aaab0', '#f0f4fa')
    default:             return null
  }
}

// ── Os modais ─────────────────────────────────────────────────────────────

const fundoModal: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,35,64,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }
const caixaModal: React.CSSProperties = { background: '#fff', borderRadius: 18, width: '100%', maxWidth: 480, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 30px 80px rgba(0,0,0,0.4)' }
const rotulo: React.CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 700, color: '#6a7a9a', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }
const campo: React.CSSProperties = { width: '100%', padding: '10px 12px', border: '1.5px solid #e2e8f4', borderRadius: 9, fontSize: 14, boxSizing: 'border-box', outline: 'none', marginBottom: 12 }

function Moldura({ titulo, onFechar, children }: { titulo: string; onFechar: () => void; children: React.ReactNode }) {
  return (
    <div style={fundoModal}>
      <div style={caixaModal}>
        <div style={{ background: 'linear-gradient(135deg,#2D3278,#1a1f5e)', padding: '16px 20px', borderRadius: '18px 18px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 17, color: '#fff', margin: 0 }}>{titulo}</h2>
          <button onClick={onFechar} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', width: 28, height: 28, borderRadius: 7, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ padding: '18px 20px' }}>{children}</div>
      </div>
    </div>
  )
}

function Rodape({ erro, ocupado, rotuloOk, onOk, onCancelar, desligado }: {
  erro: string; ocupado: boolean; rotuloOk: string; onOk: () => void; onCancelar: () => void; desligado?: boolean
}) {
  const off = ocupado || !!desligado
  return <>
    {erro && <div style={{ background: '#fdf0f0', color: '#b02020', padding: '9px 12px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{erro}</div>}
    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
      <button onClick={onCancelar} style={{ padding: '10px 16px', borderRadius: 9, border: '1px solid #e2e8f4', background: '#f8faff', color: '#6a7a9a', cursor: 'pointer', fontSize: 13.5 }}>Cancelar</button>
      <button onClick={onOk} disabled={off} style={{ padding: '10px 20px', borderRadius: 9, border: 'none', background: off ? '#e2e8f4' : 'linear-gradient(135deg,#2D3278,#1a1f5e)', color: off ? '#9aaab0' : '#fff', cursor: off ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700 }}>
        {ocupado ? 'Salvando…' : rotuloOk}
      </button>
    </div>
  </>
}

function EscolhaDeNivel({ valor, onEscolher, atual }: { valor: StaffLevel | ''; onEscolher: (n: StaffLevel) => void; atual?: StaffLevel | null }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
      {NIVEIS.map(n => (
        <label key={n} style={{ display: 'flex', gap: 10, padding: '10px 12px', borderRadius: 9, cursor: 'pointer', border: valor === n ? `2px solid ${COR[n].c}` : '1.5px solid #e2e8f4', background: valor === n ? COR[n].bg : '#fff' }}>
          <input type="radio" checked={valor === n} onChange={() => onEscolher(n)} style={{ accentColor: COR[n].c }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 13.5, color: COR[n].c }}>{ROTULO_DO_NIVEL[n]}{atual === n ? ' (atual)' : ''}</div>
            <div style={{ fontSize: 12, color: '#6a7a9a', marginTop: 2, lineHeight: 1.4 }}>{DESCRICAO[n]}</div>
          </div>
        </label>
      ))}
    </div>
  )
}

function ConviteModal({ inicial, onFim }: { inicial: { nome?: string; email?: string }; onFim: (msg?: string) => void }) {
  const [f, setF] = useState({ name: inicial.nome || '', email: inicial.email || '', title: '', phone: '' })
  const [nivel, setNivel] = useState<StaffLevel | ''>('junior')
  const [erro, setErro] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const [link, setLink] = useState<{ url: string; motivo: string | null; enviado: boolean } | null>(null)

  const enviar = async () => {
    setErro('')
    if (f.name.trim().length < 2 || !f.email.trim()) { setErro('Nome e e-mail são obrigatórios.'); return }
    setOcupado(true)
    const r = await fetch('/api/firm/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...f, nivel }) })
    const d = await r.json().catch(() => ({}))
    setOcupado(false)
    if (!r.ok || d.error) { setErro(d.error || `Erro ${r.status}`); return }
    setLink({ url: d.setupUrl, motivo: d.motivoEmail || null, enviado: !!d.emailSent })
  }

  if (link) return (
    <Moldura titulo="Convite" onFechar={() => onFim(`✓ Convite para ${f.email}.`)}>
      {link.enviado ? (
        <p style={{ fontSize: 14, color: '#1a6b4a', marginTop: 0 }}>✉️ Enviado para <strong>{f.email}</strong>. O link vale 7 dias e cria a senha da pessoa.</p>
      ) : (
        <>
          <p style={{ fontSize: 14, color: '#b02020', marginTop: 0 }}>O e-mail NÃO saiu{link.motivo ? ` — ${link.motivo}` : ''}.</p>
          <p style={{ fontSize: 13.5, color: '#4a5a70' }}>Mande você este link para a pessoa (vale 7 dias, uma vez):</p>
          <input readOnly value={link.url} onFocus={e => e.currentTarget.select()} style={campo} />
        </>
      )}
      <Rodape erro="" ocupado={false} rotuloOk="Pronto" onOk={() => onFim(`✓ Convite para ${f.email}.`)} onCancelar={() => onFim(`✓ Convite para ${f.email}.`)} />
    </Moldura>
  )

  return (
    <Moldura titulo="Convidar para o sistema" onFechar={() => onFim()}>
      <p style={{ fontSize: 13, color: '#4a5a70', marginTop: 0, lineHeight: 1.5 }}>
        A pessoa recebe um link para criar a própria senha. Se ela já aparece como responsável no CRM (mesmo e-mail, ou mesmo nome sem e-mail), o aceite completa aquela linha — os clientes que ela atendia continuam com ela.
      </p>
      <label style={rotulo}>Nome completo *</label>
      <input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} style={campo} />
      <label style={rotulo}>E-mail *</label>
      <input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} style={campo} />
      <label style={rotulo}>Cargo</label>
      <input value={f.title} onChange={e => setF({ ...f, title: e.target.value })} style={campo} />
      <label style={rotulo}>Telefone</label>
      <input type="tel" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} style={campo} />
      <label style={rotulo}>Nível *</label>
      <EscolhaDeNivel valor={nivel} onEscolher={setNivel} />
      <Rodape erro={erro} ocupado={ocupado} rotuloOk="Enviar convite" onOk={enviar} onCancelar={() => onFim()} />
    </Moldura>
  )
}

function NivelModal({ p, onFim }: { p: PessoaDaEquipe; onFim: (msg?: string) => void }) {
  const [nivel, setNivel] = useState<StaffLevel | ''>('')
  const [motivo, setMotivo] = useState('')
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState('')
  const [ocupado, setOcupado] = useState(false)

  const salvar = async () => {
    setErro(''); setOcupado(true)
    const r = await fetch(`/api/firm/users/${p.userId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ acao: 'nivel', nivel, motivo, senha }),
    })
    const d = await r.json().catch(() => ({}))
    setOcupado(false)
    if (!r.ok || d.error) { setErro(d.error || `Erro ${r.status}`); return }
    onFim(`✓ ${p.nome}: ${d.mensagem}${d.aviso ? ` — atenção: ${d.aviso}` : ''}`)
  }

  return (
    <Moldura titulo={`Nível · ${p.nome}`} onFechar={() => onFim()}>
      <p style={{ fontSize: 13, color: '#4a5a70', marginTop: 0, lineHeight: 1.5 }}>
        O nível decide o que a pessoa pode fazer em todo o sistema. A mudança pede a sua senha e o motivo, e fica na trilha. Passar a Assistente apaga o PIN de aprovação.
      </p>
      <EscolhaDeNivel valor={nivel} onEscolher={setNivel} atual={p.nivel} />
      <label style={rotulo}>Motivo *</label>
      <textarea value={motivo} onChange={e => setMotivo(e.target.value)} rows={2} style={{ ...campo, resize: 'vertical' }} placeholder="Ex.: assumiu a gerência do escritório" />
      <label style={rotulo}>Sua senha *</label>
      <input type="password" value={senha} onChange={e => setSenha(e.target.value)} autoComplete="current-password" style={campo} />
      <Rodape erro={erro} ocupado={ocupado} rotuloOk="Mudar o nível" onOk={salvar} onCancelar={() => onFim()}
        desligado={!nivel || (nivel === p.nivel && p.situacao !== 'sem-cadastro') || motivo.trim().length < 5 || !senha} />
    </Moldura>
  )
}

function EditarModal({ p, onFim }: { p: PessoaDaEquipe; onFim: (msg?: string) => void }) {
  const [f, setF] = useState({ name: p.nome, title: p.title || '', phone: p.phone || '' })
  const [erro, setErro] = useState('')
  const [ocupado, setOcupado] = useState(false)

  const salvar = async () => {
    setErro(''); setOcupado(true)
    const r = await fetch(`/api/firm/users/${p.userId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ acao: 'editar', ...f }),
    })
    const d = await r.json().catch(() => ({}))
    setOcupado(false)
    if (!r.ok || d.error) { setErro(d.error || `Erro ${r.status}`); return }
    onFim(`✓ ${f.name} atualizado.${d.renomeados ? ` ${d.renomeados} cliente(s) com o nome novo.` : ''}${d.aviso ? ` Atenção: ${d.aviso}` : ''}`)
  }

  return (
    <Moldura titulo={`Editar · ${p.nome}`} onFechar={() => onFim()}>
      <p style={{ fontSize: 13, color: '#4a5a70', marginTop: 0, lineHeight: 1.5 }}>
        Editar não mexe no nível — o nível muda no botão Nível. O nome é também o de responsável nos clientes.
      </p>
      <label style={rotulo}>Nome</label>
      <input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} style={campo} />
      <label style={rotulo}>E-mail (é o login)</label>
      <input value={p.email || ''} disabled style={{ ...campo, background: '#f8faff', color: '#9aaab0' }} />
      <label style={rotulo}>Cargo</label>
      <input value={f.title} onChange={e => setF({ ...f, title: e.target.value })} style={campo} />
      <label style={rotulo}>Telefone</label>
      <input type="tel" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} style={campo} />
      <Rodape erro={erro} ocupado={ocupado} rotuloOk="Salvar" onOk={salvar} onCancelar={() => onFim()} />
    </Moldura>
  )
}

/** Responsável no CRM, sem login: incluir (sem `p`) ou renomear. */
function CrmModal({ p, onFim }: { p?: PessoaDaEquipe; onFim: (msg?: string) => void }) {
  const [f, setF] = useState({ name: p?.nome || '', email: p?.email || '' })
  const [erro, setErro] = useState('')
  const [ocupado, setOcupado] = useState(false)

  const salvar = async () => {
    setErro(''); setOcupado(true)
    const r = await fetch('/api/team', {
      method: p ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(p ? { id: p.memberId, ...f } : f),
    })
    const d = await r.json().catch(() => ({}))
    setOcupado(false)
    if (!r.ok || d.error) { setErro(d.error || `Erro ${r.status}`); return }
    onFim(p ? `✓ ${f.name} atualizado.${d.renomeados ? ` ${d.renomeados} cliente(s) com o nome novo.` : ''}` : `✓ ${f.name} entrou como responsável no CRM.`)
  }

  return (
    <Moldura titulo={p ? `Renomear · ${p.nome}` : 'Responsável no CRM (sem login)'} onFechar={() => onFim()}>
      <p style={{ fontSize: 13, color: '#4a5a70', marginTop: 0, lineHeight: 1.5 }}>
        Aparece no seletor de responsável dos clientes, mas não entra no sistema. Para dar acesso, use Convidar para o sistema.
      </p>
      <label style={rotulo}>Nome completo *</label>
      <input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} style={campo} />
      <label style={rotulo}>E-mail</label>
      <input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} style={campo} />
      <Rodape erro={erro} ocupado={ocupado} rotuloOk={p ? 'Salvar' : 'Incluir'} onOk={salvar} onCancelar={() => onFim()} desligado={f.name.trim().length < 2} />
    </Moldura>
  )
}
