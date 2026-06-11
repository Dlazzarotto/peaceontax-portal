'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

const STAGES = ['Onboarding', 'Gathering Docs', 'In Preparation', 'Under Review', 'Filed', 'Complete']
const STAGE_COLORS: Record<string, string> = {
  'Onboarding':      '#6a7a9a',
  'Gathering Docs':  '#c06010',
  'In Preparation':  '#1a3560',
  'Under Review':    '#5a1a8a',
  'Filed':           '#1a6b4a',
  'Complete':        '#1a6b4a',
}

export default function ClientsPage() {
  const [clients, setClients]   = useState<any[]>([])
  const [loading, setLoading]   = useState(true)
  const [search,  setSearch]    = useState('')
  const [filter,  setFilter]    = useState('all')
  const [showNew, setShowNew]   = useState(false)

  const load = () => {
    setLoading(true)
    const q = new URLSearchParams()
    if (filter !== 'all') q.set('type', filter)
    if (search) q.set('search', search)
    fetch(`/api/clients?${q}`)
      .then(r => r.json())
      .then(d => { setClients(d.clients || []); setLoading(false) })
  }

  useEffect(() => { load() }, [filter, search])

  const stats = {
    total:      clients.length,
    individual: clients.filter(c => c.type === 'individual').length,
    business:   clients.filter(c => c.type === 'business').length,
    active:     clients.filter(c => c.stage !== 'Complete').length,
  }

  return (
    <div>
      {showNew && <NewClientModal onSave={() => { setShowNew(false); load() }} onClose={() => setShowNew(false)} />}

      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
        <div>
          <h1 style={{ fontFamily:'Georgia,serif', fontSize:24, color:'#0f2340', margin:'0 0 4px' }}>Clients</h1>
          <p style={{ color:'#6a7a9a', fontSize:13, margin:0 }}>{stats.total} total · {stats.individual} individual · {stats.business} business</p>
        </div>
        <button onClick={() => setShowNew(true)} style={{ background:'linear-gradient(135deg,#0f2340,#243f72)', color:'#fff', border:'none', padding:'10px 20px', borderRadius:10, fontSize:14, fontFamily:'Georgia,serif', fontWeight:700, cursor:'pointer' }}>
          + New Client
        </button>
      </div>

      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:20 }}>
        {[
          { label:'Total', value:stats.total, icon:'👥' },
          { label:'Individual', value:stats.individual, icon:'👤' },
          { label:'Business', value:stats.business, icon:'🏢' },
          { label:'Active', value:stats.active, icon:'⚡' },
        ].map(s => (
          <div key={s.label} style={{ background:'#fff', borderRadius:12, padding:'14px 16px', border:'1px solid #e2e8f4' }}>
            <div style={{ fontSize:20, marginBottom:6 }}>{s.icon}</div>
            <div style={{ fontSize:22, fontWeight:800, color:'#0f2340', fontFamily:'monospace' }}>{s.value}</div>
            <div style={{ fontSize:12, color:'#6a7a9a' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display:'flex', gap:10, marginBottom:16, alignItems:'center' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search clients…"
          style={{ flex:1, padding:'9px 14px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:13, outline:'none', fontFamily:'Georgia,serif' }} />
        {['all','individual','business'].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{ padding:'8px 16px', borderRadius:8, border:'none', cursor:'pointer', fontSize:12.5, fontWeight:700, background:filter===f?'#0f2340':'#e2e8f4', color:filter===f?'#fff':'#6a7a9a', textTransform:'capitalize' }}>{f}</button>
        ))}
      </div>

      {/* Client list */}
      <div style={{ background:'#fff', borderRadius:14, border:'1px solid #e2e8f4', overflow:'hidden' }}>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'#6a7a9a' }}>Loading clients…</div>
        ) : clients.length === 0 ? (
          <div style={{ padding:48, textAlign:'center', color:'#9aaab0' }}>
            <div style={{ fontSize:48, marginBottom:12 }}>👥</div>
            <div style={{ fontSize:16, fontWeight:700, color:'#0f2340', marginBottom:6 }}>No clients yet</div>
            <div style={{ fontSize:13, marginBottom:20 }}>Add your first client to get started</div>
            <button onClick={() => setShowNew(true)} style={{ background:'#0f2340', color:'#fff', border:'none', padding:'10px 24px', borderRadius:9, cursor:'pointer', fontSize:13, fontWeight:700 }}>+ Add First Client</button>
          </div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ background:'#f8faff' }}>
                {['Client','Type','Assignee','Stage','Documents','Actions'].map(h => (
                  <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase', letterSpacing:0.5, borderBottom:'1.5px solid #e2e8f4' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clients.map(c => (
                <tr key={c.id} style={{ borderBottom:'1px solid #f0f4fa' }}>
                  <td style={{ padding:'12px 16px' }}>
                    <div style={{ fontWeight:700, fontSize:14, color:'#1a2a3a' }}>{c.name}</div>
                    <div style={{ fontSize:11, color:'#6a7a9a' }}>{c.email}</div>
                    {c.phone && <div style={{ fontSize:11, color:'#9aaab0' }}>{c.phone}</div>}
                  </td>
                  <td style={{ padding:'12px 16px' }}>
                    <span style={{ fontSize:11, padding:'2px 9px', borderRadius:20, fontWeight:700, background:c.type==='business'?'#e8f0ff':'#f0e8ff', color:c.type==='business'?'#1a3560':'#5a1a8a' }}>
                      {c.type==='business'?'🏢 Business':'👤 Individual'}
                    </span>
                  </td>
                  <td style={{ padding:'12px 16px', fontSize:13, color:'#3a4a5a' }}>{c.assignee || '—'}</td>
                  <td style={{ padding:'12px 16px' }}>
                    <span style={{ fontSize:11, padding:'3px 10px', borderRadius:20, fontWeight:700, background:`${STAGE_COLORS[c.stage] || '#6a7a9a'}15`, color:STAGE_COLORS[c.stage] || '#6a7a9a' }}>{c.stage}</span>
                  </td>
                  <td style={{ padding:'12px 16px', fontSize:13, color:'#6a7a9a' }}>—</td>
                  <td style={{ padding:'12px 16px' }}>
                    <Link href={`/clients/${c.id}`} style={{ fontSize:12, fontWeight:700, color:'#0f2340', textDecoration:'none', background:'#f0f4fa', padding:'5px 12px', borderRadius:7, display:'inline-block' }}>
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function NewClientModal({ onSave, onClose }: { onSave: () => void; onClose: () => void }) {
  const [form, setForm] = useState({ name:'', email:'', phone:'', type:'individual', language:'en', assignee:'', stage:'Onboarding', business_name:'', ein:'', business_type:'', filing_status:'', address_line1:'', city:'', state:'MA', zip:'', notes:'' })
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

  const inp = (label: string, key: string, type = 'text', ph = '') => (
    <div style={{ marginBottom:12 }}>
      <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>{label}</label>
      <input type={type} value={(form as any)[key]} onChange={e => set(key, e.target.value)} placeholder={ph}
        style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, boxSizing:'border-box' as const, outline:'none', fontFamily:'Georgia,serif' }} />
    </div>
  )

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(15,35,64,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:20 }}>
      <div style={{ background:'#fff', borderRadius:20, width:'100%', maxWidth:560, maxHeight:'90vh', overflowY:'auto', boxShadow:'0 30px 80px rgba(0,0,0,0.4)' }}>
        <div style={{ background:'linear-gradient(135deg,#0f2340,#243f72)', padding:'20px 24px', borderRadius:'20px 20px 0 0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <h2 style={{ fontFamily:'Georgia,serif', fontSize:18, color:'#fff', margin:0 }}>New Client</h2>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.15)', border:'none', color:'#fff', width:30, height:30, borderRadius:8, cursor:'pointer', fontSize:16 }}>✕</button>
        </div>
        <div style={{ padding:'22px 24px' }}>

          {/* Type selector */}
          <div style={{ display:'flex', gap:8, marginBottom:18 }}>
            {[['individual','👤 Individual'],['business','🏢 Business']].map(([v,l]) => (
              <button key={v} onClick={() => set('type',v)} style={{ flex:1, padding:'10px', borderRadius:9, cursor:'pointer', border:form.type===v?'2px solid #0f2340':'1.5px solid #e2e8f4', background:form.type===v?'#0f2340':'#fff', color:form.type===v?'#fff':'#6a7a9a', fontFamily:'Georgia,serif', fontSize:13.5, fontWeight:700 }}>{l}</button>
            ))}
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:4 }}>
            {inp('Full Name *', 'name', 'text', form.type==='business'?'John Smith':'John Smith')}
            {inp('Email *', 'email', 'email', 'john@example.com')}
            {inp('Phone', 'phone', 'tel', '(617) 555-0000')}
            <div style={{ marginBottom:12 }}>
              <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>Assignee</label>
              <select value={form.assignee} onChange={e => set('assignee',e.target.value)} style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }}>
                <option value="">— Select —</option>
                {['David L.','Sarah K.','Maria R.'].map(a => <option key={a}>{a}</option>)}
              </select>
            </div>
          </div>

          {form.type === 'business' && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:4 }}>
              {inp('Business Name', 'business_name', 'text', 'Greenfield LLC')}
              {inp('EIN', 'ein', 'text', '12-3456789')}
              <div style={{ marginBottom:12 }}>
                <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>Entity Type</label>
                <select value={form.business_type} onChange={e => set('business_type',e.target.value)} style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }}>
                  <option value="">— Select —</option>
                  {['LLC','S-Corporation','C-Corporation','Sole Proprietor','Partnership','Non-Profit'].map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              {inp('Industry', 'industry', 'text', 'Real Estate')}
            </div>
          )}

          {form.type === 'individual' && (
            <div style={{ marginBottom:12 }}>
              <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>Filing Status</label>
              <select value={form.filing_status} onChange={e => set('filing_status',e.target.value)} style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }}>
                <option value="">— Select —</option>
                {['Single','Married Filing Jointly','Married Filing Separately','Head of Household','Qualifying Widow(er)'].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          )}

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:4 }}>
            {inp('Language', 'language')}
            <div style={{ marginBottom:12 }}>
              <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>Stage</label>
              <select value={form.stage} onChange={e => set('stage',e.target.value)} style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, outline:'none' }}>
                {STAGES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div style={{ marginBottom:4 }}>
            {inp('Address', 'address_line1', 'text', '123 Main St')}
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr', gap:12, marginBottom:12 }}>
            {inp('City', 'city', 'text', 'Boston')}
            {inp('State', 'state')}
            {inp('ZIP', 'zip', 'text', '02101')}
          </div>

          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>Notes</label>
            <textarea value={form.notes} onChange={e => set('notes',e.target.value)} rows={2} placeholder="Any notes about this client…"
              style={{ width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:13, boxSizing:'border-box' as const, outline:'none', resize:'vertical', fontFamily:'Georgia,serif' }} />
          </div>

          {error && <div style={{ background:'#fdf0f0', border:'1px solid #e0a0a0', color:'#b02020', padding:'9px 13px', borderRadius:8, fontSize:13, marginBottom:14 }}>{error}</div>}

          <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
            <button onClick={onClose} style={{ padding:'10px 20px', borderRadius:9, border:'1px solid #e2e8f4', background:'#f8faff', color:'#6a7a9a', cursor:'pointer', fontSize:13 }}>Cancel</button>
            <button onClick={save} disabled={saving} style={{ padding:'10px 24px', borderRadius:9, border:'none', background:saving?'#e2e8f4':'linear-gradient(135deg,#0f2340,#243f72)', color:saving?'#9aaab0':'#fff', cursor:saving?'not-allowed':'pointer', fontSize:14, fontFamily:'Georgia,serif', fontWeight:700 }}>
              {saving ? 'Saving…' : 'Save Client'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
