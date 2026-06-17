'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'

const STATES_US = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']

export default function InvitePage() {
  const { token } = useParams()
  const router    = useRouter()
  const [invite,  setInvite]  = useState<any>(null)
  const [status,  setStatus]  = useState<'loading'|'form'|'error'|'done'>('loading')
  const [step,    setStep]    = useState(1)
  const [error,   setError]   = useState('')
  const [saving,  setSaving]  = useState(false)
  const [form, setForm] = useState({ type:'individual', name:'', phone:'', address:'', city:'', state:'MA', zip:'', businessName:'', ein:'', entityType:'', industry:'', filingStatus:'', password:'', confirmPassword:'' })
  const set = (k: string, v: string) => setForm(p => ({...p, [k]: v}))

  useEffect(() => {
    fetch(`/api/invite/${token}`)
      .then(r => r.json())
      .then(d => { if (d.error) setStatus('error'); else { setInvite(d); setStatus('form') } })
  }, [token])

  const register = async () => {
    if (!form.name) { setError('Full name is required'); return }
    if (form.password.length < 8) { setError('Password must be at least 8 characters'); return }
    if (form.password !== form.confirmPassword) { setError('Passwords do not match'); return }
    setSaving(true); setError('')
    const res = await fetch(`/api/invite/${token}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ password:form.password, ...form }) })
    const d = await res.json()
    setSaving(false)
    if (d.error) { setError(d.error); return }
    setStatus('done')
    setTimeout(() => router.push('/portal'), 2000)
  }

  const inp = (label: string, key: string, type='text', ph='') => (
    <div style={{ marginBottom:12 }}>
      <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>{label}</label>
      <input type={type} value={(form as any)[key]} onChange={e => set(key, e.target.value)} placeholder={ph} style={{ width:'100%', padding:'10px 12px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, boxSizing:'border-box' as const, outline:'none' }} />
    </div>
  )

  const sel = (label: string, key: string, options: string[]) => (
    <div style={{ marginBottom:12 }}>
      <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>{label}</label>
      <select value={(form as any)[key]} onChange={e => set(key, e.target.value)} style={{ width:'100%', padding:'10px 12px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, outline:'none', background:'#fff' }}>
        <option value="">— Select —</option>
        {options.map(o => <option key={o}>{o}</option>)}
      </select>
    </div>
  )

  const wrap = (children: React.ReactNode) => (
    <div style={{ minHeight:'100vh', background:'linear-gradient(135deg,#2D3278,#1a1f5e)', display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'#fff', borderRadius:20, width:'100%', maxWidth:480, boxShadow:'0 30px 80px rgba(0,0,0,0.4)', overflow:'hidden' }}>
        <div style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', padding:'22px 28px', textAlign:'center' }}>
          <div style={{ fontSize:32, marginBottom:8 }}>📒</div>
          <div style={{ fontWeight:800, fontSize:18, color:'#fff', fontFamily:'Georgia,serif' }}>Peace on Tax</div>
          <div style={{ fontSize:12, color:'rgba(255,255,255,0.5)', marginTop:2 }}>Client Portal · Massachusetts</div>
        </div>
        <div style={{ padding:'24px 28px', fontFamily:'Georgia,serif' }}>{children}</div>
      </div>
    </div>
  )

  if (status === 'loading') return wrap(<p style={{ textAlign:'center', color:'#6a7a9a' }}>Validating invitation…</p>)
  if (status === 'error')   return wrap(<div style={{ textAlign:'center' }}><div style={{ fontSize:40, marginBottom:12 }}>⚠️</div><p style={{ color:'#b02020', fontWeight:700 }}>Invalid or expired invitation.</p><p style={{ color:'#6a7a9a', fontSize:13 }}>Please contact your accountant for a new one.</p></div>)
  if (status === 'done')    return wrap(<div style={{ textAlign:'center' }}><div style={{ fontSize:52, marginBottom:12 }}>🎉</div><h2 style={{ fontSize:20, color:'#1a6b4a' }}>Account Created!</h2><p style={{ color:'#6a7a9a' }}>Redirecting to your portal…</p></div>)

  return wrap(
    <div>
      <div style={{ display:'flex', justifyContent:'center', gap:8, marginBottom:24 }}>
        {[1,2,3].map(s => (
          <div key={s} style={{ display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:28, height:28, borderRadius:'50%', background:step>=s?'#2D3278':'#e2e8f4', color:step>=s?'#fff':'#9aaab0', display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:700 }}>
              {step>s?'✓':s}
            </div>
            {s < 3 && <div style={{ width:32, height:2, background:step>s?'#2D3278':'#e2e8f4' }} />}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div>
          <h2 style={{ fontSize:20, color:'#0f2340', marginBottom:4, textAlign:'center' }}>Welcome!</h2>
          <p style={{ color:'#6a7a9a', fontSize:13, textAlign:'center', marginBottom:24 }}>How will you be using the portal?</p>
          <div style={{ display:'flex', flexDirection:'column', gap:12, marginBottom:24 }}>
            {[{v:'individual',icon:'👤',label:'Individual / Personal',desc:'Personal tax returns, W-2, investments'},{v:'business',icon:'🏢',label:'Business',desc:'Business returns, bookkeeping, payroll'}].map(t => (
              <button key={t.v} onClick={() => set('type',t.v)} style={{ display:'flex', alignItems:'center', gap:14, padding:'16px 18px', borderRadius:12, border:form.type===t.v?'2px solid #2D3278':'1.5px solid #e2e8f4', background:form.type===t.v?'#f0f4ff':'#fff', cursor:'pointer', textAlign:'left' as const }}>
                <div style={{ fontSize:28 }}>{t.icon}</div>
                <div><div style={{ fontWeight:700, fontSize:15, color:'#0f2340' }}>{t.label}</div><div style={{ fontSize:12, color:'#6a7a9a', marginTop:2 }}>{t.desc}</div></div>
              </button>
            ))}
          </div>
          <button onClick={() => setStep(2)} style={{ width:'100%', padding:'13px', background:'linear-gradient(135deg,#2D3278,#1a1f5e)', color:'#fff', border:'none', borderRadius:10, fontSize:15, cursor:'pointer', fontWeight:700 }}>Continue →</button>
        </div>
      )}

      {step === 2 && (
        <div>
          <h2 style={{ fontSize:18, color:'#0f2340', marginBottom:4 }}>Your Information</h2>
          <p style={{ color:'#6a7a9a', fontSize:12, marginBottom:20 }}>This information will be used for your tax return.</p>
          {inp('Full Name *','name','text',form.type==='business'?'Owner full name':'John Smith')}
          {inp('Phone Number','phone','tel','(617) 555-0000')}
          {form.type==='business' && <>{inp('Business Name','businessName','text','Greenfield LLC')}{inp('EIN','ein','text','12-3456789')}{sel('Entity Type','entityType',['LLC','S-Corporation','C-Corporation','Sole Proprietor','Partnership','Non-Profit'])}{inp('Industry','industry','text','Real Estate')}</>}
          {form.type==='individual' && sel('Filing Status','filingStatus',['Single','Married Filing Jointly','Married Filing Separately','Head of Household','Qualifying Widow(er)'])}
          {inp('Address','address','text','123 Main St')}
          <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr', gap:8, marginBottom:16 }}>
            <div><label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>City</label><input value={form.city} onChange={e => set('city',e.target.value)} placeholder="Boston" style={{ width:'100%', padding:'10px 12px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, boxSizing:'border-box' as const, outline:'none' }} /></div>
            <div><label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>State</label><select value={form.state} onChange={e => set('state',e.target.value)} style={{ width:'100%', padding:'10px 8px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:13, outline:'none', background:'#fff' }}>{STATES_US.map(s => <option key={s}>{s}</option>)}</select></div>
            <div><label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }}>ZIP</label><input value={form.zip} onChange={e => set('zip',e.target.value)} placeholder="02101" style={{ width:'100%', padding:'10px 12px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, boxSizing:'border-box' as const, outline:'none' }} /></div>
          </div>
          <div style={{ display:'flex', gap:10 }}>
            <button onClick={() => setStep(1)} style={{ flex:1, padding:'12px', background:'#f0f4fa', border:'none', borderRadius:10, fontSize:14, cursor:'pointer', color:'#6a7a9a', fontWeight:700 }}>← Back</button>
            <button onClick={() => { if(!form.name){setError('Name is required');return} setError('');setStep(3) }} style={{ flex:2, padding:'12px', background:'linear-gradient(135deg,#2D3278,#1a1f5e)', color:'#fff', border:'none', borderRadius:10, fontSize:15, cursor:'pointer', fontWeight:700 }}>Continue →</button>
          </div>
          {error && <div style={{ color:'#b02020', fontSize:13, marginTop:10, textAlign:'center' }}>{error}</div>}
        </div>
      )}

      {step === 3 && (
        <div>
          <h2 style={{ fontSize:18, color:'#0f2340', marginBottom:4 }}>Create Password</h2>
          <p style={{ color:'#6a7a9a', fontSize:12, marginBottom:16 }}>Choose a secure password for your account.</p>
          <div style={{ background:'#f0f4fa', borderRadius:10, padding:'12px 14px', marginBottom:16, fontSize:13 }}>
            <strong style={{ color:'#0f2340' }}>{form.name}</strong>
            <span style={{ color:'#6a7a9a' }}> · {form.type==='business'?'🏢 Business':'👤 Individual'} · {invite?.clientEmail}</span>
          </div>
          {inp('Password (min 8 characters)','password','password','••••••••')}
          {inp('Confirm Password','confirmPassword','password','••••••••')}
          {error && <div style={{ background:'#fdf0f0', border:'1px solid #e0a0a0', color:'#b02020', padding:'9px 13px', borderRadius:8, fontSize:13, marginBottom:14 }}>{error}</div>}
          <div style={{ display:'flex', gap:10 }}>
            <button onClick={() => {setError('');setStep(2)}} style={{ flex:1, padding:'12px', background:'#f0f4fa', border:'none', borderRadius:10, fontSize:14, cursor:'pointer', color:'#6a7a9a', fontWeight:700 }}>← Back</button>
            <button onClick={register} disabled={saving} style={{ flex:2, padding:'12px', background:saving?'#e2e8f4':'linear-gradient(135deg,#2D3278,#1a1f5e)', color:saving?'#9aaab0':'#fff', border:'none', borderRadius:10, fontSize:15, cursor:saving?'not-allowed':'pointer', fontWeight:700 }}>
              {saving ? 'Creating account…' : 'Create My Account →'}
            </button>
          </div>
          <p style={{ textAlign:'center', fontSize:11, color:'#9aaab0', marginTop:14 }}>🔒 Secure encrypted access · Peace on Tax</p>
        </div>
      )}
    </div>
  )
}
