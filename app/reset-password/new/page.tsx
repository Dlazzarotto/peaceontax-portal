'use client'
import { useState, useEffect } from 'react'
import { supabaseBrowser } from '@/lib/supabase-browser'
import { useRouter } from 'next/navigation'

export default function NewPasswordPage() {
  const router = useRouter()
  const [pass,  setPass]  = useState('')
  const [pass2, setPass2] = useState('')
  const [done,  setDone]  = useState(false)
  const [err,   setErr]   = useState('')
  const [busy,  setBusy]  = useState(false)
  const [hasSession, setHasSession] = useState<boolean | null>(null)

  // O link do e-mail precisa ter criado a sessão de recuperação —
  // sem ela, gravar senha é impossível (e antes a tela fingia sucesso).
  useEffect(() => {
    const sb = supabaseBrowser()
    sb.auth.getSession().then(({ data }) => setHasSession(!!data.session))
  }, [])

  const update = async () => {
    setErr('')
    if (pass !== pass2) { setErr('As senhas não conferem — digite a mesma nos dois campos.'); return }
    setBusy(true)
    const sb = supabaseBrowser()
    const { error } = await sb.auth.updateUser({ password: pass })
    setBusy(false)
    if (error) {
      if (/session/i.test(error.message)) {
        setErr('O link expirou ou foi aberto em outro navegador. Peça um novo link e abra no mesmo aparelho.')
      } else if (/different from the old/i.test(error.message)) {
        setErr('A nova senha precisa ser diferente da atual.')
      } else {
        setErr(`Não foi possível salvar: ${error.message}`)
      }
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
      <h1 style={{ fontFamily:'Georgia,serif', fontSize:20, color:'#2D3278', marginBottom:16 }}>🔒 Nova senha</h1>

      {hasSession === false && (
        <>
          <p style={{ color:'#b02020', fontSize:13.5, lineHeight:1.5 }}>
            ⚠️ Este link expirou ou foi aberto em um navegador diferente do que pediu a redefinição.
          </p>
          <a href="/reset-password" style={{ display:'block', textAlign:'center', marginTop:14, padding:'12px', background:'#2D3278', color:'#fff', borderRadius:10, fontSize:14, fontWeight:700, textDecoration:'none' }}>
            Pedir um novo link
          </a>
        </>
      )}

      {hasSession && !done && (
        <>
          <input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="Nova senha (mín. 8 caracteres)" style={inp} />
          <input type="password" value={pass2} onChange={e => setPass2(e.target.value)} placeholder="Repita a nova senha" style={inp} />
          {err && <p style={{ color:'#b02020', fontSize:12.5, margin:'0 0 12px', lineHeight:1.45 }}>⚠️ {err}</p>}
          <button onClick={update} disabled={pass.length < 8 || busy}
            style={{ width:'100%', padding:'12px', background: busy ? '#9aaab0' : '#2D3278', color:'#fff', border:'none', borderRadius:10, fontSize:14, cursor: busy ? 'wait' : 'pointer', fontWeight:700 }}>
            {busy ? 'Salvando…' : 'Salvar nova senha'}
          </button>
        </>
      )}

      {done && (
        <p style={{ color:'#1a6b4a', fontSize:14, lineHeight:1.5 }}>
          ✅ Senha alterada com sucesso! Levando você ao login para entrar com ela…
        </p>
      )}

      {hasSession === null && <p style={{ color:'#6a7a9a', fontSize:13 }}>Verificando o link…</p>}
    </div></div>
  )
}
