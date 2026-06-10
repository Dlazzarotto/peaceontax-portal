'use client'
import { useState, useEffect } from 'react'

export default function InvitationsPage() {
  const [invites, setInvites] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ name: '', email: '', phone: '', type: 'business', lang: 'en', assignee: 'Staff', note: '' })
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  useEffect(() => {
    fetch('/api/send-invite').then(r => r.json()).then(d => { setInvites(d.invitations || []); setLoading(false) })
  }, [])

  const send = async () => {
    setSending(true)
    await fetch('/api/send-invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientName: form.name, clientEmail: form.email, clientPhone: form.phone, clientType: form.type, language: form.lang, assignee: form.assignee, customNote: form.note, channels: ['email'], createdBy: 'Staff' }),
    })
    setSent(true)
    setSending(false)
    fetch('/api/send-invite').then(r => r.json()).then(d => setInvites(d.invitations || []))
  }

  const inp: React.CSSProperties = { width: '100%', padding: '9px 12px', border: '1.5px solid #e2e8f4', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', outline: 'none', marginBottom: 10 }

  return (
    <div>
      <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: '#0f2340', marginBottom: 20 }}>Client Invitations</h1>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <div style={{ background: '#fff', borderRadius: 14, padding: 20, border: '1px solid #e2e8f4' }}>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 16, color: '#0f2340', marginBottom: 16 }}>Send New Invitation</h2>
          {sent ? (
            <div style={{ color: '#1a6b4a', padding: '12px', background: '#e8f5ee', borderRadius: 8 }}>
              ✓ Invitation sent! <button onClick={() => setSent(false)} style={{ background: 'none', border: 'none', color: '#1a6b4a', cursor: 'pointer', textDecoration: 'underline' }}>Send another</button>
            </div>
          ) : (
            <>
              <input placeholder="Client name" value={form.name} onChange={e => setForm({...form, name: e.target.value})} style={inp} />
              <input placeholder="Email address" type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} style={inp} />
              <input placeholder="Phone (optional)" value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} style={inp} />
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                {['business', 'individual'].map(t => (
                  <button key={t} onClick={() => setForm({...form, type: t})} style={{ flex: 1, padding: '8px', borderRadius: 8, border: form.type === t ? '2px solid #0f2340' : '1px solid #e2e8f4', background: form.type === t ? '#0f2340' : '#fff', color: form.type === t ? '#fff' : '#6a7a9a', cursor: 'pointer', fontSize: 13, textTransform: 'capitalize' }}>
                    {t === 'business' ? '🏢' : '👤'} {t}
                  </button>
                ))}
              </div>
              <textarea placeholder="Personal note (optional)" value={form.note} onChange={e => setForm({...form, note: e.target.value})} rows={3} style={{ ...inp, resize: 'vertical', marginBottom: 14 }} />
              <button onClick={send} disabled={!form.name || !form.email || sending} style={{ width: '100%', padding: '12px', background: '#0f2340', color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, cursor: 'pointer', fontFamily: 'Georgia,serif', fontWeight: 700 }}>
                {sending ? 'Sending…' : '📤 Send Invitation'}
              </button>
            </>
          )}
        </div>
        <div style={{ background: '#fff', borderRadius: 14, padding: 20, border: '1px solid #e2e8f4' }}>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 16, color: '#0f2340', marginBottom: 16 }}>Recent Invitations</h2>
          {loading ? <p style={{ color: '#6a7a9a' }}>Loading…</p> : invites.length === 0 ? <p style={{ color: '#9aaab0' }}>No invitations yet.</p> : invites.slice(0, 8).map((inv: any) => (
            <div key={inv.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f0f4fa' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a' }}>{inv.client_name}</div>
                <div style={{ fontSize: 11, color: '#6a7a9a' }}>{inv.client_email}</div>
              </div>
              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, background: inv.status === 'registered' ? '#e8f5ee' : inv.status === 'sent' ? '#e8f0ff' : '#f0f4fa', color: inv.status === 'registered' ? '#1a6b4a' : inv.status === 'sent' ? '#1a3560' : '#6a7a9a', fontWeight: 700 }}>
                {inv.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
