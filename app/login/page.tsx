'use client'
import { useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [role, setRole] = useState<'firm'|'client'|null>(null)
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const login = async () => {
    if (!role || !email || !pass) return
    setLoading(true)
    setError('')
    const sb = supabaseBrowser()
    const { data, error: e } = await sb.auth.signInWithPassword({ email, password: pass })
    if (e) { setError(e.message); setLoading(false); return }
    const userRole = data.user?.user_metadata?.role || role
    router.push(userRole === 'firm' ? '/dashboard' : '/portal')
  }

  const s: React.CSSProperties = {
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #0f2340, #243f72)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  }
  const card: React.CSSProperties = {
    background: '#fff', borderRadius: 20, padding: '40px 36px',
    width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
  }
  const inp: React.CSSProperties = {
    width: '100%', padding: '11px 13px', border: '1.5px solid #e2e8f4',
    borderRadius: 9, fontSize: 14, marginBottom: 12,
    boxSizing: 'border-box', outline: 'none', fontFamily: 'Georgia, serif',
  }

  return (
    <div style={s}>
      <div style={card}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>📒</div>
          <h1 style={{ fontFamily: 'Georgia, serif', fontSize: 22, color: '#0f2340', margin: 0 }}>Peace on Tax</h1>
          <p style={{ color: '#6a7a9a', fontSize: 13, marginTop: 4 }}>Client Portal · Massachusetts</p>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {(['firm', 'client'] as const).map(r => (
            <button key={r} onClick={() => setRole(r)} style={{
              flex: 1, padding: '9px', borderRadius: 9, cursor: 'pointer',
              border: role === r ? '2px solid #0f2340' : '1.5px solid #e2e8f4',
              background: role === r ? '#0f2340' : '#fff',
              color: role === r ? '#fff' : '#6a7a9a',
              fontFamily: 'Georgia, serif', fontSize: 13, fontWeight: role === r ? 700 : 400,
            }}>
              {r === 'firm' ? '🏛 Firm / Staff' : '👤 Client'}
            </button>
          ))}
        </div>

        <input type="email" placeholder="Email" value={email}
          onChange={e => setEmail(e.target.value)} style={inp} />
        <input type="password" placeholder="Password" value={pass}
          onChange={e => setPass(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && login()} style={{ ...inp, marginBottom: 6 }} />

        <div style={{ textAlign: 'right', marginBottom: 16 }}>
          <a href="/reset-password" style={{ fontSize: 12, color: '#6a7a9a' }}>Forgot password?</a>
        </div>

        {error && <div style={{ background: '#fdf0f0', color: '#b02020', padding: '9px 13px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{error}</div>}

        <button onClick={login} disabled={!role || !email || !pass || loading} style={{
          width: '100%', padding: '13px',
          background: (role && email && pass && !loading) ? 'linear-gradient(135deg,#0f2340,#243f72)' : '#e2e8f4',
          color: (role && email && pass && !loading) ? '#fff' : '#9aaab0',
          border: 'none', borderRadius: 11, fontSize: 15,
          fontFamily: 'Georgia, serif', fontWeight: 700, cursor: 'pointer',
        }}>
          {loading ? 'Signing in…' : role ? 'Sign In →' : 'Select a role above'}
        </button>
      </div>
    </div>
  )
}
