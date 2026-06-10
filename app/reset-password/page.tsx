'use client'
import { useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase-browser'

export default function ResetPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)

  const send = async () => {
    setLoading(true)
    const sb = supabaseBrowser()
    await sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?type=recovery`,
    })
    setSent(true)
    setLoading(false)
  }

  const s: React.CSSProperties = { minHeight: '100vh', background: 'linear-gradient(135deg,#0f2340,#243f72)', display: 'flex', alignItems: 'center', justifyContent: 'center' }
  const card: React.CSSProperties = { background: '#fff', borderRadius: 20, padding: '40px 36px', width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }

  return (
    <div style={s}>
      <div style={card}>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 20, color: '#0f2340', marginBottom: 16 }}>🔑 Reset Password</h1>
        {sent ? (
          <p style={{ color: '#1a6b4a' }}>Check your email for a reset link.</p>
        ) : (
          <>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Your email"
              style={{ width: '100%', padding: '11px 13px', border: '1.5px solid #e2e8f4', borderRadius: 9, fontSize: 14, marginBottom: 14, boxSizing: 'border-box' as const, outline: 'none' }} />
            <button onClick={send} disabled={!email || loading}
              style={{ width: '100%', padding: '12px', background: '#0f2340', color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, cursor: 'pointer' }}>
              {loading ? 'Sending…' : 'Send Reset Link'}
            </button>
          </>
        )}
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          <a href="/login" style={{ fontSize: 12, color: '#6a7a9a' }}>← Back to login</a>
        </div>
      </div>
    </div>
  )
}
