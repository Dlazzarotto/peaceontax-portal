'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase'

export default function InvitePage() {
  const { token } = useParams()
  const router = useRouter()
  const [invite, setInvite] = useState<any>(null)
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [status, setStatus] = useState<'loading'|'valid'|'error'|'done'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(`/api/invite/${token}`)
      .then(r => r.json())
      .then(d => { if (d.error) setStatus('error'); else { setInvite(d); setStatus('valid') } })
  }, [token])

  const register = async () => {
    if (pass !== confirm) { setError('Passwords do not match'); return }
    const res = await fetch(`/api/invite/${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass }),
    })
    const d = await res.json()
    if (d.error) { setError(d.error); return }
    setStatus('done')
    setTimeout(() => router.push('/portal'), 2000)
  }

  const s: React.CSSProperties = { minHeight: '100vh', background: 'linear-gradient(135deg,#0f2340,#243f72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }
  const card: React.CSSProperties = { background: '#fff', borderRadius: 20, padding: '40px 36px', width: '100%', maxWidth: 400, boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }

  return (
    <div style={s}><div style={card}>
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>📒</div>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 20, color: '#0f2340' }}>Peace on Tax Portal</h1>
      </div>
      {status === 'loading' && <p style={{ color: '#6a7a9a', textAlign: 'center' }}>Validating invitation…</p>}
      {status === 'error' && <p style={{ color: '#b02020', textAlign: 'center' }}>Invalid or expired invitation.</p>}
      {status === 'done' && <p style={{ color: '#1a6b4a', textAlign: 'center' }}>Account created! Redirecting…</p>}
      {status === 'valid' && invite && (
        <>
          <div style={{ background: '#f0f4fa', borderRadius: 10, padding: '12px 14px', marginBottom: 20 }}>
            <div style={{ fontWeight: 700, color: '#0f2340' }}>{invite.clientName}</div>
            <div style={{ fontSize: 12, color: '#6a7a9a', marginTop: 2 }}>{invite.clientType === 'business' ? '🏢 Business' : '👤 Individual'}</div>
          </div>
          {['New password', 'Confirm password'].map((ph, i) => (
            <input key={i} type="password" placeholder={ph} value={i === 0 ? pass : confirm}
              onChange={e => i === 0 ? setPass(e.target.value) : setConfirm(e.target.value)}
              style={{ width: '100%', padding: '11px 13px', border: '1.5px solid #e2e8f4', borderRadius: 9, fontSize: 14, marginBottom: 12, boxSizing: 'border-box' as const, outline: 'none' }} />
          ))}
          {error && <div style={{ color: '#b02020', fontSize: 13, marginBottom: 10 }}>{error}</div>}
          <button onClick={register} disabled={!pass || !confirm}
            style={{ width: '100%', padding: '12px', background: '#0f2340', color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, cursor: 'pointer' }}>
            Create My Account →
          </button>
        </>
      )}
    </div></div>
  )
}
