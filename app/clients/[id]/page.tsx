'use client'
import { useState, useEffect, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { getCategories, getCategoryIcon, TAX_YEARS } from '@/lib/documentCategories'

export default function ClientDetailPage() {
  const { id }   = useParams()
  const router   = useRouter()
  const [client, setClient]     = useState<any>(null)
  const [docs,   setDocs]       = useState<any[]>([])
  const [loading, setLoading]   = useState(true)
  const [tab,    setTab]        = useState<'documents'|'profile'>('documents')
  const [year,   setYear]       = useState(new Date().getFullYear())
  const [cat,    setCat]        = useState<string|null>(null)
  const [uploading, setUploading] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = () => {
    setLoading(true)
    fetch(`/api/clients/${id}`)
      .then(r => r.json())
      .then(d => {
        setClient(d.client)
        setDocs(d.documents || [])
        setLoading(false)
      })
  }

  useEffect(() => { load() }, [id])

  const categories = client ? getCategories(client.type) : {}
  const yearDocs = docs.filter(d => d.tax_year === year)
  const catDocs  = cat ? yearDocs.filter(d => d.category === cat) : yearDocs

  const uploadFile = async (file: File, category: string, subcategory: string) => {
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('clientId', id as string)
    fd.append('taxYear', String(year))
    fd.append('category', category)
    fd.append('subcategory', subcategory)
    const res = await fetch('/api/documents', { method:'POST', body:fd })
    const d   = await res.json()
    setUploading(false)
    if (!d.error) { load(); setShowUpload(false) }
    else alert(d.error)
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

  const formatSize = (bytes: number) => {
    if (!bytes) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1048576) return `${(bytes/1024).toFixed(1)} KB`
    return `${(bytes/1048576).toFixed(1)} MB`
  }

  if (loading) return <div style={{ padding:40, textAlign:'center', color:'#6a7a9a' }}>Loading…</div>
  if (!client) return <div style={{ padding:40, textAlign:'center', color:'#b02020' }}>Client not found</div>

  return (
    <div>
      {showUpload && (
        <UploadModal
          categories={categories}
          onUpload={uploadFile}
          onClose={() => setShowUpload(false)}
          uploading={uploading}
          defaultCategory={cat || ''}
        />
      )}

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:16, marginBottom:24 }}>
        <button onClick={() => router.push('/clients')} style={{ background:'#f0f4fa', border:'1px solid #e2e8f4', color:'#6a7a9a', padding:'7px 14px', borderRadius:8, cursor:'pointer', fontSize:13 }}>← Back</button>
        <div style={{ flex:1 }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ width:44, height:44, borderRadius:12, background:client.type==='business'?'#0f234015':'#5a1a8a15', display:'flex', alignItems:'center', justifyContent:'center', fontSize:22 }}>
              {client.type==='business'?'🏢':'👤'}
            </div>
            <div>
              <h1 style={{ fontFamily:'Georgia,serif', fontSize:22, color:'#0f2340', margin:0 }}>{client.name}</h1>
              <div style={{ fontSize:13, color:'#6a7a9a', marginTop:2 }}>{client.email}{client.phone ? ` · ${client.phone}` : ''}</div>
            </div>
          </div>
        </div>
        <div style={{ display:'flex', gap:8' }}>
          <span style={{ fontSize:12, padding:'4px 12px', borderRadius:20, background:client.type==='business'?'#e8f0ff':'#f0e8ff', color:client.type==='business'?'#1a3560':'#5a1a8a', fontWeight:700 }}>
            {client.type==='business'?'Business':'Individual'}
          </span>
          <span style={{ fontSize:12, padding:'4px 12px', borderRadius:20, background:'#e8f5ee', color:'#1a6b4a', fontWeight:700 }}>{client.stage}</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:20, borderBottom:'2px solid #e2e8f4' }}>
        {(['documents','profile'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ padding:'10px 20px', border:'none', background:'none', cursor:'pointer', fontSize:14, fontWeight:tab===t?700:400, color:tab===t?'#0f2340':'#6a7a9a', borderBottom:tab===t?'2px solid #0f2340':'2px solid transparent', marginBottom:-2, textTransform:'capitalize' }}>{t}</button>
        ))}
      </div>

      {tab === 'documents' && (
        <div style={{ display:'grid', gridTemplateColumns:'220px 1fr', gap:20 }}>
          {/* Sidebar — categories */}
          <div>
            {/* Year selector */}
            <div style={{ background:'#fff', borderRadius:12, padding:14, border:'1px solid #e2e8f4', marginBottom:12 }}>
              <div style={{ fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase', letterSpacing:0.5, marginBottom:8 }}>Tax Year</div>
              <select value={year} onChange={e => setYear(parseInt(e.target.value))} style={{ width:'100%', padding:'8px 10px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:14, fontWeight:700, color:'#0f2340', outline:'none' }}>
                {TAX_YEARS.map(y => <option key={y}>{y}</option>)}
              </select>
            </div>

            {/* Categories */}
            <div style={{ background:'#fff', borderRadius:12, border:'1px solid #e2e8f4', overflow:'hidden' }}>
              <div
                onClick={() => setCat(null)}
                style={{ padding:'10px 14px', cursor:'pointer', background:!cat?'#0f2340':'transparent', color:!cat?'#fff':'#3a4a5a', fontSize:13, fontWeight:!cat?700:400, display:'flex', justifyContent:'space-between', alignItems:'center' }}
              >
                <span>📋 All Documents</span>
                <span style={{ fontSize:11, opacity:0.7 }}>{yearDocs.length}</span>
              </div>
              {Object.keys(categories).map(c => {
                const count = yearDocs.filter(d => d.category === c).length
                return (
                  <div key={c}
                    onClick={() => setCat(c)}
                    style={{ padding:'9px 14px', cursor:'pointer', background:cat===c?'#f0f4ff':'transparent', color:cat===c?'#0f2340':'#4a5a6a', fontSize:13, fontWeight:cat===c?700:400, display:'flex', justifyContent:'space-between', alignItems:'center', borderTop:'1px solid #f0f4fa' }}
                  >
                    <span>{getCategoryIcon(c)} {c}</span>
                    {count > 0 && <span style={{ fontSize:11, background:'#0f234020', color:'#0f2340', padding:'1px 7px', borderRadius:20, fontWeight:700 }}>{count}</span>}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Main content — documents */}
          <div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
              <div>
                <h2 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:'0 0 2px' }}>
                  {cat ? `${getCategoryIcon(cat)} ${cat}` : `All Documents — ${year}`}
                </h2>
                <div style={{ fontSize:12, color:'#6a7a9a' }}>{catDocs.length} file{catDocs.length !== 1 ? 's' : ''}</div>
              </div>
              <button onClick={() => setShowUpload(true)} style={{ background:'linear-gradient(135deg,#0f2340,#243f72)', color:'#fff', border:'none', padding:'9px 18px', borderRadius:9, fontSize:13, fontWeight:700, cursor:'pointer', fontFamily:'Georgia,serif' }}>
                + Upload Document
              </button>
            </div>

            {catDocs.length === 0 ? (
              <div style={{ background:'#fff', borderRadius:14, border:'2px dashed #e2e8f4', padding:48, textAlign:'center' }}>
                <div style={{ fontSize:40, marginBottom:12 }}>📁</div>
                <div style={{ fontSize:15, fontWeight:700, color:'#0f2340', marginBottom:6 }}>No documents yet</div>
                <div style={{ fontSize:13, color:'#6a7a9a', marginBottom:20 }}>Upload documents for {year} {cat ? `— ${cat}` : ''}</div>
                <button onClick={() => setShowUpload(true)} style={{ background:'#0f2340', color:'#fff', border:'none', padding:'9px 20px', borderRadius:9, cursor:'pointer', fontSize:13, fontWeight:700 }}>Upload First Document</button>
              </div>
            ) : (
              <div style={{ background:'#fff', borderRadius:14, border:'1px solid #e2e8f4', overflow:'hidden' }}>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                  <thead>
                    <tr style={{ background:'#f8faff' }}>
                      {['File Name','Category','Size','Status','Uploaded','Actions'].map(h => (
                        <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase', letterSpacing:0.5, borderBottom:'1.5px solid #e2e8f4' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {catDocs.map(doc => (
                      <tr key={doc.id} style={{ borderBottom:'1px solid #f0f4fa' }}>
                        <td style={{ padding:'11px 14px' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                            <span style={{ fontSize:18 }}>{doc.file_type?.includes('pdf') ? '📄' : doc.file_type?.includes('image') ? '🖼' : '📎'}</span>
                            <div>
                              <div style={{ fontSize:13, fontWeight:700, color:'#1a2a3a' }}>{doc.file_name}</div>
                              {doc.subcategory && <div style={{ fontSize:11, color:'#6a7a9a' }}>{doc.subcategory}</div>}
                            </div>
                          </div>
                        </td>
                        <td style={{ padding:'11px 14px', fontSize:12, color:'#6a7a9a' }}>{doc.category}</td>
                        <td style={{ padding:'11px 14px', fontSize:12, color:'#6a7a9a' }}>{formatSize(doc.file_size)}</td>
                        <td style={{ padding:'11px 14px' }}>
                          <span style={{ fontSize:11, padding:'2px 8px', borderRadius:20, fontWeight:700, background:doc.status==='approved'?'#e8f5ee':doc.status==='reviewed'?'#e8f0ff':'#f0f4fa', color:doc.status==='approved'?'#1a6b4a':doc.status==='reviewed'?'#1a3560':'#6a7a9a' }}>
                            {doc.status}
                          </span>
                        </td>
                        <td style={{ padding:'11px 14px', fontSize:12, color:'#6a7a9a' }}>
                          {new Date(doc.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric' })}
                        </td>
                        <td style={{ padding:'11px 14px' }}>
                          <div style={{ display:'flex', gap:6 }}>
                            <button onClick={() => openDoc(doc.id)} style={{ fontSize:11, padding:'4px 10px', borderRadius:7, border:'1px solid #e2e8f4', background:'#f8faff', color:'#0f2340', cursor:'pointer', fontWeight:700 }}>View</button>
                            <button onClick={() => deleteDoc(doc.id)} style={{ fontSize:11, padding:'4px 10px', borderRadius:7, border:'1px solid #fdd', background:'#fff5f5', color:'#b02020', cursor:'pointer', fontWeight:700 }}>Del</button>
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

      {tab === 'profile' && (
        <div style={{ background:'#fff', borderRadius:14, padding:24, border:'1px solid #e2e8f4', maxWidth:600 }}>
          <h2 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', marginBottom:20 }}>Client Profile</h2>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
            {[
              ['Name', client.name], ['Email', client.email], ['Phone', client.phone || '—'],
              ['Type', client.type], ['Assignee', client.assignee || '—'], ['Stage', client.stage],
              ['Language', client.language], ['Balance', `$${client.balance || 0}`],
              ...(client.type === 'business' ? [
                ['Business Name', client.business_name || '—'], ['EIN', client.ein || '—'],
                ['Entity Type', client.business_type || '—'], ['Industry', client.industry || '—'],
              ] : [
                ['Filing Status', client.filing_status || '—'],
              ]),
              ['Address', [client.address_line1, client.city, client.state, client.zip].filter(Boolean).join(', ') || '—'],
            ].map(([label, value]) => (
              <div key={label}>
                <div style={{ fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase', letterSpacing:0.5 }}>{label}</div>
                <div style={{ fontSize:14, color:'#1a2a3a', marginTop:3 }}>{value}</div>
              </div>
            ))}
          </div>
          {client.notes && (
            <div style={{ marginTop:20, padding:'14px', background:'#f8faff', borderRadius:10, border:'1px solid #e2e8f4' }}>
              <div style={{ fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase', letterSpacing:0.5, marginBottom:6 }}>Notes</div>
              <div style={{ fontSize:13, color:'#3a4a5a', lineHeight:1.6 }}>{client.notes}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function UploadModal({ categories, onUpload, onClose, uploading, defaultCategory }: any) {
  const [file, setFile]       = useState<File|null>(null)
  const [cat,  setCat]        = useState(defaultCategory || Object.keys(categories)[0] || '')
  const [sub,  setSub]        = useState('')
  const [drag, setDrag]       = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const subs = cat ? (categories[cat] || []) : []

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDrag(false)
    const f = e.dataTransfer.files[0]
    if (f) setFile(f)
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(15,35,64,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:20 }}>
      <div style={{ background:'#fff', borderRadius:20, width:'100%', maxWidth:480, boxShadow:'0 30px 80px rgba(0,0,0,0.4)' }}>
        <div style={{ background:'linear-gradient(135deg,#0f2340,#243f72)', padding:'18px 22px', borderRadius:'20px 20px 0 0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <h2 style={{ fontFamily:'Georgia,serif', fontSize:17, color:'#fff', margin:0 }}>Upload Document</h2>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.15)', border:'none', color:'#fff', width:28, height:28, borderRadius:7, cursor:'pointer', fontSize:15 }}>✕</button>
        </div>
        <div style={{ padding:'20px 22px' }}>

          {/* Drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
            style={{ border:`2px dashed ${drag?'#0f2340':'#e2e8f4'}`, borderRadius:12, padding:'28px', textAlign:'center', cursor:'pointer', background:drag?'#f0f4ff':'#fafbff', marginBottom:16, transition:'all 0.15s' }}
          >
            <input ref={fileRef} type="file" onChange={e => setFile(e.target.files?.[0]||null)} style={{ display:'none' }} />
            {file ? (
              <div>
                <div style={{ fontSize:28, marginBottom:6 }}>📄</div>
                <div style={{ fontWeight:700, fontSize:14, color:'#0f2340' }}>{file.name}</div>
                <div style={{ fontSize:12, color:'#6a7a9a' }}>{(file.size/1024).toFixed(1)} KB</div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize:36, marginBottom:8 }}>📂</div>
                <div style={{ fontWeight:700, fontSize:14, color:'#0f2340', marginBottom:4 }}>Drop file here or click to browse</div>
                <div style={{ fontSize:12, color:'#6a7a9a' }}>PDF, Word, Excel, Images — max 50MB</div>
              </div>
            )}
          </div>

          {/* Category */}
          <div style={{ marginBottom:12 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:5 }}>Category</label>
            <select value={cat} onChange={e => { setCat(e.target.value); setSub('') }} style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }}>
              {Object.keys(categories).map(c => <option key={c}>{c}</option>)}
            </select>
          </div>

          {/* Subcategory */}
          {subs.length > 0 && (
            <div style={{ marginBottom:16 }}>
              <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:5 }}>Document Type</label>
              <select value={sub} onChange={e => setSub(e.target.value)} style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }}>
                <option value="">— Select type —</option>
                {subs.map((s: string) => <option key={s}>{s}</option>)}
              </select>
            </div>
          )}

          <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
            <button onClick={onClose} style={{ padding:'9px 18px', borderRadius:9, border:'1px solid #e2e8f4', background:'#f8faff', color:'#6a7a9a', cursor:'pointer', fontSize:13 }}>Cancel</button>
            <button onClick={() => file && onUpload(file, cat, sub)} disabled={!file || uploading} style={{ padding:'9px 20px', borderRadius:9, border:'none', background:(!file||uploading)?'#e2e8f4':'linear-gradient(135deg,#0f2340,#243f72)', color:(!file||uploading)?'#9aaab0':'#fff', cursor:(!file||uploading)?'not-allowed':'pointer', fontSize:14, fontFamily:'Georgia,serif', fontWeight:700 }}>
              {uploading ? 'Uploading…' : '⬆ Upload'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
