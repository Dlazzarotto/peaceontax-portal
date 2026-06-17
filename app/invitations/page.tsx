'use client'
import { useState, useEffect, useRef } from 'react'

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  registered: { bg: '#e8f5ee', color: '#1a6b4a' },
  sent:       { bg: '#e8f0ff', color: '#1a3560' },
  opened:     { bg: '#fff4e8', color: '#c06010' },
  expired:    { bg: '#fdf0f0', color: '#b02020' },
  pending:    { bg: '#f0f4fa', color: '#6a7a9a' },
}

interface InviteRow { email: string; note?: string; valid: boolean; error?: string }

export default function InvitationsPage() {
  const [invites,   setInvites]   = useState<any[]>([])
  const [loading,   setLoading]   = useState(true)
  const [tab,       setTab]       = useState<'single'|'bulk'>('single')
  const [email,     setEmail]     = useState('')
  const [note,      setNote]      = useState('')
  const [sending,   setSending]   = useState(false)
  const [result,    setResult]    = useState<{ success: boolean; message: string; inviteUrl?: string } | null>(null)
  const [resending, setResending] = useState<string | null>(null)
  const [copied,    setCopied]    = useState<string | null>(null)
  // Bulk
  const [csvRows,   setCsvRows]   = useState<InviteRow[]>([])
  const [bulkNote,  setBulkNote]  = useState('')
  const [bulkSending, setBulkSending] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<{ sent: number; total: number; errors: string[] } | null>(null)
  const [bulkDone,  setBulkDone]  = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = () => {
    setLoading(true)
    fetch('/api/send-invite').then(r => r.json()).then(d => { setInvites(d.invitations || []); setLoading(false) })
  }
  useEffect(() => { load() }, [])

  const sendOne = async () => {
    if (!email) return
    setSending(true); setResult(null)
    const res = await fetch('/api/send-invite', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ clientName:email.split('@')[0], clientEmail:email, clientType:'individual', language:'en', assignee:'Staff', customNote:note, channels:['email'], createdBy:'Staff', selfOnboard:true }) })
    const d = await res.json()
    setSending(false)
    if (d.error) { setResult({ success:false, message:d.error }) }
    else { setResult({ success:true, message:d.emailSent ? `Invitation sent to ${email}!` : 'Created. Copy the link to send manually.', inviteUrl:d.inviteUrl }); setEmail(''); setNote(''); load() }
  }

  const resend = async (inv: any) => {
    setResending(inv.id)
    const res = await fetch('/api/send-invite', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ clientName:inv.client_name, clientEmail:inv.client_email, clientType:inv.client_type, language:inv.language||'en', assignee:inv.assignee||'Staff', customNote:inv.message_note, channels:['email'], createdBy:'Staff', selfOnboard:true }) })
    const d = await res.json()
    setResending(null)
    if (d.error) alert(d.error)
    else { alert(d.emailSent ? `Resent to ${inv.client_email}!` : 'Created. Copy the link.'); load() }
  }

  const copyLink = (url: string, id: string) => {
    navigator.clipboard?.writeText(url).catch(() => {})
    setCopied(id); setTimeout(() => setCopied(null), 2500)
  }

  // CSV parsing
  const parseCSV = (text: string): InviteRow[] => {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    // Skip header if first line looks like a header
    const start = lines[0]?.toLowerCase().includes('email') ? 1 : 0
    return lines.slice(start).map(line => {
      const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''))
      const email = cols[0] || ''
      const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      return { email, note: cols[1] || '', valid, error: !valid ? 'Invalid email' : undefined }
    }).filter(r => r.email)
  }

  const handleCSVFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = e => {
      const text = e.target?.result as string
      setCsvRows(parseCSV(text))
      setBulkDone(false)
      setBulkProgress(null)
    }
    reader.readAsText(file)
  }

  const handleCSVPaste = (text: string) => {
    setCsvRows(parseCSV(text))
    setBulkDone(false)
    setBulkProgress(null)
  }

  const sendBulk = async () => {
    const validRows = csvRows.filter(r => r.valid)
    if (!validRows.length) return
    setBulkSending(true)
    setBulkProgress({ sent:0, total:validRows.length, errors:[] })
    setBulkDone(false)
    let sent = 0
    const errors: string[] = []
    for (const row of validRows) {
      try {
        const res = await fetch('/api/send-invite', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ clientName:row.email.split('@')[0], clientEmail:row.email, clientType:'individual', language:'en', assignee:'Staff', customNote:row.note || bulkNote, channels:['email'], createdBy:'Staff', selfOnboard:true }) })
        const d = await res.json()
        if (d.error) errors.push(`${row.email}: ${d.error}`)
        else sent++
      } catch (err: any) {
        errors.push(`${row.email}: ${err.message}`)
      }
      setBulkProgress({ sent: sent + errors.length, total: validRows.length, errors: [...errors] })
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 300))
    }
    setBulkSending(false)
    setBulkDone(true)
    setBulkProgress({ sent, total: validRows.length, errors })
    load()
  }

  const downloadTemplate = () => {
    const csv = 'email,note\nclient@example.com,Hi! We are ready to start on your return.\nanother@example.com,'
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = 'peaceontax-invite-template.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const validCount   = csvRows.filter(r => r.valid).length
  const invalidCount = csvRows.filter(r => !r.valid).length

  return (
    <div>
      <h1 style={{ fontFamily:'Georgia,serif', fontSize:22, color:'#0f2340', marginBottom:6 }}>Client Invitations</h1>
      <p style={{ color:'#6a7a9a', fontSize:13, marginBottom:20 }}>Client receives the invite email and fills in their own information when registering.</p>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>

        {/* Left panel */}
        <div>
          {/* Tab selector */}
          <div style={{ display:'flex', gap:0, marginBottom:16, background:'#e2e8f4', borderRadius:10, padding:3 }}>
            {[['single','✉️ Single Invite'],['bulk','📋 Bulk Import (CSV)']].map(([v,l]) => (
              <button key={v} onClick={() => setTab(v as any)} style={{ flex:1, padding:'9px 12px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, background:tab===v?'#fff':'transparent', color:tab===v?'#2D3278':'#6a7a9a', boxShadow:tab===v?'0 1px 4px rgba(0,0,0,0.1)':'none', transition:'all 0.15s' }}>
                {l}
              </button>
            ))}
          </div>

          {/* Single invite */}
          {tab === 'single' && (
            <div style={{ background:'#fff', borderRadius:14, padding:22, border:'1px solid #e2e8f4' }}>
              <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:5 }}>Client Email *</label>
              <input type="email" placeholder="client@example.com" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key==='Enter' && sendOne()}
                style={{ width:'100%', padding:'11px 13px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, boxSizing:'border-box' as const, outline:'none', marginBottom:14, fontFamily:'Georgia,serif' }} />

              <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:5 }}>Personal Note (optional)</label>
              <textarea placeholder="e.g. Hi! We are ready to start on your 2024 return." value={note} onChange={e => setNote(e.target.value)} rows={2}
                style={{ width:'100%', padding:'10px 13px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:13, boxSizing:'border-box' as const, outline:'none', resize:'vertical' as const, marginBottom:14, fontFamily:'Georgia,serif' }} />

              <div style={{ background:'#f0f4fa', borderRadius:10, padding:'10px 14px', marginBottom:16, fontSize:12, color:'#4a5a6a' }}>
                <strong style={{ color:'#0f2340' }}>Client fills in:</strong> name · phone · type · address · password
              </div>

              {result && (
                <div style={{ background:result.success?'#e8f5ee':'#fdf0f0', border:`1px solid ${result.success?'#b0d8b0':'#e0a0a0'}`, color:result.success?'#1a6b4a':'#b02020', padding:'10px 14px', borderRadius:9, fontSize:13, marginBottom:12 }}>
                  {result.success?'✓':'✗'} {result.message}
                  {result.inviteUrl && (
                    <div style={{ marginTop:8, display:'flex', gap:8, alignItems:'center' }}>
                      <span style={{ fontFamily:'monospace', fontSize:11, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }}>{result.inviteUrl}</span>
                      <button onClick={() => copyLink(result.inviteUrl!, 'new')} style={{ background:copied==='new'?'#1a6b4a':'#2D3278', color:'#fff', border:'none', padding:'4px 10px', borderRadius:6, fontSize:11, cursor:'pointer', flexShrink:0, fontWeight:700 }}>
                        {copied==='new'?'✓ Copied':'📋 Copy'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              <button onClick={sendOne} disabled={!email||sending} style={{ width:'100%', padding:'13px', background:(!email||sending)?'#e2e8f4':'linear-gradient(135deg,#2D3278,#1a1f5e)', color:(!email||sending)?'#9aaab0':'#fff', border:'none', borderRadius:10, fontSize:15, cursor:(!email||sending)?'not-allowed':'pointer', fontFamily:'Georgia,serif', fontWeight:700 }}>
                {sending?'Sending…':'📤 Send Invitation'}
              </button>
            </div>
          )}

          {/* Bulk CSV */}
          {tab === 'bulk' && (
            <div style={{ background:'#fff', borderRadius:14, padding:22, border:'1px solid #e2e8f4' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
                <div>
                  <div style={{ fontFamily:'Georgia,serif', fontSize:15, color:'#0f2340', fontWeight:700 }}>Import CSV</div>
                  <div style={{ fontSize:12, color:'#6a7a9a', marginTop:2 }}>Upload a CSV file or paste emails below</div>
                </div>
                <button onClick={downloadTemplate} style={{ fontSize:12, padding:'6px 12px', borderRadius:8, border:'1px solid #e2e8f4', background:'#f0f4fa', color:'#2D3278', cursor:'pointer', fontWeight:700 }}>
                  ⬇ Download Template
                </button>
              </div>

              {/* Drop zone */}
              <div
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleCSVFile(f) }}
                onClick={() => fileRef.current?.click()}
                style={{ border:'2px dashed #e2e8f4', borderRadius:10, padding:'20px', textAlign:'center', cursor:'pointer', background:'#fafbff', marginBottom:14 }}
              >
                <input ref={fileRef} type="file" accept=".csv,.txt" onChange={e => { const f = e.target.files?.[0]; if (f) handleCSVFile(f) }} style={{ display:'none' }} />
                <div style={{ fontSize:28, marginBottom:6 }}>📂</div>
                <div style={{ fontSize:13, color:'#6a7a9a' }}>Drop CSV file here or click to browse</div>
                <div style={{ fontSize:11, color:'#9aaab0', marginTop:3 }}>Columns: email, note (optional)</div>
              </div>

              <div style={{ textAlign:'center', color:'#9aaab0', fontSize:12, marginBottom:10 }}>— or paste emails below (one per line) —</div>

              <textarea
                placeholder={'client1@example.com\nclient2@example.com\nclient3@company.com'}
                rows={4}
                onChange={e => handleCSVPaste(e.target.value)}
                style={{ width:'100%', padding:'10px 13px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:13, boxSizing:'border-box' as const, outline:'none', resize:'vertical' as const, marginBottom:14, fontFamily:'monospace' }}
              />

              <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:5 }}>Default Note for All (optional)</label>
              <textarea placeholder="e.g. Hi! Peace on Tax has set up your secure client portal." value={bulkNote} onChange={e => setBulkNote(e.target.value)} rows={2}
                style={{ width:'100%', padding:'10px 13px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:13, boxSizing:'border-box' as const, outline:'none', resize:'vertical' as const, marginBottom:16, fontFamily:'Georgia,serif' }} />

              {/* Preview */}
              {csvRows.length > 0 && (
                <div style={{ background:'#f8faff', borderRadius:10, padding:'12px 14px', marginBottom:14, border:'1px solid #e2e8f4' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                    <span style={{ fontSize:13, fontWeight:700, color:'#0f2340' }}>Preview — {csvRows.length} emails</span>
                    <div style={{ display:'flex', gap:10, fontSize:12 }}>
                      <span style={{ color:'#1a6b4a', fontWeight:700 }}>✓ {validCount} valid</span>
                      {invalidCount > 0 && <span style={{ color:'#b02020', fontWeight:700 }}>✗ {invalidCount} invalid</span>}
                    </div>
                  </div>
                  <div style={{ maxHeight:140, overflowY:'auto', display:'flex', flexDirection:'column', gap:4 }}>
                    {csvRows.slice(0,20).map((row, i) => (
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:8, fontSize:12 }}>
                        <span style={{ color:row.valid?'#1a6b4a':'#b02020', fontSize:14 }}>{row.valid?'✓':'✗'}</span>
                        <span style={{ fontFamily:'monospace', color:row.valid?'#1a2a3a':'#b02020' }}>{row.email}</span>
                        {row.note && <span style={{ color:'#9aaab0', fontSize:11 }}>· {row.note}</span>}
                        {row.error && <span style={{ color:'#b02020', fontSize:11 }}>({row.error})</span>}
                      </div>
                    ))}
                    {csvRows.length > 20 && <div style={{ fontSize:11, color:'#9aaab0' }}>…and {csvRows.length-20} more</div>}
                  </div>
                </div>
              )}

              {/* Progress */}
              {bulkProgress && (
                <div style={{ marginBottom:14 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, marginBottom:6 }}>
                    <span style={{ color:'#0f2340', fontWeight:700 }}>{bulkDone ? 'Complete!' : 'Sending…'}</span>
                    <span style={{ color:'#6a7a9a' }}>{bulkProgress.sent} / {bulkProgress.total}</span>
                  </div>
                  <div style={{ background:'#e2e8f4', borderRadius:20, height:8, overflow:'hidden' }}>
                    <div style={{ background:'linear-gradient(90deg,#2D3278,#F47B20)', height:'100%', borderRadius:20, width:`${(bulkProgress.sent/bulkProgress.total)*100}%`, transition:'width 0.3s' }} />
                  </div>
                  {bulkProgress.errors.length > 0 && (
                    <div style={{ marginTop:8, fontSize:12, color:'#b02020' }}>
                      {bulkProgress.errors.slice(0,3).map((e,i) => <div key={i}>✗ {e}</div>)}
                      {bulkProgress.errors.length > 3 && <div>…and {bulkProgress.errors.length-3} more errors</div>}
                    </div>
                  )}
                </div>
              )}

              <button onClick={sendBulk} disabled={validCount===0||bulkSending} style={{ width:'100%', padding:'13px', background:(validCount===0||bulkSending)?'#e2e8f4':'linear-gradient(135deg,#2D3278,#1a1f5e)', color:(validCount===0||bulkSending)?'#9aaab0':'#fff', border:'none', borderRadius:10, fontSize:15, cursor:(validCount===0||bulkSending)?'not-allowed':'pointer', fontFamily:'Georgia,serif', fontWeight:700 }}>
                {bulkSending ? `Sending ${bulkProgress?.sent||0} of ${validCount}…` : bulkDone ? '✓ Done! Send More?' : `📤 Send ${validCount} Invitation${validCount!==1?'s':''}`}
              </button>
            </div>
          )}
        </div>

        {/* Right panel — invitation list */}
        <div style={{ background:'#fff', borderRadius:14, padding:22, border:'1px solid #e2e8f4' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
            <h2 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:0 }}>All Invitations</h2>
            <span style={{ fontSize:12, color:'#6a7a9a' }}>{invites.length} total</span>
          </div>

          {loading ? <p style={{ color:'#6a7a9a', fontSize:13 }}>Loading…</p> : invites.length===0 ? (
            <div style={{ textAlign:'center', padding:'32px 0', color:'#9aaab0' }}>
              <div style={{ fontSize:40, marginBottom:10 }}>✉️</div>
              <div style={{ fontSize:13 }}>No invitations yet</div>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:8, maxHeight:'calc(100vh - 200px)', overflowY:'auto' }}>
              {invites.map((inv: any) => {
                const s = STATUS_STYLE[inv.status] || STATUS_STYLE.pending
                const inviteUrl = `${typeof window!=='undefined'?window.location.origin:''}/invite/${inv.token}`
                return (
                  <div key={inv.id} style={{ padding:'12px 14px', borderRadius:10, border:'1px solid #e2e8f4', background:'#fafbff' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:inv.status!=='registered'?8:0 }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:13, fontWeight:700, color:'#1a2a3a', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }}>{inv.client_email}</div>
                        {inv.client_name && inv.client_name!==inv.client_email?.split('@')[0] && <div style={{ fontSize:11, color:'#6a7a9a' }}>{inv.client_name}</div>}
                      </div>
                      <span style={{ fontSize:11, padding:'2px 8px', borderRadius:20, fontWeight:700, background:s.bg, color:s.color, flexShrink:0 }}>
                        {inv.status==='registered'?'✓ Registered':inv.status}
                      </span>
                      <span style={{ fontSize:10, color:'#9aaab0', flexShrink:0 }}>
                        {inv.sent_at ? new Date(inv.sent_at).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '—'}
                      </span>
                    </div>
                    {inv.status!=='registered' && (
                      <div style={{ display:'flex', gap:6 }}>
                        <button onClick={() => copyLink(inviteUrl,inv.id)} style={{ fontSize:11, padding:'4px 10px', borderRadius:7, border:'1px solid #e2e8f4', background:copied===inv.id?'#e8f5ee':'#f0f4fa', color:copied===inv.id?'#1a6b4a':'#0f2340', cursor:'pointer', fontWeight:700 }}>
                          {copied===inv.id?'✓ Copied':'🔗 Copy Link'}
                        </button>
                        <button onClick={() => resend(inv)} disabled={resending===inv.id} style={{ fontSize:11, padding:'4px 10px', borderRadius:7, border:'1px solid #e2e8f4', background:'#f0f4fa', color:'#2D3278', cursor:resending===inv.id?'not-allowed':'pointer', fontWeight:700, opacity:resending===inv.id?0.6:1 }}>
                          {resending===inv.id?'…':'↻ Resend'}
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
