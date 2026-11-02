'use client'
// /dashboard/account — Minha Conta (equipe)
// Alterar senha · Definir o PRÓPRIO PIN de aprovação (owner/manager)
//
// A gestão da equipe (níveis, PIN dos outros) saiu daqui e foi para a tela
// Equipe, junto com o resto da equipe (lib/equipe.ts). Aqui o sócio trocava
// o nível de qualquer pessoa sem senha, sem motivo e sem rastro.

import { useState, useEffect } from 'react'
import Link from 'next/link'

const LEVEL_LABEL: Record<string,string> = { owner:'👑 Sócio', manager:'⭐ Gerente', junior:'👤 Assistente' }
const LEVEL_COLOR: Record<string,string> = { owner:'#5a1a8a', manager:'#2D3278', junior:'#6a7a9a' }

export default function AccountPage() {
  const [myLevel, setMyLevel] = useState<string>('junior')
  const [temPin,  setTemPin]  = useState(false)

  // Senha
  const [curPw,  setCurPw]  = useState(''); const [newPw,  setNewPw]  = useState('')
  const [newPw2, setNewPw2] = useState(''); const [pwMsg,  setPwMsg]  = useState('')
  const [pwSaving, setPwSaving] = useState(false)

  // PIN
  const [pinPw,  setPinPw]  = useState(''); const [newPin, setNewPin] = useState('')
  const [pinMsg, setPinMsg] = useState('');  const [pinSaving, setPinSaving] = useState(false)

  const load = async () => {
    const d = await fetch('/api/account/pin').then(r => r.json()).catch(() => ({}))
    setMyLevel(d.nivel || 'junior')
    setTemPin(!!d.temPin)
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
          <h2 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:'0 0 6px' }}>🔑 PIN de aprovação {temPin ? <span style={{ fontSize:12, color:'#1a6b4a' }}>· ativo</span> : <span style={{ fontSize:12, color:'#9aaab0' }}>· não definido</span>}</h2>
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

      {/* ---- A equipe mora em Equipe ---- */}
      {myLevel !== 'junior' && (
        <p style={{ fontSize:13, color:'#6a7a9a' }}>
          Os níveis, os PINs e as autorizações de cada pessoa ficam em{' '}
          <Link href="/settings/users" style={{ color:'#2D3278', fontWeight:700 }}>Equipe</Link>
          {myLevel === 'owner' ? ' — mudar o nível de alguém pede a sua senha e o motivo.' : '.'}
        </p>
      )}
    </div>
  )
}
