'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'

export default function StaffSetupPage() {
  const { token } = useParams()
  const router    = useRouter()
  const [invite,  setInvite]  = useState<any>(null)
  const [status,  setStatus]  = useState<'loading'|'form'|'error'|'done'>('loading')
  const [pass,    setPass]    = useState('')
  const [confirm, setConfirm] = useState('')
  const [error,   setError]   = useState('')
  const [saving,  setSaving]  = useState(false)

  useEffect(() => {
    fetch(`/api/firm/setup/${token}`)
      .then(r => r.json())
      .then(d => { if (d.error) setStatus('error'); else { setInvite(d); setStatus('form') } })
  }, [token])

  const setup = async () => {
    if (pass.length < 8) { setError('Password must be at least 8 characters'); return }
    if (pass !== confirm) { setError('Passwords do not match'); return }
    setSaving(true); setError('')
    const res = await fetch(`/api/firm/setup/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass }),
    })
    const d = await res.json()
    setSaving(false)
    if (d.error) { setError(d.error); return }
    setStatus('done')
    setTimeout(() => router.push('/dashboard'), 2000)
  }

  const wrap = (children: React.ReactNode) => (
    <div style={{ minHeight:'100vh', background:'linear-gradient(135deg,#2D3278,#1a1f5e)', display:'flex', alignItems:'center', justifyContent:'center', padding:20, fontFamily:'Georgia,serif' }}>
      <div style={{ background:'#fff', borderRadius:20, width:'100%', maxWidth:420, boxShadow:'0 30px 80px rgba(0,0,0,0.4)', overflow:'hidden' }}>
        <div style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', padding:'24px 28px', textAlign:'center' }}>
          <img src="/logo.png" alt="Peace on Tax" style={{ height:36, width:'auto', marginBottom:6 }} />
          <div style={{ fontSize:12, color:'rgba(255,255,255,0.5)', marginTop:4 }}>Team Portal Setup</div>
        </div>
        <div style={{ padding:'28px 32px' }}>{children}</div>
      </div>
    </div>
  )

  if (status === 'loading') return wrap(<p style={{ textAlign:'center', color:'#6a7a9a' }}>Loading…</p>)
  if (status === 'error')   return wrap(
    <div style={{ textAlign:'center' }}>
      <div style={{ fontSize:40, marginBottom:12 }}>⚠️</div>
      <p style={{ color:'#b02020', fontWeight:700 }}>Invalid or expired invitation.</p>
      <p style={{ color:'#6a7a9a', fontSize:13 }}>Please contact your administrator.</p>
    </div>
  )
  if (status === 'done') return wrap(
    <div style={{ textAlign:'center' }}>
      <div style={{ fontSize:52, marginBottom:12 }}>🎉</div>
      <h2 style={{ fontFamily:'Georgia,serif', fontSize:20, color:'#1a6b4a' }}>Account Ready!</h2>
      <p style={{ color:'#6a7a9a' }}>Redirecting to dashboard…</p>
    </div>
  )

  const ROLE_LABELS: Record<string,string> = { firm:'Owner', admin:'Admin', manager:'Manager', staff:'Staff' }

  return wrap(
    <div>
      <h2 style={{ fontFamily:'Georgia,serif', fontSize:20, color:'#0f2340', marginBottom:4 }}>Welcome, {invite?.name}!</h2>
      <p style={{ color:'#6a7a9a', fontSize:13, marginBottom:20 }}>Create your password to access the Peace on Tax portal.</p>

      <div style={{ background:'#f0f4fa', borderRadius:10, padding:'12px 16px', marginBottom:20 }}>
        <div style={{ fontSize:12, color:'#6a7a9a', marginBottom:3 }}>Your account</div>
        <div style={{ fontWeight:700, color:'#0f2340' }}>{invite?.email}</div>
        <div style={{ fontSize:12, color:'#2D3278', marginTop:2, fontWeight:700 }}>
          {ROLE_LABELS[invite?.role] || 'Staff'} Access
        </div>
      </div>

      <div style={{ marginBottom:14 }}>
        <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:5 }}>Password *</label>
        <input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="Min 8 characters"
          style={{ width:'100%', padding:'11px 13px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, boxSizing:'border-box' as const, outline:'none' }} />
      </div>

      <div style={{ marginBottom:20 }}>
        <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:5 }}>Confirm Password *</label>
        <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Repeat password"
          onKeyDown={e => e.key === 'Enter' && setup()}
          style={{ width:'100%', padding:'11px 13px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, boxSizing:'border-box' as const, outline:'none' }} />
      </div>

      {error && <div style={{ background:'#fdf0f0', color:'#b02020', padding:'9px 13px', borderRadius:8, fontSize:13, marginBottom:14 }}>{error}</div>}

      <button onClick={setup} disabled={!pass || !confirm || saving} style={{ width:'100%', padding:'13px', background:(!pass||!confirm||saving)?'#e2e8f4':'linear-gradient(135deg,#2D3278,#1a1f5e)', color:(!pass||!confirm||saving)?'#9aaab0':'#fff', border:'none', borderRadius:10, fontSize:15, fontWeight:700, cursor:(!pass||!confirm||saving)?'not-allowed':'pointer', fontFamily:'Georgia,serif' }}>
        {saving ? 'Setting up…' : 'Create My Account →'}
      </button>

      <p style={{ textAlign:'center', fontSize:11, color:'#9aaab0', marginTop:14 }}>🔒 Secure & encrypted · Peace on Tax</p>
    </div>
  )
}
