'use client'
import { useState, useEffect } from 'react'

const LANGS = [
  { code: 'en', flag: '🇺🇸', label: 'EN' },
  { code: 'pt', flag: '🇧🇷', label: 'PT' },
  { code: 'es', flag: '🇪🇸', label: 'ES' },
  { code: 'zh', flag: '🇨🇳', label: 'ZH' },
]

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  registered: { bg: '#e8f5ee', color: '#1a6b4a' },
  sent:       { bg: '#e8f0ff', color: '#1a3560' },
  opened:     { bg: '#fff4e8', color: '#c06010' },
  expired:    { bg: '#fdf0f0', color: '#b02020' },
  pending:    { bg: '#f0f4fa', color: '#6a7a9a' },
}

export default function InvitationsPage() {
  const [invites,  setInvites]  = useState<any[]>([])
  const [loading,  setLoading]  = useState(true)
  const [form,     setForm]     = useState({ name: '', email: '', phone: '', type: 'individual', lang: 'en', assignee: '', note: '' })
  const [sending,  setSending]  = useState(false)
  const [result,   setResult]   = useState<{ success: boolean; message: string; inviteUrl?: string } | null>(null)
  const [resending, setResending] = useState<string | null>(null)
  const [copied,   setCopied]   = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    fetch('/api/send-invite')
      .then(r => r.json())
      .then(d => { setInvites(d.invitations || []); setLoading(false) })
  }

  useEffect(() => { load() }, [])

  const send = async () => {
    if (!form.name || !form.email) return
    setSending(true)
    setResult(null)
    const res = await fetch('/api/send-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName:  form.name,
        clientEmail: form.email,
        clientPhone: form.phone,
        clientType:  form.type,
        language:    form.lang,
        assignee:    form.assignee || 'Staff',
        customNote:  form.note,
        channels:    ['email'],
        createdBy:   'Staff',
      }),
    })
    const d = await res.json()
    setSending(false)
    if (d.error) {
      setResult({ success: false, message: d.error })
    } else {
      setResult({
        success:   true,
        message:   d.emailSent ? `Email sent to ${form.email}!` : `Invitation created. Copy the link below to send manually.`,
        inviteUrl: d.inviteUrl,
      })
      setForm({ name: '', email: '', phone: '', type: 'individual', lang: 'en', assignee: '', note: '' })
      load()
    }
  }

  const resend = async (inv: any) => {
    setResending(inv.id)
    const res = await fetch('/api/send-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName:  inv.client_name,
        clientEmail: inv.client_email,
        clientPhone: inv.client_phone,
        clientType:  inv.client_type,
        language:    inv.language || 'en',
        assignee:    inv.assignee || 'Staff',
        customNote:  inv.message_note,
        channels:    ['email'],
        createdBy:   'Staff',
      }),
    })
    const d = await res.json()
    setResending(null)
    if (d.error) alert(`Error: ${d.error}`)
    else { alert(d.emailSent ? `Email resent to ${inv.client_email}!` : 'Invitation created. Copy the link to send manually.'); load() }
  }

  const copyLink = (url: string, id: string) => {
    navigator.clipboard?.writeText(url).catch(() => {})
    setCopied(id)
    setTimeout(() => setCopied(null), 2500)
  }

  const inp: React.CSSProperties = { width: '100%', padding: '9px 12px', border: '1.5px solid #e2e8f4', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', outline: 'none', marginBottom: 10, fontFamily: 'Georgia,serif' }

  return (
    <div>
      <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: '#0f2340', marginBottom: 20 }}>Client Invitations</h1>

      <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr', gap: 24 }}>

        {/* ── Send form ── */}
        <div style={{ background: '#fff', borderRadius: 14, padding: 22, border: '1px solid #e2e8f4' }}>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 16, color: '#0f2340', marginBottom: 16 }}>Send New Invitation</h2>

          <input placeholder="Client full name *" value={form.name} onChange={e => setForm({...form, name: e.target.value})} style={inp} />
          <input placeholder="Email address *" type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} style={inp} />
          <input placeholder="Phone (optional)" value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} style={inp} />
          <input placeholder="Assigned to (e.g. David L.)" value={form.assignee} onChange={e => setForm({...form, assignee: e.target.value})} style={inp} />

          {/* Type */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            {[['individual','👤 Individual'],['business','🏢 Business']].map(([v,l]) => (
              <button key={v} onClick={() => setForm({...form, type: v})} style={{ flex: 1, padding: '8px', borderRadius: 8, border: form.type===v?'2px solid #2D3278':'1px solid #e2e8f4', background: form.type===v?'#2D3278':'#fff', color: form.type===v?'#fff':'#6a7a9a', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                {l}
              </button>
            ))}
          </div>

          {/* Language */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {LANGS.map(l => (
              <button key={l.code} onClick={() => setForm({...form, lang: l.code})} style={{ flex: 1, padding: '7px 4px', borderRadius: 8, border: form.lang===l.code?'2px solid #2D3278':'1px solid #e2e8f4', background: form.lang===l.code?'#2D327810':'#fff', color: form.lang===l.code?'#2D3278':'#6a7a9a', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                {l.flag} {l.label}
              </button>
            ))}
          </div>

          <textarea placeholder="Personal note (optional)" value={form.note} onChange={e => setForm({...form, note: e.target.value})} rows={2} style={{ ...inp, resize: 'vertical', marginBottom: 14 }} />

          {/* Result message */}
          {result && (
            <div style={{ background: result.success ? '#e8f5ee' : '#fdf0f0', border: `1px solid ${result.success?'#b0d8b0':'#e0a0a0'}`, color: result.success?'#1a6b4a':'#b02020', padding: '10px 14px', borderRadius: 9, fontSize: 13, marginBottom: 12 }}>
              {result.success ? '✓' : '✗'} {result.message}
              {result.inviteUrl && (
                <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#1a3560', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{result.inviteUrl}</span>
                  <button onClick={() => copyLink(result.inviteUrl!, 'new')} style={{ background: copied==='new'?'#1a6b4a':'#2D3278', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', flexShrink: 0, fontWeight: 700 }}>
                    {copied==='new' ? '✓ Copied' : '📋 Copy'}
                  </button>
                </div>
              )}
            </div>
          )}

          <button onClick={send} disabled={!form.name || !form.email || sending} style={{ width: '100%', padding: '12px', background: (!form.name||!form.email||sending)?'#e2e8f4':'linear-gradient(135deg,#2D3278,#1a1f5e)', color: (!form.name||!form.email||sending)?'#9aaab0':'#fff', border: 'none', borderRadius: 10, fontSize: 14, cursor: (!form.name||!form.email||sending)?'not-allowed':'pointer', fontFamily: 'Georgia,serif', fontWeight: 700 }}>
            {sending ? 'Sending…' : '📤 Send Invitation'}
          </button>
        </div>

        {/* ── Invitations list ── */}
        <div style={{ background: '#fff', borderRadius: 14, padding: 22, border: '1px solid #e2e8f4' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 16, color: '#0f2340', margin: 0 }}>All Invitations</h2>
            <span style={{ fontSize: 12, color: '#6a7a9a' }}>{invites.length} total</span>
          </div>

          {loading ? (
            <p style={{ color: '#6a7a9a', fontSize: 13 }}>Loading…</p>
          ) : invites.length === 0 ? (
            <p style={{ color: '#9aaab0', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>No invitations yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {invites.map((inv: any) => {
                const s = STATUS_STYLE[inv.status] || STATUS_STYLE.pending
                const inviteUrl = `${window.location.origin}/invite/${inv.token}`
                const isExpired = inv.status === 'expired' || new Date(inv.expires_at) < new Date()
                return (
                  <div key={inv.id} style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid #e2e8f4', background: '#fafbff' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: '#1a2a3a' }}>{inv.client_name}</div>
                        <div style={{ fontSize: 11, color: '#6a7a9a' }}>{inv.client_email}</div>
                      </div>
                      <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 20, fontWeight: 700, background: s.bg, color: s.color, flexShrink: 0 }}>
                        {inv.status}
                      </span>
                      <span style={{ fontSize: 10, color: '#9aaab0', flexShrink: 0 }}>
                        {inv.sent_at ? new Date(inv.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                      </span>
                    </div>
                    {/* Actions */}
                    {inv.status !== 'registered' && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        {/* Copy link */}
                        <button
                          onClick={() => copyLink(inviteUrl, inv.id)}
                          style={{ fontSize: 11, padding: '4px 10px', borderRadius: 7, border: '1px solid #e2e8f4', background: copied===inv.id?'#e8f5ee':'#f0f4fa', color: copied===inv.id?'#1a6b4a':'#0f2340', cursor: 'pointer', fontWeight: 700 }}
                        >
                          {copied===inv.id ? '✓ Copied' : '🔗 Copy Link'}
                        </button>
                        {/* Resend email */}
                        <button
                          onClick={() => resend(inv)}
                          disabled={resending === inv.id}
                          style={{ fontSize: 11, padding: '4px 10px', borderRadius: 7, border: '1px solid #e2e8f4', background: '#f0f4fa', color: '#2D3278', cursor: resending===inv.id?'not-allowed':'pointer', fontWeight: 700, opacity: resending===inv.id?0.6:1 }}
                        >
                          {resending===inv.id ? 'Sending…' : isExpired ? '↻ New Invite' : '↻ Resend Email'}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
