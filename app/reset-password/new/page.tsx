'use client'
import { useState, useEffect } from 'react'
import { supabaseBrowser } from '@/lib/supabase-browser'
import { useRouter } from 'next/navigation'

export default function NewPasswordPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [code,  setCode]  = useState('')
  const [pass,  setPass]  = useState('')
  const [pass2, setPass2] = useState('')
  const [done,  setDone]  = useState(false)
  const [err,   setErr]   = useState('')
  const [busy,  setBusy]  = useState(false)

  useEffect(() => {
    try { const e = sessionStorage.getItem('reset_email'); if (e) setEmail(e) } catch {}
  }, [])

  const update = async () => {
    setErr('')
    if (!email.trim()) { setErr('Informe o e-mail que recebeu o código.'); return }
    if (code.trim().length < 6) { setErr('Digite o código de 6 dígitos do e-mail.'); return }
    if (pass.length < 8) { setErr('A senha precisa de pelo menos 8 caracteres.'); return }
    if (pass !== pass2) { setErr('As senhas não conferem — digite a mesma nos dois campos.'); return }
    setBusy(true)
    const sb = supabaseBrowser()

    // 1. Valida o código do e-mail (à prova de scanners de link)
    const { error: otpErr } = await sb.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: code.trim(),
      type: 'recovery',
    })
    if (otpErr) {
      setBusy(false)
      setErr(/expired|invalid/i.test(otpErr.message)
        ? 'Código inválido ou vencido. Peça um novo em "Redefinir senha" e use o código do e-mail MAIS RECENTE.'
        : `Não foi possível validar: ${otpErr.message}`)
      return
    }

    // 2. Grava a nova senha (com erro visível se falhar)
    const { error: upErr } = await sb.auth.updateUser({ password: pass })
    setBusy(false)
    if (upErr) {
      setErr(/different from the old/i.test(upErr.message)
        ? 'A nova senha precisa ser diferente da atual.'
        : `Não foi possível salvar: ${upErr.message}`)
      return
    }
    setDone(true)
    await sb.auth.signOut()
    setTimeout(() => router.push('/login'), 2500)
  }

  const s: React.CSSProperties = { minHeight:'100vh', background:'linear-gradient(135deg,#2D3278,#1a1f5e)', display:'flex', alignItems:'center', justifyContent:'center' }
  const card: React.CSSProperties = { background:'#fff', borderRadius:20, padding:'40px 36px', width:380, boxShadow:'0 20px 60px rgba(0,0,0,0.4)' }
  const inp: React.CSSProperties = { width:'100%', padding:'11px 13px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, marginBottom:12, boxSizing:'border-box' as const, outline:'none' }

  return (
    <div style={s}><div style={card}>
      <h1 style={{ fontFamily:'Georgia,serif', fontSize:20, color:'#2D3278', marginBottom:6 }}>🔒 Nova senha</h1>
      {!done && (
        <>
          <p style={{ fontSize:12.5, color:'#6a7a9a', margin:'0 0 14px', lineHeight:1.5 }}>
            Digite o <b>código de 6 dígitos</b> que enviamos ao seu e-mail e escolha a nova senha.
          </p>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Seu e-mail" style={inp} />
          <input inputMode="numeric" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="Código de 6 dígitos" style={{ ...inp, letterSpacing: 6, fontWeight: 800, fontSize: 18, textAlign:'center' as const }} />
          <input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="Nova senha (mín. 8 caracteres)" style={inp} />
          <input type="password" value={pass2} onChange={e => setPass2(e.target.value)} placeholder="Repita a nova senha" style={inp} />
          {err && <p style={{ color:'#b02020', fontSize:12.5, margin:'0 0 12px', lineHeight:1.45 }}>⚠️ {err}</p>}
          <button onClick={update} disabled={busy}
            style={{ width:'100%', padding:'12px', background: busy ? '#9aaab0' : '#2D3278', color:'#fff', border:'none', borderRadius:10, fontSize:14, cursor: busy ? 'wait' : 'pointer', fontWeight:700 }}>
            {busy ? 'Validando…' : 'Salvar nova senha'}
          </button>
          <a href="/reset-password" style={{ display:'block', textAlign:'center', marginTop:12, fontSize:12, color:'#6a7a9a' }}>
            Não recebeu? Pedir novo código
          </a>
        </>
      )}
      {done && (
        <p style={{ color:'#1a6b4a', fontSize:14, lineHeight:1.5 }}>
          ✅ Senha alterada com sucesso! Levando você ao login…
        </p>
      )}
    </div></div>
  )
}
