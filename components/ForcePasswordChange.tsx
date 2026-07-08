'use client'
// ForcePasswordChange — modal de troca obrigatória de senha provisória
// Renderizar no layout do portal do cliente. Aparece quando
// user_metadata.must_change_password === true. Some após a troca.

import { useState, useEffect } from 'react'
import { createBrowserClient } from '@supabase/ssr'

export default function ForcePasswordChange() {
  const [show, setShow] = useState(false)
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.user_metadata?.must_change_password) setShow(true)
    })
  }, [])

  const save = async () => {
    setMsg('')
    if (pw1.length < 8) { setMsg('A senha precisa de pelo menos 8 caracteres.'); return }
    if (pw1 !== pw2) { setMsg('As senhas não conferem.'); return }
    setBusy(true)
    const { error } = await supabase.auth.updateUser({
      password: pw1,
      data: { must_change_password: false },
    })
    if (error) { setMsg(`Erro: ${error.message}`); setBusy(false); return }
    setShow(false)
  }

  if (!show) return null

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(15,35,64,0.75)', display:'flex',
      alignItems:'center', justifyContent:'center', zIndex:5000, padding:16 }}>
      <div style={{ background:'#fff', borderRadius:18, padding:28, width:420, maxWidth:'94vw' }}>
        <h2 style={{ fontFamily:'Georgia,serif', fontSize:20, color:'#2D3278', margin:'0 0 6px' }}>
          🔑 Crie sua nova senha
        </h2>
        <p style={{ fontSize:14, color:'#5a6a7a', margin:'0 0 18px', lineHeight:1.6 }}>
          Você entrou com uma senha provisória. Por segurança, defina agora a sua senha definitiva.
        </p>
        <label style={{ display:'block', fontSize:13, fontWeight:700, color:'#6a7a9a', marginBottom:5 }}>Nova senha</label>
        <input type="password" value={pw1} onChange={e => setPw1(e.target.value)} autoComplete="new-password"
          style={{ width:'100%', padding:'13px 14px', border:'1.5px solid #e2e8f4', borderRadius:10, fontSize:16, outline:'none', marginBottom:14, minHeight:48 }} />
        <label style={{ display:'block', fontSize:13, fontWeight:700, color:'#6a7a9a', marginBottom:5 }}>Repita a nova senha</label>
        <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password"
          style={{ width:'100%', padding:'13px 14px', border:'1.5px solid #e2e8f4', borderRadius:10, fontSize:16, outline:'none', marginBottom:14, minHeight:48 }} />
        {msg && <p style={{ fontSize:13, fontWeight:600, color:'#b02020', margin:'0 0 12px' }}>{msg}</p>}
        <button onClick={save} disabled={busy}
          style={{ width:'100%', padding:'15px', background: busy ? '#e2e8f4' : '#F47B20', color: busy ? '#9aaab0' : '#fff',
            border:'none', borderRadius:12, fontSize:16, fontWeight:800, cursor: busy ? 'not-allowed' : 'pointer', minHeight:54 }}>
          {busy ? 'Salvando…' : '✓ Salvar nova senha'}
        </button>
      </div>
    </div>
  )
}
