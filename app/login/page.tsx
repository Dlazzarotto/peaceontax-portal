'use client'
import { useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase-browser'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [role,    setRole]    = useState<'firm'|'client'|null>(null)
  const [email,   setEmail]   = useState('')
  const [pass,    setPass]    = useState('')
  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)

  const login = async () => {
    if (!role || !email || !pass) return
    setLoading(true); setError('')
    const sb = supabaseBrowser()
    const { data, error: e } = await sb.auth.signInWithPassword({ email, password: pass })
    if (e) { setError(e.message); setLoading(false); return }
    const userRole = data.user?.user_metadata?.role || role
    router.push(userRole === 'firm' ? '/dashboard' : '/portal')
  }

  const canSubmit = role && email && pass && !loading

  return (
    <div style={{ minHeight:'100vh', background:'linear-gradient(135deg,#2D3278,#1a1f5e)', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Georgia,serif' }}>
      <div style={{ background:'#fff', borderRadius:20, padding:'40px 38px', width:390, boxShadow:'0 30px 80px rgba(0,0,0,0.4)' }}>

        {/* Logo — centralizado */}
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', marginBottom:28 }}>
          <img src="/logo.png" alt="Peace on Tax" style={{ width:220, height:'auto', marginBottom:8, display:'block' }} />
          <p style={{ color:'#6a7a9a', fontSize:12, margin:0, textAlign:'center' }}>Client Portal · Massachusetts</p>
        </div>

        {/* Role selector */}
        <div style={{ display:'flex', gap:8, marginBottom:20 }}>
          {(['firm','client'] as const).map(r => (
            <button key={r} onClick={() => setRole(r)} style={{ flex:1, padding:'10px', borderRadius:9, cursor:'pointer', border:role===r?'2px solid #2D3278':'1.5px solid #e2e8f4', background:role===r?'#2D3278':'#fff', color:role===r?'#fff':'#6a7a9a', fontSize:13, fontWeight:700 }}>
              {r==='firm'?'🏛 Firm / Staff':'👤 Client'}
            </button>
          ))}
        </div>

        <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
          style={{ width:'100%', padding:'11px 13px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, marginBottom:12, boxSizing:'border-box' as const, outline:'none' }} />
        <input type="password" placeholder="Password" value={pass} onChange={e => setPass(e.target.value)}
          onKeyDown={e => e.key==='Enter' && canSubmit && login()}
          style={{ width:'100%', padding:'11px 13px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, marginBottom:6, boxSizing:'border-box' as const, outline:'none' }} />

        <div style={{ textAlign:'right', marginBottom:16 }}>
          <a href="/reset-password" style={{ fontSize:12, color:'#6a7a9a' }}>Forgot password?</a>
        </div>

        {error && <div style={{ background:'#fdf0f0', color:'#b02020', padding:'9px 13px', borderRadius:8, fontSize:13, marginBottom:12 }}>{error}</div>}

        <button onClick={login} disabled={!canSubmit} style={{ width:'100%', padding:'13px', background:canSubmit?'linear-gradient(135deg,#2D3278,#1a1f5e)':'#e2e8f4', color:canSubmit?'#fff':'#9aaab0', border:'none', borderRadius:11, fontSize:15, fontWeight:700, cursor:canSubmit?'pointer':'not-allowed' }}>
          {loading?'Signing in…':role?'Sign In →':'Select a role above'}
        </button>

        <div style={{ textAlign:'center', marginTop:16, fontSize:11, color:'#9aaab0' }}>
          🔒 Secure & encrypted · peaceontax.com
        </div>
      </div>
    </div>
  )
}
