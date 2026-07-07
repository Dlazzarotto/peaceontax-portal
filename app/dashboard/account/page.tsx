'use client'
// /dashboard/account — Minha Conta (equipe)
// Alterar senha · Definir PIN de aprovação (owner/manager) · Gestão de equipe (owner)

import { useState, useEffect } from 'react'

interface TeamMember {
  userId: string; email: string; name: string
  level: 'owner'|'manager'|'junior'; hasPin: boolean; lastSignIn: string|null
}

const LEVEL_LABEL: Record<string,string> = { owner:'👑 Owner', manager:'⭐ Manager', junior:'👤 Junior' }
const LEVEL_COLOR: Record<string,string> = { owner:'#5a1a8a', manager:'#2D3278', junior:'#6a7a9a' }

export default function AccountPage() {
  const [myLevel, setMyLevel] = useState<string>('junior')
  const [team,    setTeam]    = useState<TeamMember[]>([])

  // Senha
  const [curPw,  setCurPw]  = useState(''); const [newPw,  setNewPw]  = useState('')
  const [newPw2, setNewPw2] = useState(''); const [pwMsg,  setPwMsg]  = useState('')
  const [pwSaving, setPwSaving] = useState(false)

  // PIN
  const [pinPw,  setPinPw]  = useState(''); const [newPin, setNewPin] = useState('')
  const [pinMsg, setPinMsg] = useState('');  const [pinSaving, setPinSaving] = useState(false)

  const [teamMsg, setTeamMsg] = useState('')

  const load = async () => {
    const r = await fetch('/api/account/team')
    const d = await r.json()
    if (d.team) { setTeam(d.team); setMyLevel(d.myLevel) }
    else {
      // Junior não vê a lista, mas ainda pode trocar senha
      const p = await fetch('/api/quotes/perms').then(x => x.json())
      setMyLevel(p.level || 'junior')
    }
  }
  useEffect(() => { load() }, [])

  const changePassword = async () => {
    setPwMsg('')
    if (newPw !== newPw2) { setPwMsg('As novas senhas não coincidem.'); return }
    if (newPw.length < 8) { setPwMsg('Nova senha: mínimo 8 caracteres.'); return }
    setPwSaving(true)
    const r = await fetch('/api/account/password', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ currentPassword: curPw, newPassword: newPw }),
    })
    const d = await r.json()
    setPwMsg(d.ok ? '✓ Senha alterada com sucesso.' : `Erro: ${d.error}`)
    if (d.ok) { setCurPw(''); setNewPw(''); setNewPw2('') }
    setPwSaving(false)
  }

  const changePin = async () => {
    setPinMsg('')
    if (!/^\d{4,8}$/.test(newPin)) { setPinMsg('PIN: 4 a 8 dígitos numéricos.'); return }
    setPinSaving(true)
    const r = await fetch('/api/account/pin', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ currentPassword: pinPw, newPin }),
    })
    const d = await r.json()
    setPinMsg(d.ok ? '✓ PIN definido com sucesso.' : `Erro: ${d.error}`)
    if (d.ok) { setPinPw(''); setNewPin(''); load() }
    setPinSaving(false)
  }

  const setLevel = async (targetUserId: string, level: string) => {
    setTeamMsg('')
    const r = await fetch('/api/account/team', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ targetUserId, level }),
    })
    const d = await r.json()
    setTeamMsg(d.ok ? '✓ Nível atualizado.' : `Erro: ${d.error}`)
    if (d.ok) load()
  }

  const resetPin = async (targetUserId: string, name: string) => {
    if (!confirm(`Resetar o PIN de ${name}? A pessoa precisará definir um novo em Minha Conta.`)) return
    const r = await fetch('/api/account/team', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ targetUserId, resetPin: true }),
    })
    const d = await r.json()
    setTeamMsg(d.ok ? '✓ PIN resetado.' : `Erro: ${d.error}`)
    if (d.ok) load()
  }

  const card  = { background:'#fff', borderRadius:14, padding:22, border:'1px solid #e2e8f4', marginBottom:18 }
  const input = { width:'100%', padding:'10px 12px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, outline:'none', marginBottom:10 }
  const label = { display:'block', fontSize:12, fontWeight:700, color:'#6a7a9a', marginBottom:4, textTransform:'uppercase' as const, letterSpacing:0.5 }
  const btn = (disabled: boolean) => ({
    padding:'10px 20px', background: disabled ? '#e2e8f4' : '#2D3278',
    color: disabled ? '#9aaab0' : '#fff', border:'none', borderRadius:9,
    fontSize:14, fontWeight:700, cursor: disabled ? 'not-allowed' : 'pointer',
  })
  const msgStyle = (m: string) => ({
    fontSize:13, fontWeight:600, marginTop:8,
    color: m.startsWith('✓') ? '#1a6b4a' : '#b02020',
  })

  const canPin = myLevel === 'owner' || myLevel === 'manager'

  return (
    <div style={{ maxWidth:640 }}>
      <h1 style={{ fontFamily:'Georgia,serif', fontSize:24, color:'#0f2340', marginBottom:6 }}>Minha Conta</h1>
      <p style={{ fontSize:13, color:'#6a7a9a', marginBottom:22 }}>
        Seu nível: <strong style={{ color:LEVEL_COLOR[myLevel] }}>{LEVEL_LABEL[myLevel] || myLevel}</strong>
      </p>

      {/* ---- Alterar senha ---- */}
      <div style={card}>
        <h2 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:'0 0 16px' }}>🔒 Alterar senha</h2>
        <label style={label}>Senha atual</label>
        <input type="password" value={curPw} onChange={e => setCurPw(e.target.value)} style={input} autoComplete="current-password" />
        <label style={label}>Nova senha (mín. 8 caracteres)</label>
        <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} style={input} autoComplete="new-password" />
        <label style={label}>Confirmar nova senha</label>
        <input type="password" value={newPw2} onChange={e => setNewPw2(e.target.value)} style={input} autoComplete="new-password" />
        <button onClick={changePassword} disabled={pwSaving || !curPw || !newPw} style={btn(pwSaving || !curPw || !newPw)}>
          {pwSaving ? 'Salvando…' : 'Alterar senha'}
        </button>
        {pwMsg && <p style={msgStyle(pwMsg)}>{pwMsg}</p>}
      </div>

      {/* ---- PIN de aprovação (owner/manager) ---- */}
      {canPin && (
        <div style={card}>
          <h2 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:'0 0 6px' }}>🔑 PIN de aprovação</h2>
          <p style={{ fontSize:13, color:'#6a7a9a', margin:'0 0 16px' }}>
            Membros junior usam seu PIN (com sua autorização verbal) para confirmar alterações e cancelamentos de cotação. Cada uso fica registrado na auditoria com seu nome como aprovador.
          </p>
          <label style={label}>Sua senha (confirmação)</label>
          <input type="password" value={pinPw} onChange={e => setPinPw(e.target.value)} style={input} autoComplete="current-password" />
          <label style={label}>Novo PIN (4–8 dígitos)</label>
          <input type="password" inputMode="numeric" maxLength={8} value={newPin}
            onChange={e => setNewPin(e.target.value.replace(/\D/g,''))}
            style={{ ...input, letterSpacing:6, fontWeight:700 }} />
          <button onClick={changePin} disabled={pinSaving || !pinPw || !newPin} style={btn(pinSaving || !pinPw || !newPin)}>
            {pinSaving ? 'Salvando…' : 'Definir PIN'}
          </button>
          {pinMsg && <p style={msgStyle(pinMsg)}>{pinMsg}</p>}
        </div>
      )}

      {/* ---- Gestão de equipe (owner) ---- */}
      {myLevel === 'owner' && team.length > 0 && (
        <div style={card}>
          <h2 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:'0 0 16px' }}>👥 Equipe</h2>
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {team.map(m => (
              <div key={m.userId} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 14px', background:'#f8faff', borderRadius:10, flexWrap:'wrap' }}>
                <div style={{ flex:1, minWidth:180 }}>
                  <div style={{ fontSize:14, fontWeight:700, color:'#1a2a3a' }}>{m.name}</div>
                  <div style={{ fontSize:12, color:'#6a7a9a' }}>{m.email}</div>
                </div>
                <span style={{ fontSize:11, fontWeight:700, padding:'3px 10px', borderRadius:20,
                  background:`${LEVEL_COLOR[m.level]}15`, color:LEVEL_COLOR[m.level] }}>
                  {LEVEL_LABEL[m.level]}
                </span>
                <span style={{ fontSize:11, color: m.hasPin ? '#1a6b4a' : '#9aaab0' }}>
                  {m.hasPin ? '🔑 PIN ativo' : 'sem PIN'}
                </span>
                {m.userId !== team.find(t => t.level==='owner' && t.email===m.email)?.userId || m.level !== 'owner' ? null : null}
                <select value={m.level} onChange={e => setLevel(m.userId, e.target.value)}
                  style={{ padding:'6px 10px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:12, fontWeight:700, outline:'none', cursor:'pointer' }}>
                  <option value="owner">Owner</option>
                  <option value="manager">Manager</option>
                  <option value="junior">Junior</option>
                </select>
                {m.hasPin && (
                  <button onClick={() => resetPin(m.userId, m.name)}
                    style={{ fontSize:11, padding:'5px 10px', borderRadius:7, border:'1px solid #fdd', background:'#fff5f5', color:'#b02020', cursor:'pointer', fontWeight:700 }}>
                    Resetar PIN
                  </button>
                )}
              </div>
            ))}
          </div>
          {teamMsg && <p style={msgStyle(teamMsg)}>{teamMsg}</p>}
          <p style={{ fontSize:12, color:'#9aaab0', marginTop:12 }}>
            Novos membros entram como junior por padrão. Owner define os níveis aqui; cada owner/manager define o próprio PIN na sua página Minha Conta.
          </p>
        </div>
      )}
    </div>
  )
}
