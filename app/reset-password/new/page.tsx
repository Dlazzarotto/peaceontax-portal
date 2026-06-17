'use client'
import { useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase-browser'
import { useRouter } from 'next/navigation'

export default function NewPasswordPage() {
  const router = useRouter()
  const [pass, setPass] = useState('')
  const [done, setDone] = useState(false)

  const update = async () => {
    const sb = supabaseBrowser()
    await sb.auth.updateUser({ password: pass })
    setDone(true)
    setTimeout(() => router.push('/'), 2000)
  }

  const s: React.CSSProperties = { minHeight:'100vh', background:'linear-gradient(135deg,#2D3278,#1a1f5e)', display:'flex', alignItems:'center', justifyContent:'center' }
  const card: React.CSSProperties = { background:'#fff', borderRadius:20, padding:'40px 36px', width:380, boxShadow:'0 20px 60px rgba(0,0,0,0.4)' }

  return (
    <div style={s}><div style={card}>
      <h1 style={{ fontFamily:'Georgia,serif', fontSize:20, color:'#2D3278', marginBottom:16 }}>🔒 New Password</h1>
      {done ? <p style={{ color:'#1a6b4a' }}>Password updated! Redirecting…</p> : (
        <>
          <input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="New password (min 8 chars)" style={{ width:'100%', padding:'11px 13px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, marginBottom:14, boxSizing:'border-box' as const, outline:'none' }} />
          <button onClick={update} disabled={pass.length < 8} style={{ width:'100%', padding:'12px', background:'#2D3278', color:'#fff', border:'none', borderRadius:10, fontSize:14, cursor:'pointer', fontWeight:700 }}>Update Password</button>
        </>
      )}
    </div></div>
  )
}
