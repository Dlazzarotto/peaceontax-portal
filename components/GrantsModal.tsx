'use client'
// components/GrantsModal.tsx — autorizações individuais de um membro da equipe
//
// O nível continua sendo a base. Aqui o sócio AUTORIZA ou RETIRA uma
// permissão específica sem promover ninguém de degrau — o caso que originou
// isto foi a assistente que precisa emitir e receber no balcão, mas nunca
// pode ver o total vendido.
//
// Regras da tela, todas conferidas de novo no servidor:
//  - clicar não salva. Abre a linha de confirmação com o MOTIVO obrigatório.
//  - quando a autorização quebra separação de funções (princípio 1 da
//    especificação), o aviso aparece ANTES de confirmar, dizendo o quê.
//  - sócio não aparece com botões: ele tem tudo, e mudar isso é pelo nível.

import { useEffect, useState } from 'react'
import {
  PERMISSOES, permissoesDe, conflitoDeSeparacao,
  type ChavePermissao, type Concessoes, type Conjunto,
} from '@/lib/permissoes'

type Nivel = 'owner' | 'manager' | 'junior'

const NIVEL_LABEL: Record<Nivel, string> = {
  owner: 'Sócio', manager: 'Gerente', junior: 'Assistente',
}

export default function GrantsModal(
  { user, onClose }: { user: any; onClose: () => void },
) {
  const [nivel,      setNivel]      = useState<Nivel>('junior')
  const [concessoes, setConcessoes] = useState<Concessoes>({})
  const [carregando, setCarregando] = useState(true)
  const [erro,       setErro]       = useState('')
  const [aberta,     setAberta]     = useState<ChavePermissao | null>(null)
  const [motivo,     setMotivo]     = useState('')
  const [salvando,   setSalvando]   = useState(false)

  const carregar = () => {
    setCarregando(true)
    fetch(`/api/account/grants?userId=${user.id}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) setErro(d.error)
        else { setNivel(d.nivel); setConcessoes(d.concessoes || {}) }
        setCarregando(false)
      })
      .catch(() => { setErro('Não foi possível carregar as autorizações.'); setCarregando(false) })
  }
  useEffect(carregar, [user.id])

  const conjunto: Conjunto = permissoesDe(nivel, concessoes)
  const imune = nivel === 'owner'

  const abrir = (chave: ChavePermissao) => {
    setErro(''); setMotivo(''); setAberta(aberta === chave ? null : chave)
  }

  const confirmar = async (chave: ChavePermissao) => {
    const conceder = !conjunto[chave]
    setSalvando(true); setErro('')
    const res = await fetch('/api/account/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserId: user.id, chave, conceder, motivo }),
    })
    const d = await res.json()
    setSalvando(false)
    if (d.error) { setErro(d.error); return }
    setAberta(null); setMotivo('')
    carregar()
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(15,35,64,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:20 }}>
      <div style={{ background:'#fff', borderRadius:20, width:'100%', maxWidth:560, maxHeight:'88vh', display:'flex', flexDirection:'column', boxShadow:'0 30px 80px rgba(0,0,0,0.4)' }}>

        <div style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', padding:'18px 24px', borderRadius:'20px 20px 0 0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <h2 style={{ fontFamily:'Georgia,serif', fontSize:17, color:'#fff', margin:0 }}>Autorizações · {user.name}</h2>
            <p style={{ color:'rgba(255,255,255,0.6)', fontSize:12, margin:'3px 0 0' }}>
              Nível {NIVEL_LABEL[nivel]} — as autorizações abaixo somam ou tiram em cima dele
            </p>
          </div>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.15)', border:'none', color:'#fff', width:28, height:28, borderRadius:7, cursor:'pointer', fontSize:15 }}>✕</button>
        </div>

        <div style={{ padding:'18px 24px', overflowY:'auto' }}>
          {carregando ? (
            <div style={{ padding:32, textAlign:'center', color:'#6a7a9a' }}>Carregando…</div>
          ) : imune ? (
            <div style={{ background:'#e8eaff', border:'1px solid #c8cdf5', borderRadius:11, padding:'16px 18px', fontSize:13, color:'#2D3278', lineHeight:1.6 }}>
              <strong>Sócio tem acesso completo.</strong><br />
              Não existe autorização a dar nem a tirar aqui. Para mudar o que esta
              pessoa pode, altere o <strong>nível</strong> em Settings → Team — assim
              a mudança fica visível como mudança de cargo, não como uma chave solta.
            </div>
          ) : (
            <>
              {erro && <div style={{ background:'#fdf0f0', color:'#b02020', padding:'9px 13px', borderRadius:8, fontSize:13, marginBottom:14 }}>{erro}</div>}

              {PERMISSOES.map(p => {
                const ligada    = conjunto[p.chave]
                const explicita = typeof concessoes[p.chave] === 'boolean'
                const abertaAqui = aberta === p.chave
                const conflito  = conflitoDeSeparacao(
                  p.chave, !ligada,
                  permissoesDe(nivel, { ...concessoes, [p.chave]: !ligada }),
                )
                return (
                  <div key={p.chave} style={{ border:abertaAqui?'2px solid #2D3278':'1.5px solid #e2e8f4', borderRadius:11, padding:'12px 14px', marginBottom:9, background:ligada?'#f6fbf8':'#fff' }}>
                    <div style={{ display:'flex', alignItems:'flex-start', gap:12 }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontWeight:700, fontSize:13, color:'#1a2a3a', display:'flex', alignItems:'center', gap:7, flexWrap:'wrap' as const }}>
                          {p.titulo}
                          {explicita && (
                            <span style={{ fontSize:10, padding:'2px 7px', borderRadius:20, fontWeight:700, background: ligada?'#e8f5ee':'#fdf0f0', color: ligada?'#1a6b4a':'#b02020' }}>
                              {ligada ? 'autorizado à parte' : 'retirado'}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize:11.5, color:'#6a7a9a', marginTop:3, lineHeight:1.5 }}>{p.descricao}</div>
                      </div>
                      <button onClick={() => abrir(p.chave)} disabled={salvando}
                        style={{ flexShrink:0, width:56, height:30, borderRadius:20, border:'none', cursor:salvando?'not-allowed':'pointer', background: ligada?'#1a6b4a':'#d8e0ee', position:'relative' as const, transition:'background .15s' }}
                        aria-label={ligada ? `Retirar ${p.titulo}` : `Autorizar ${p.titulo}`}>
                        <span style={{ position:'absolute' as const, top:3, left: ligada?29:3, width:24, height:24, borderRadius:'50%', background:'#fff', transition:'left .15s', boxShadow:'0 1px 3px rgba(0,0,0,0.3)' }} />
                      </button>
                    </div>

                    {abertaAqui && (
                      <div style={{ marginTop:12, paddingTop:12, borderTop:'1px solid #e2e8f4' }}>
                        <div style={{ fontSize:12.5, color:'#1a2a3a', fontWeight:700, marginBottom:8 }}>
                          {ligada ? `Retirar "${p.titulo}"?` : `Autorizar "${p.titulo}"?`}
                        </div>

                        {conflito && (
                          <div style={{ background:'#fff8e8', border:'1px solid #f0d8a0', borderRadius:9, padding:'10px 12px', fontSize:12, color:'#7a5a10', marginBottom:9, lineHeight:1.55 }}>
                            ⚠️ <strong>{conflito}</strong><br />
                            É o princípio 1 da especificação — quem emite não dá baixa.
                            Você pode autorizar assim mesmo; o motivo abaixo fica
                            gravado junto com o seu nome e a data.
                          </div>
                        )}

                        <input value={motivo} onChange={e => setMotivo(e.target.value)}
                          placeholder="Motivo (ex.: atendimento de balcão na temporada)"
                          style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, boxSizing:'border-box' as const, outline:'none', marginBottom:9 }} />

                        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                          <button onClick={() => setAberta(null)} style={{ padding:'8px 14px', borderRadius:8, border:'1px solid #e2e8f4', background:'#f8faff', color:'#6a7a9a', cursor:'pointer', fontSize:12.5 }}>Cancelar</button>
                          <button onClick={() => confirmar(p.chave)} disabled={salvando || motivo.trim().length < 3}
                            style={{ padding:'8px 18px', borderRadius:8, border:'none', fontSize:12.5, fontWeight:700, color:'#fff', cursor:(salvando||motivo.trim().length<3)?'not-allowed':'pointer', background:(salvando||motivo.trim().length<3)?'#c8d0e0':(ligada?'#b02020':'#1a6b4a') }}>
                            {salvando ? 'Salvando…' : ligada ? 'Retirar' : 'Autorizar'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}

              <div style={{ background:'#f8faff', borderRadius:10, padding:'12px 14px', fontSize:11.5, color:'#6a7a9a', lineHeight:1.6, marginTop:4 }}>
                Toda autorização e toda retirada fica gravada com quem autorizou,
                quando e por quê. O histórico não é sobrescrito: retirar não apaga
                a autorização anterior, registra a decisão nova.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
