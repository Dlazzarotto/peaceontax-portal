'use client'
import QuotesTab from '@/components/QuotesTab'
import ProfileEditor from '@/components/ProfileEditor'
import PlansTab from '@/components/PlansTab'
import { useState, useEffect, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { getCategories, getCategoryIcon, TAX_YEARS } from '@/lib/documentCategories'

const STAGES = ['Onboarding','Gathering Docs','In Preparation','Under Review','Filed','Complete']
const STAGE_COLOR: Record<string,string> = { 'Onboarding':'#6a7a9a','Gathering Docs':'#c06010','In Preparation':'#2D3278','Under Review':'#5a1a8a','Filed':'#1a6b4a','Complete':'#1a6b4a' }

export default function ClientDetailPage() {
  const { id }   = useParams()
  const router   = useRouter()
  const [client,    setClient]    = useState<any>(null)
  const [docs,      setDocs]      = useState<any[]>([])
  const [messages,  setMessages]  = useState<any[]>([])
  const [loading,   setLoading]   = useState(true)
  const [tab,       setTab]       = useState<'documents'|'messages'|'profile'|'quotes'|'plans'>('documents')
  const [year,      setYear]      = useState(new Date().getFullYear())
  const [cat,       setCat]       = useState<string|null>(null)
  const [uploading, setUploading] = useState(false)
  const [newMsg,    setNewMsg]    = useState('')
  const [sending,   setSending]   = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const msgRef  = useRef<HTMLDivElement>(null)

  const load = () => {
    setLoading(true)
    fetch(`/api/clients/${id}`).then(r => r.json()).then(d => {
      setClient(d.client); setDocs(d.documents||[]); setMessages(d.messages||[]); setLoading(false)
    })
  }

  useEffect(() => { load() }, [id])
  useEffect(() => { msgRef.current?.scrollIntoView({ behavior:'smooth' }) }, [messages])

  const updateField = async (field: string, value: string) => {
    setClient((p: any) => ({...p, [field]:value}))
    await fetch(`/api/clients/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ [field]:value }) })
  }

  const uploadFile = async (file: File) => {
    if (!cat) { alert('Select a category first'); return }
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file); fd.append('clientId', id as string)
    fd.append('taxYear', String(year)); fd.append('category', cat)
    const res = await fetch('/api/documents', { method:'POST', body:fd })
    const d = await res.json()
    setUploading(false)
    if (d.error) alert(d.error); else load()
  }

  const openDoc = async (docId: string) => {
    const res = await fetch(`/api/documents/${docId}`)
    const d   = await res.json()
    if (d.url) window.open(d.url, '_blank')
  }

  const deleteDoc = async (docId: string) => {
    if (!confirm('Delete this document?')) return
    await fetch(`/api/documents/${docId}`, { method:'DELETE' })
    load()
  }

  const sendMsg = async () => {
    if (!newMsg.trim() || sending) return
    setSending(true)
    await fetch('/api/firm/messages', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ clientId:id, text:newMsg.trim() }) })
    setNewMsg(''); setSending(false); load()
  }

  const categories = client ? getCategories(client.type) : {}
  const yearDocs   = docs.filter(d => d.tax_year===year)
  const catDocs    = cat ? yearDocs.filter(d => d.category===cat) : yearDocs
  const formatSize = (b: number) => b < 1024 ? `${b}B` : b < 1048576 ? `${(b/1024).toFixed(1)}KB` : `${(b/1048576).toFixed(1)}MB`

  if (loading) return <div style={{ padding:40, textAlign:'center', color:'#6a7a9a' }}>Loading…</div>
  if (!client) return <div style={{ padding:40, textAlign:'center', color:'#b02020' }}>Client not found</div>

  return (
    <div>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:16, marginBottom:22 }}>
        <button onClick={() => router.push('/clients')} style={{ background:'#f0f4fa', border:'1px solid #e2e8f4', color:'#6a7a9a', padding:'7px 14px', borderRadius:8, cursor:'pointer', fontSize:13 }}>← Back</button>
        <div style={{ flex:1, display:'flex', alignItems:'center', gap:14 }}>
          <div style={{ width:46, height:46, borderRadius:12, background:client.type==='business'?'#2D327815':'#5a1a8a15', display:'flex', alignItems:'center', justifyContent:'center', fontSize:24 }}>
            {client.type==='business' ? '🏢' : '👤'}
          </div>
          <div>
            <h1 style={{ fontFamily:'Georgia,serif', fontSize:22, color:'#0f2340', margin:'0 0 3px', display:'flex', alignItems:'center', gap:10 }}>
              {client.name}
              {client.active === false && (
                <span style={{ fontSize:11, padding:'3px 10px', borderRadius:20, fontWeight:700, background:'#fee2e2', color:'#b02020' }}>INATIVO</span>
              )}
            </h1>
            <div style={{ fontSize:13, color:'#6a7a9a' }}>{client.email}{client.phone ? ` · ${client.phone}` : ''}</div>
          </div>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <select value={client.stage} onChange={e => updateField('stage', e.target.value)}
            style={{ padding:'7px 14px', border:`2px solid ${STAGE_COLOR[client.stage]||'#e2e8f4'}`, borderRadius:9, fontSize:13, fontWeight:700, color:STAGE_COLOR[client.stage]||'#6a7a9a', outline:'none', background:'#fff', cursor:'pointer' }}>
            {STAGES.map(s => <option key={s}>{s}</option>)}
          </select>
          <select value={client.assignee||''} onChange={e => updateField('assignee', e.target.value)}
            style={{ padding:'7px 14px', border:'1px solid #e2e8f4', borderRadius:9, fontSize:13, color:'#6a7a9a', outline:'none', background:'#fff', cursor:'pointer' }}>
            <option value="">— Assignee —</option>
            {['David L.','Sarah K.','Maria R.'].map(a => <option key={a}>{a}</option>)}
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:20, borderBottom:'2px solid #e2e8f4' }}>
        {([
          ['documents', `📁 Documents (${docs.length})`],
          ['messages',  `💬 Messages (${messages.length})`],
          ['quotes',    '💰 Quotes'],
          ['plans',     '📆 Planos'],
          ['profile',   '👤 Profile'],
        ] as const).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            style={{ padding:'10px 20px', border:'none', background:'none', cursor:'pointer', fontSize:14,
              fontWeight:tab===t?700:400, color:tab===t?'#2D3278':'#6a7a9a',
              borderBottom:tab===t?'2px solid #2D3278':'2px solid transparent', marginBottom:-2 }}>
            {label}
          </button>
        ))}
      </div>

      {/* DOCUMENTS TAB */}
      {tab==='documents' && (
        <div style={{ display:'grid', gridTemplateColumns:'200px 1fr', gap:16 }}>
          <div>
            <div style={{ background:'#fff', borderRadius:10, padding:12, border:'1px solid #e2e8f4', marginBottom:10 }}>
              <div style={{ fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:6 }}>Tax Year</div>
              <select value={year} onChange={e => setYear(parseInt(e.target.value))}
                style={{ width:'100%', padding:'7px 10px', border:'1.5px solid #e2e8f4', borderRadius:7, fontSize:14, fontWeight:700, color:'#0f2340', outline:'none' }}>
                {TAX_YEARS.map(y => <option key={y}>{y}</option>)}
              </select>
            </div>
            <div style={{ background:'#fff', borderRadius:10, border:'1px solid #e2e8f4', overflow:'hidden' }}>
              <div onClick={() => setCat(null)} style={{ padding:'9px 12px', cursor:'pointer', background:!cat?'#2D3278':'transparent', color:!cat?'#fff':'#3a4a5a', fontSize:12, fontWeight:!cat?700:400, display:'flex', justifyContent:'space-between' }}>
                <span>📋 All</span><span style={{ opacity:0.7, fontSize:11 }}>{yearDocs.length}</span>
              </div>
              {Object.keys(categories).map(c => {
                const count = yearDocs.filter(d => d.category===c).length
                return (
                  <div key={c} onClick={() => setCat(c)} style={{ padding:'8px 12px', cursor:'pointer', background:cat===c?'#f0f4ff':'transparent', color:cat===c?'#2D3278':'#4a5a6a', fontSize:11, display:'flex', justifyContent:'space-between', borderTop:'1px solid #f0f4fa' }}>
                    <span>{getCategoryIcon(c)} {c}</span>
                    {count>0 && <span style={{ fontSize:10, background:'#2D327820', color:'#2D3278', padding:'1px 6px', borderRadius:20, fontWeight:700 }}>{count}</span>}
                  </div>
                )
              })}
            </div>
          </div>
          <div>
            <div
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f=e.dataTransfer.files[0]; if(f) uploadFile(f) }}
              onClick={() => fileRef.current?.click()}
              style={{ border:'2px dashed #e2e8f4', borderRadius:10, padding:'16px', textAlign:'center', cursor:'pointer', background:'#fafbff', marginBottom:14 }}>
              <input ref={fileRef} type="file" onChange={e => { const f=e.target.files?.[0]; if(f) uploadFile(f) }} style={{ display:'none' }} />
              <div style={{ fontSize:24, marginBottom:4 }}>📂</div>
              <div style={{ fontSize:13, color:uploading?'#1a6b4a':'#6a7a9a', fontWeight:uploading?700:400 }}>
                {uploading ? 'Uploading…' : `Drop file here${cat?` → ${cat}`:' (select category first)'}`}
              </div>
            </div>
            {catDocs.length===0 ? (
              <div style={{ background:'#fff', borderRadius:12, padding:40, textAlign:'center', border:'1px solid #e2e8f4', color:'#9aaab0' }}>
                <div style={{ fontSize:32, marginBottom:8 }}>📁</div>No documents yet
              </div>
            ) : (
              <div style={{ background:'#fff', borderRadius:12, border:'1px solid #e2e8f4', overflow:'hidden' }}>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                  <thead><tr style={{ background:'#f8faff' }}>
                    {['File','Category','Size','Status','Date',''].map(h => <th key={h} style={{ padding:'9px 14px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, borderBottom:'1px solid #e2e8f4' }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {catDocs.map(doc => (
                      <tr key={doc.id} style={{ borderBottom:'1px solid #f0f4fa' }}>
                        <td style={{ padding:'9px 14px' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                            <span>{doc.file_type?.includes('pdf')?'📄':doc.file_type?.includes('image')?'🖼':'📎'}</span>
                            <span style={{ fontSize:13, fontWeight:700, color:'#1a2a3a' }}>{doc.file_name}</span>
                          </div>
                        </td>
                        <td style={{ padding:'9px 14px', fontSize:11, color:'#6a7a9a' }}>{doc.category}</td>
                        <td style={{ padding:'9px 14px', fontSize:11, color:'#6a7a9a' }}>{formatSize(doc.file_size)}</td>
                        <td style={{ padding:'9px 14px' }}>
                          <span style={{ fontSize:11, padding:'2px 7px', borderRadius:20, fontWeight:700, background:doc.status==='approved'?'#e8f5ee':'#f0f4fa', color:doc.status==='approved'?'#1a6b4a':'#6a7a9a' }}>{doc.status}</span>
                        </td>
                        <td style={{ padding:'9px 14px', fontSize:11, color:'#6a7a9a' }}>{new Date(doc.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</td>
                        <td style={{ padding:'9px 14px' }}>
                          <div style={{ display:'flex', gap:5 }}>
                            <button onClick={() => openDoc(doc.id)} style={{ fontSize:11, padding:'3px 9px', borderRadius:6, border:'1px solid #e2e8f4', background:'#f8faff', color:'#2D3278', cursor:'pointer', fontWeight:700 }}>View</button>
                            <button onClick={() => deleteDoc(doc.id)} style={{ fontSize:11, padding:'3px 9px', borderRadius:6, border:'1px solid #fdd', background:'#fff5f5', color:'#b02020', cursor:'pointer', fontWeight:700 }}>Del</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MESSAGES TAB */}
      {tab==='messages' && (
        <div style={{ background:'#fff', borderRadius:14, border:'1px solid #e2e8f4', display:'flex', flexDirection:'column', height:'calc(100vh - 280px)', minHeight:400 }}>
          <div style={{ flex:1, overflowY:'auto', padding:'16px 18px', display:'flex', flexDirection:'column', gap:10 }}>
            {messages.length===0 ? (
              <div style={{ textAlign:'center', color:'#9aaab0', padding:'40px 0' }}>
                <div style={{ fontSize:32, marginBottom:8 }}>💬</div>No messages yet
              </div>
            ) : [...messages].reverse().map((msg: any) => {
              const isFirm = msg.sender==='firm'
              return (
                <div key={msg.id} style={{ display:'flex', justifyContent:isFirm?'flex-end':'flex-start' }}>
                  <div style={{ maxWidth:'70%' }}>
                    <div style={{ fontSize:10, color:'#9aaab0', marginBottom:3, textAlign:isFirm?'right':'left' }}>
                      {isFirm?'Peace on Tax':client.name} · {new Date(msg.created_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}
                    </div>
                    <div style={{ background:isFirm?'linear-gradient(135deg,#2D3278,#1a1f5e)':'#f0f4fa', color:isFirm?'#fff':'#1a2a3a', padding:'10px 14px', borderRadius:isFirm?'12px 12px 4px 12px':'12px 12px 12px 4px', fontSize:14, lineHeight:1.5 }}>
                      {msg.text}
                    </div>
                  </div>
                </div>
              )
            })}
            <div ref={msgRef} />
          </div>
          <div style={{ padding:'12px 16px', borderTop:'1px solid #e2e8f4', display:'flex', gap:10 }}>
            <input value={newMsg} onChange={e => setNewMsg(e.target.value)} onKeyDown={e => e.key==='Enter' && sendMsg()}
              placeholder={`Message ${client.name}…`}
              style={{ flex:1, padding:'10px 14px', border:'1.5px solid #e2e8f4', borderRadius:10, fontSize:14, outline:'none' }} />
            <button onClick={sendMsg} disabled={!newMsg.trim()||sending}
              style={{ background:newMsg.trim()&&!sending?'linear-gradient(135deg,#2D3278,#1a1f5e)':'#e2e8f4', color:newMsg.trim()&&!sending?'#fff':'#9aaab0', border:'none', padding:'10px 18px', borderRadius:10, fontSize:14, fontWeight:700, cursor:newMsg.trim()&&!sending?'pointer':'not-allowed' }}>
              {sending?'…':'Send'}
            </button>
          </div>
        </div>
      )}

      {/* QUOTES TAB */}
      {tab==='quotes' && (
        <QuotesTab clientId={id as string} clientName={client.name} clientType={client.type} />
      )}

      {/* PLANS TAB */}
      {tab==='plans' && (
        <PlansTab clientId={id as string} clientName={client.name} />
      )}

      {/* PROFILE TAB — editável pela equipe */}
      {tab==='profile' && (
        <ProfileEditor client={client} onSaved={load} />
      )}
    </div>
  )
}
