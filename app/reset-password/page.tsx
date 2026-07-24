'use client'
import { useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase-browser'

export default function ResetPage() {
  const [email, setEmail] = useState('')
  const [sent,  setSent]  = useState(false)
  const [err,   setErr]   = useState('')
  const [busy,  setBusy]  = useState(false)

  const send = async () => {
    setBusy(true); setErr('')
    const sb = supabaseBrowser()
    const { error } = await sb.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${window.location.origin}/auth/callback?type=recovery`,
    })
    setBusy(false)
    if (error) {
      if (/rate limit|too many/i.test(error.message)) {
        setErr('Limite de e-mails atingido — aguarde alguns minutos e tente de novo. Se for urgente, ligue (833) 732-2327.')
      } else {
        setErr(`Não foi possível enviar o link: ${error.message}. Fale conosco: (833) 732-2327.`)
      }
      return
    }
    setSent(true)
  }

  const s: React.CSSProperties = { minHeight:'100vh', background:'linear-gradient(135deg,#2D3278,#1a1f5e)', display:'flex', alignItems:'center', justifyContent:'center' }
  const card: React.CSSProperties = { background:'#fff', borderRadius:20, padding:'40px 36px', width:380, boxShadow:'0 20px 60px rgba(0,0,0,0.4)' }

  return (
    <div style={s}><div style={card}>
      <h1 style={{ fontFamily:'Georgia,serif', fontSize:20, color:'#2D3278', marginBottom:16 }}>🔑 Redefinir senha</h1>
      {sent ? (
        <>
          <p style={{ color:'#1a6b4a', fontSize:14, lineHeight:1.5 }}>
            ✉️ Enviamos o link para <b>{email.trim()}</b>.
          </p>
          <p style={{ color:'#6a7a9a', fontSize:12.5, lineHeight:1.5, marginTop:10 }}>
            <b>Importante:</b> abra o link <b>neste mesmo aparelho e navegador</b>. Não chegou em 2 minutos? Veja o spam.
          </p>
        </>
      ) : (
        <>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Seu e-mail de acesso"
            style={{ width:'100%', padding:'11px 13px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, marginBottom:14, boxSizing:'border-box' as const, outline:'none' }} />
          {err && <p style={{ color:'#b02020', fontSize:12.5, margin:'0 0 12px', lineHeight:1.45 }}>⚠️ {err}</p>}
          <button onClick={send} disabled={!email.trim() || busy}
            style={{ width:'100%', padding:'12px', background: busy ? '#9aaab0' : '#2D3278', color:'#fff', border:'none', borderRadius:10, fontSize:14, cursor: busy ? 'wait' : 'pointer', fontWeight:700 }}>
            {busy ? 'Enviando…' : 'Enviar link de redefinição'}
          </button>
        </>
      )}
      <div style={{ marginTop:14, textAlign:'center' }}>
        <a href="/login" style={{ fontSize:12, color:'#6a7a9a' }}>← Voltar ao login</a>
      </div>
    </div></div>
  )
}
