'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

const STAGES = ['Onboarding','Gathering Docs','In Preparation','Under Review','Filed','Complete']
const STAGE_COLOR: Record<string,string> = {
  'Onboarding':      '#6a7a9a',
  'Gathering Docs':  '#c06010',
  'In Preparation':  '#2D3278',
  'Under Review':    '#5a1a8a',
  'Filed':           '#1a6b4a',
  'Complete':        '#1a6b4a',
}
const STAGE_BG: Record<string,string> = {
  'Onboarding':      '#f0f4fa',
  'Gathering Docs':  '#fff4e8',
  'In Preparation':  '#e8f0ff',
  'Under Review':    '#f0e8ff',
  'Filed':           '#e8f5ee',
  'Complete':        '#e8f5ee',
}

type ViewMode = 'kanban' | 'list'

export default function ClientsPage() {
  const [clients,  setClients]  = useState<any[]>([])
  const [loading,  setLoading]  = useState(true)
  const [view,     setView]     = useState<ViewMode>('kanban')
  const [search,   setSearch]   = useState('')
  const [filter,   setFilter]   = useState('all')
  const [showNew,  setShowNew]  = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)

  const load = (q = '') => {
    setLoading(true)
    const params = new URLSearchParams()
    if (q) params.set('search', q)
    if (filter !== 'all') params.set('type', filter)
    fetch(`/api/clients?${params}`).then(r => r.json()).then(d => { setClients(d.clients || []); setLoading(false) })
  }

  useEffect(() => { load(search) }, [search, filter])

  const updateStage = async (clientId: string, newStage: string) => {
    await fetch(`/api/clients/${clientId}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ stage: newStage }) })
    setClients(p => p.map(c => c.id===clientId ? {...c, stage:newStage} : c))
  }

  const stats = {
    total:      clients.length,
    individual: clients.filter(c => c.type==='individual').length,
    business:   clients.filter(c => c.type==='business').length,
  }

  const byStage = (stage: string) => clients.filter(c => c.stage===stage)

  return (
    <div>
      {showNew && <NewClientModal onSave={() => { setShowNew(false); load(search) }} onClose={() => setShowNew(false)} />}

      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h1 style={{ fontFamily:'Georgia,serif', fontSize:24, color:'#0f2340', margin:'0 0 4px' }}>Clients</h1>
          <p style={{ color:'#6a7a9a', fontSize:13, margin:0 }}>{stats.total} total · {stats.individual} individual · {stats.business} business</p>
        </div>
        <div style={{ display:'flex', gap:10, alignItems:'center' }}>
          {/* View toggle */}
          <div style={{ display:'flex', background:'#e2e8f4', borderRadius:9, padding:2 }}>
            {([['kanban','🗂 Kanban'],['list','☰ List']] as const).map(([v,l]) => (
              <button key={v} onClick={() => setView(v)} style={{ padding:'6px 14px', borderRadius:7, border:'none', cursor:'pointer', fontSize:12, fontWeight:700, background:view===v?'#fff':'transparent', color:view===v?'#2D3278':'#6a7a9a' }}>{l}</button>
            ))}
          </div>
          <button onClick={() => setShowNew(true)} style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', color:'#fff', border:'none', padding:'10px 20px', borderRadius:10, fontSize:14, fontFamily:'Georgia,serif', fontWeight:700, cursor:'pointer' }}>
            + New Client
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10, marginBottom:20 }}>
        {STAGES.map(s => (
          <div key={s} style={{ background:'#fff', borderRadius:10, padding:'12px 14px', border:'1px solid #e2e8f4', cursor:'pointer' }} onClick={() => setFilter(s === filter ? 'all' : s)}>
            <div style={{ fontSize:18, fontWeight:800, color:STAGE_COLOR[s], fontFamily:'monospace' }}>{byStage(s).length}</div>
            <div style={{ fontSize:11, color:'#6a7a9a', marginTop:2 }}>{s}</div>
          </div>
        ))}
      </div>

      {/* Search & filter */}
      <div style={{ display:'flex', gap:10, marginBottom:16 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search clients…"
          style={{ flex:1, padding:'9px 14px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:13, outline:'none', fontFamily:'Georgia,serif' }} />
        {['all','individual','business'].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{ padding:'8px 14px', borderRadius:8, border:'none', cursor:'pointer', fontSize:12, fontWeight:700, background:filter===f?'#2D3278':'#e2e8f4', color:filter===f?'#fff':'#6a7a9a', textTransform:'capitalize' as const }}>{f}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ padding:40, textAlign:'center', color:'#6a7a9a' }}>Loading clients…</div>
      ) : clients.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:14, padding:48, textAlign:'center', border:'1px solid #e2e8f4' }}>
          <div style={{ fontSize:48, marginBottom:12 }}>👥</div>
          <div style={{ fontSize:16, fontWeight:700, color:'#0f2340', marginBottom:6 }}>No clients yet</div>
          <div style={{ fontSize:13, color:'#6a7a9a', marginBottom:20 }}>Add your first client or send an invitation</div>
          <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
            <button onClick={() => setShowNew(true)} style={{ background:'#2D3278', color:'#fff', border:'none', padding:'10px 20px', borderRadius:9, cursor:'pointer', fontSize:13, fontWeight:700 }}>+ Add Client</button>
            <Link href="/invitations" style={{ background:'#f0f4fa', color:'#2D3278', border:'1px solid #e2e8f4', padding:'10px 20px', borderRadius:9, cursor:'pointer', fontSize:13, fontWeight:700, textDecoration:'none' }}>Send Invitation</Link>
          </div>
        </div>
      ) : view === 'kanban' ? (
        /* KANBAN VIEW */
        <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:12, overflowX:'auto' }}>
          {STAGES.map(stage => (
            <div key={stage}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); if (dragging) { updateStage(dragging, stage); setDragging(null) } }}
              style={{ background:'#f8faff', borderRadius:12, padding:12, border:'1px solid #e2e8f4', minHeight:200 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                <div style={{ fontSize:11, fontWeight:700, color:STAGE_COLOR[stage], textTransform:'uppercase' as const, letterSpacing:0.5 }}>{stage}</div>
                <span style={{ fontSize:11, background:STAGE_BG[stage], color:STAGE_COLOR[stage], padding:'1px 7px', borderRadius:20, fontWeight:700 }}>{byStage(stage).length}</span>
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {byStage(stage).map(c => (
                  <div key={c.id}
                    draggable
                    onDragStart={() => setDragging(c.id)}
                    onDragEnd={() => setDragging(null)}
                    style={{ background:'#fff', borderRadius:9, padding:'10px 12px', border:'1px solid #e2e8f4', cursor:'grab', boxShadow: dragging===c.id ? '0 4px 12px rgba(0,0,0,0.15)' : 'none' }}>
                    <Link href={`/clients/${c.id}`} style={{ textDecoration:'none' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
                        <span style={{ fontSize:12 }}>{c.type==='business'?'🏢':'👤'}</span>
                        <span style={{ fontSize:12, fontWeight:700, color:'#1a2a3a' }}>{c.name}</span>
                      </div>
                      <div style={{ fontSize:10, color:'#9aaab0', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }}>{c.email}</div>
                      {c.assignee && <div style={{ fontSize:10, color:'#6a7a9a', marginTop:3 }}>👤 {c.assignee}</div>}
                    </Link>
                    {/* Stage quick-change */}
                    <select value={c.stage} onChange={e => updateStage(c.id, e.target.value)} onClick={e => e.stopPropagation()}
                      style={{ width:'100%', marginTop:6, padding:'3px 6px', border:'1px solid #e2e8f4', borderRadius:6, fontSize:10, color:'#6a7a9a', outline:'none', background:'#f8faff' }}>
                      {STAGES.map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* LIST VIEW */
        <div style={{ background:'#fff', borderRadius:14, border:'1px solid #e2e8f4', overflow:'hidden' }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ background:'#f8faff' }}>
                {['Client','Type','Assignee','Stage','Email','Actions'].map(h => (
                  <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, borderBottom:'1.5px solid #e2e8f4' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clients.map(c => (
                <tr key={c.id} style={{ borderBottom:'1px solid #f0f4fa' }}>
                  <td style={{ padding:'11px 16px' }}>
                    <div style={{ fontWeight:700, fontSize:14, color:'#1a2a3a' }}>{c.name}</div>
                    {c.phone && <div style={{ fontSize:11, color:'#9aaab0' }}>{c.phone}</div>}
                  </td>
                  <td style={{ padding:'11px 16px' }}>
                    <span style={{ fontSize:11, padding:'2px 9px', borderRadius:20, fontWeight:700, background:c.type==='business'?'#e8f0ff':'#f0e8ff', color:c.type==='business'?'#1a3560':'#5a1a8a' }}>
                      {c.type==='business'?'🏢 Business':'👤 Individual'}
                    </span>
                  </td>
                  <td style={{ padding:'11px 16px', fontSize:13, color:'#3a4a5a' }}>{c.assignee||'—'}</td>
                  <td style={{ padding:'11px 16px' }}>
                    <select value={c.stage} onChange={e => updateStage(c.id, e.target.value)}
                      style={{ padding:'4px 10px', border:'1px solid #e2e8f4', borderRadius:7, fontSize:12, color:STAGE_COLOR[c.stage]||'#6a7a9a', fontWeight:700, outline:'none', background:STAGE_BG[c.stage]||'#f0f4fa', cursor:'pointer' }}>
                      {STAGES.map(s => <option key={s}>{s}</option>)}
                    </select>
                  </td>
                  <td style={{ padding:'11px 16px', fontSize:12, color:'#6a7a9a' }}>{c.email}</td>
                  <td style={{ padding:'11px 16px' }}>
                    <Link href={`/clients/${c.id}`} style={{ fontSize:12, fontWeight:700, color:'#2D3278', textDecoration:'none', background:'#f0f4ff', padding:'5px 12px', borderRadius:7, display:'inline-block' }}>
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function NewClientModal({ onSave, onClose }: { onSave: () => void; onClose: () => void }) {
  const [form, setForm]     = useState({ name:'', email:'', phone:'', type:'individual', assignee:'', stage:'Onboarding', business_name:'', ein:'', business_type:'', filing_status:'', address_line1:'', city:'', state:'MA', zip:'', notes:'' })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')
  const set = (k: string, v: string) => setForm(p => ({...p,[k]:v}))

  const save = async () => {
    if (!form.name || !form.email) { setError('Name and email are required'); return }
    setSaving(true)
    const res = await fetch('/api/clients', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(form) })
    const d = await res.json()
    if (d.error) { setError(d.error); setSaving(false); return }
    onSave()
  }

  const inp = (label: string, key: string, type='text', ph='') => (
    <div style={{ marginBottom:12 }}>
      <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>{label}</label>
      <input type={type} value={(form as any)[key]} onChange={e => set(key,e.target.value)} placeholder={ph}
        style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, boxSizing:'border-box' as const, outline:'none' }} />
    </div>
  )

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(15,35,64,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:20 }}>
      <div style={{ background:'#fff', borderRadius:20, width:'100%', maxWidth:540, maxHeight:'90vh', overflowY:'auto', boxShadow:'0 30px 80px rgba(0,0,0,0.4)' }}>
        <div style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', padding:'18px 24px', borderRadius:'20px 20px 0 0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <h2 style={{ fontFamily:'Georgia,serif', fontSize:17, color:'#fff', margin:0 }}>New Client</h2>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.15)', border:'none', color:'#fff', width:28, height:28, borderRadius:7, cursor:'pointer', fontSize:15 }}>✕</button>
        </div>
        <div style={{ padding:'20px 24px' }}>
          <div style={{ display:'flex', gap:8, marginBottom:16 }}>
            {[['individual','👤 Individual'],['business','🏢 Business']].map(([v,l]) => (
              <button key={v} onClick={() => set('type',v)} style={{ flex:1, padding:'9px', borderRadius:9, cursor:'pointer', border:form.type===v?'2px solid #2D3278':'1.5px solid #e2e8f4', background:form.type===v?'#2D3278':'#fff', color:form.type===v?'#fff':'#6a7a9a', fontFamily:'Georgia,serif', fontSize:13, fontWeight:700 }}>{l}</button>
            ))}
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            {inp('Full Name *','name','text','John Smith')}
            {inp('Email *','email','email','john@example.com')}
            {inp('Phone','phone','tel','(617) 555-0000')}
            <div style={{ marginBottom:12 }}>
              <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>Assignee</label>
              <select value={form.assignee} onChange={e => set('assignee',e.target.value)} style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }}>
                <option value="">— Select —</option>
                {['David L.','Sarah K.','Maria R.'].map(a => <option key={a}>{a}</option>)}
              </select>
            </div>
          </div>
          {form.type==='business' && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              {inp('Business Name','business_name','text','Greenfield LLC')}
              {inp('EIN','ein','text','12-3456789')}
            </div>
          )}
          {form.type==='individual' && (
            <div style={{ marginBottom:12 }}>
              <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>Filing Status</label>
              <select value={form.filing_status} onChange={e => set('filing_status',e.target.value)} style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }}>
                <option value="">— Select —</option>
                {['Single','Married Filing Jointly','Married Filing Separately','Head of Household'].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            {inp('Address','address_line1','text','123 Main St')}
            {inp('City','city','text','Boston')}
            {inp('ZIP','zip','text','02101')}
            <div style={{ marginBottom:12 }}>
              <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>Stage</label>
              <select value={form.stage} onChange={e => set('stage',e.target.value)} style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }}>
                {STAGES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginBottom:16 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>Notes</label>
            <textarea value={form.notes} onChange={e => set('notes',e.target.value)} rows={2} placeholder="Internal notes about this client…"
              style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, boxSizing:'border-box' as const, outline:'none', resize:'vertical' as const }} />
          </div>
          {error && <div style={{ background:'#fdf0f0', color:'#b02020', padding:'9px 13px', borderRadius:8, fontSize:13, marginBottom:14 }}>{error}</div>}
          <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
            <button onClick={onClose} style={{ padding:'10px 18px', borderRadius:9, border:'1px solid #e2e8f4', background:'#f8faff', color:'#6a7a9a', cursor:'pointer', fontSize:13 }}>Cancel</button>
            <button onClick={save} disabled={saving} style={{ padding:'10px 24px', borderRadius:9, border:'none', background:saving?'#e2e8f4':'linear-gradient(135deg,#2D3278,#1a1f5e)', color:saving?'#9aaab0':'#fff', cursor:saving?'not-allowed':'pointer', fontSize:14, fontFamily:'Georgia,serif', fontWeight:700 }}>
              {saving?'Saving…':'Save Client'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
