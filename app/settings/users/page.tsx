'use client'
import { useState, useEffect } from 'react'

const ROLES = [
  { value:'admin',   label:'Admin',   color:'#b02020', bg:'#fdf0f0', desc:'Full access — manage users, settings, all clients' },
  { value:'manager', label:'Manager', color:'#5a1a8a', bg:'#f0e8ff', desc:'Manage clients, documents, invitations. Cannot manage users.' },
  { value:'staff',   label:'Staff',   color:'#1a3560', bg:'#e8f0ff', desc:'View and edit assigned clients only' },
  { value:'firm',    label:'Owner',   color:'#2D3278', bg:'#e8eaff', desc:'Firm owner — same as Admin' },
]

const getRoleStyle = (role: string) => ROLES.find(r => r.value === role) || ROLES[2]

export default function UsersPage() {
  const [users,       setUsers]       = useState<any[]>([])
  const [loading,     setLoading]     = useState(true)
  const [showNew,     setShowNew]     = useState(false)
  const [editing,     setEditing]     = useState<any|null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [resending,   setResending]   = useState<string|null>(null)

  const load = () => {
    setLoading(true)
    fetch('/api/firm/users').then(r => r.json()).then(d => { setUsers(d.users||[]); setLoading(false) })
  }
  useEffect(() => { load() }, [])

  const deactivate = async (userId: string, name: string) => {
    if (!confirm(`Deactivate ${name}? They will no longer be able to log in.`)) return
    await fetch(`/api/firm/users/${userId}`, { method:'DELETE' })
    load()
  }

  const reactivate = async (userId: string, name: string) => {
    if (!confirm(`Reactivate ${name}?`)) return
    await fetch(`/api/firm/users/${userId}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ reactivate:true }) })
    load()
  }

  const resendInvite = async (u: any) => {
    setResending(u.id)
    await fetch('/api/firm/users', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email:u.email, name:u.name, role:u.role, title:u.title, phone:u.phone }),
    })
    setResending(null)
    alert(`Invitation resent to ${u.email}!`)
  }

  const activeUsers   = users.filter(u => u.active)
  const inactiveUsers = users.filter(u => !u.active)
  const displayed     = showInactive ? users : activeUsers

  return (
    <div>
      {showNew && <UserModal onSave={() => { setShowNew(false); load() }} onClose={() => setShowNew(false)} />}
      {editing && <UserModal user={editing} onSave={() => { setEditing(null); load() }} onClose={() => setEditing(null)} />}

      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
        <div>
          <h1 style={{ fontFamily:'Georgia,serif', fontSize:24, color:'#0f2340', margin:'0 0 4px' }}>Team Members</h1>
          <p style={{ color:'#6a7a9a', fontSize:13, margin:0 }}>{activeUsers.length} active{inactiveUsers.length>0?` · ${inactiveUsers.length} inactive`:''}</p>
        </div>
        <div style={{ display:'flex', gap:10 }}>
          {inactiveUsers.length > 0 && (
            <button onClick={() => setShowInactive(!showInactive)} style={{ background:'#f0f4fa', border:'1px solid #e2e8f4', color:'#6a7a9a', padding:'9px 16px', borderRadius:9, cursor:'pointer', fontSize:13, fontWeight:700 }}>
              {showInactive?'Hide Inactive':`Show Inactive (${inactiveUsers.length})`}
            </button>
          )}
          <button onClick={() => setShowNew(true)} style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', color:'#fff', border:'none', padding:'10px 20px', borderRadius:10, fontSize:14, fontFamily:'Georgia,serif', fontWeight:700, cursor:'pointer' }}>
            + Add Team Member
          </button>
        </div>
      </div>

      {/* Role legend */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:24 }}>
        {ROLES.map(r => (
          <div key={r.value} style={{ background:'#fff', borderRadius:10, padding:'12px 14px', border:`1.5px solid ${r.color}20` }}>
            <span style={{ fontSize:11, padding:'2px 9px', borderRadius:20, fontWeight:700, background:r.bg, color:r.color }}>{r.label}</span>
            <div style={{ fontSize:11, color:'#6a7a9a', lineHeight:1.4, marginTop:6 }}>{r.desc}</div>
          </div>
        ))}
      </div>

      <div style={{ background:'#fff', borderRadius:14, border:'1px solid #e2e8f4', overflow:'hidden' }}>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'#6a7a9a' }}>Loading…</div>
        ) : displayed.length === 0 ? (
          <div style={{ padding:48, textAlign:'center', color:'#9aaab0' }}>
            <div style={{ fontSize:40, marginBottom:12 }}>👥</div>
            <div style={{ fontSize:14, marginBottom:16 }}>No team members yet</div>
            <button onClick={() => setShowNew(true)} style={{ background:'#2D3278', color:'#fff', border:'none', padding:'10px 20px', borderRadius:9, cursor:'pointer', fontSize:13, fontWeight:700 }}>Add First Member</button>
          </div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ background:'#f8faff' }}>
                {['Name','Email','Role','Title','Last Login','Status','Actions'].map(h => (
                  <th key={h} style={{ padding:'11px 16px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, borderBottom:'1.5px solid #e2e8f4' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map(u => {
                const rs = getRoleStyle(u.role)
                return (
                  <tr key={u.id} style={{ borderBottom:'1px solid #f0f4fa', opacity:u.active?1:0.6 }}>
                    <td style={{ padding:'12px 16px' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <div style={{ width:34, height:34, borderRadius:10, background:u.active?'linear-gradient(135deg,#2D3278,#1a1f5e)':'#e2e8f4', display:'flex', alignItems:'center', justifyContent:'center', color:u.active?'#fff':'#9aaab0', fontSize:14, fontWeight:700, flexShrink:0 }}>
                          {u.name?.charAt(0)?.toUpperCase()||'?'}
                        </div>
                        <div style={{ fontWeight:700, fontSize:14, color:'#1a2a3a' }}>{u.name}</div>
                      </div>
                    </td>
                    <td style={{ padding:'12px 16px', fontSize:13, color:'#6a7a9a' }}>{u.email}</td>
                    <td style={{ padding:'12px 16px' }}>
                      <span style={{ fontSize:11, padding:'3px 10px', borderRadius:20, fontWeight:700, background:rs.bg, color:rs.color }}>{rs.label}</span>
                    </td>
                    <td style={{ padding:'12px 16px', fontSize:13, color:'#6a7a9a' }}>{u.title||'—'}</td>
                    <td style={{ padding:'12px 16px', fontSize:12, color:'#9aaab0' }}>
                      {u.last_sign_in ? new Date(u.last_sign_in).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'Never'}
                    </td>
                    <td style={{ padding:'12px 16px' }}>
                      <span style={{ fontSize:11, padding:'3px 9px', borderRadius:20, fontWeight:700, background:u.active?'#e8f5ee':'#f0f4fa', color:u.active?'#1a6b4a':'#9aaab0' }}>
                        {u.active?'● Active':'○ Inactive'}
                      </span>
                    </td>
                    <td style={{ padding:'12px 16px' }}>
                      <div style={{ display:'flex', gap:6, flexWrap:'wrap' as const }}>
                        {u.active ? (
                          <>
                            <button onClick={() => setEditing(u)} style={{ fontSize:11, padding:'5px 10px', borderRadius:7, border:'1px solid #e2e8f4', background:'#f0f4ff', color:'#2D3278', cursor:'pointer', fontWeight:700 }}>✏️ Edit</button>
                            <button onClick={() => resendInvite(u)} disabled={resending===u.id} style={{ fontSize:11, padding:'5px 10px', borderRadius:7, border:'1px solid #e2e8f4', background:'#f0f4fa', color:'#1a6b4a', cursor:'pointer', fontWeight:700, opacity:resending===u.id?0.6:1 }}>
                              {resending===u.id?'…':'↻ Resend'}
                            </button>
                            <button onClick={() => deactivate(u.id,u.name)} style={{ fontSize:11, padding:'5px 10px', borderRadius:7, border:'1px solid #fdd', background:'#fff5f5', color:'#b02020', cursor:'pointer', fontWeight:700 }}>Deactivate</button>
                          </>
                        ) : (
                          <button onClick={() => reactivate(u.id,u.name)} style={{ fontSize:11, padding:'5px 10px', borderRadius:7, border:'1px solid #b0d8b0', background:'#e8f5ee', color:'#1a6b4a', cursor:'pointer', fontWeight:700 }}>↺ Reactivate</button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function UserModal({ user, onSave, onClose }: { user?: any; onSave: () => void; onClose: () => void }) {
  const isEdit = !!user
  const [form,   setForm]   = useState({ name:user?.name||'', email:user?.email||'', role:user?.role||'staff', title:user?.title||'', phone:user?.phone||'' })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')
  const [sent,   setSent]   = useState(false)
  const set = (k: string, v: string) => setForm(p => ({...p,[k]:v}))

  const save = async () => {
    if (!form.name || !form.email) { setError('Name and email are required'); return }
    setSaving(true); setError('')
    const url    = isEdit ? `/api/firm/users/${user.id}` : '/api/firm/users'
    const method = isEdit ? 'PATCH' : 'POST'
    const res    = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(form) })
    const d      = await res.json()
    setSaving(false)
    if (d.error) { setError(d.error); return }
    if (!isEdit) setSent(true)
    else onSave()
  }

  if (sent) return (
    <div style={{ position:'fixed', inset:0, background:'rgba(15,35,64,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:20 }}>
      <div style={{ background:'#fff', borderRadius:20, width:'100%', maxWidth:420, padding:'40px 36px', textAlign:'center', boxShadow:'0 30px 80px rgba(0,0,0,0.4)' }}>
        <div style={{ fontSize:52, marginBottom:12 }}>✉️</div>
        <h2 style={{ fontFamily:'Georgia,serif', fontSize:20, color:'#1a6b4a', marginBottom:8 }}>Invitation Sent!</h2>
        <p style={{ color:'#6a7a9a', fontSize:14, marginBottom:24 }}>
          An email was sent to <strong>{form.email}</strong> with a link to create their password.
        </p>
        <button onClick={onSave} style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', color:'#fff', border:'none', padding:'11px 28px', borderRadius:10, fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:'Georgia,serif' }}>Done</button>
      </div>
    </div>
  )

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(15,35,64,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:20 }}>
      <div style={{ background:'#fff', borderRadius:20, width:'100%', maxWidth:460, boxShadow:'0 30px 80px rgba(0,0,0,0.4)' }}>
        <div style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', padding:'18px 24px', borderRadius:'20px 20px 0 0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <h2 style={{ fontFamily:'Georgia,serif', fontSize:17, color:'#fff', margin:0 }}>{isEdit?'Edit Team Member':'Add Team Member'}</h2>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.15)', border:'none', color:'#fff', width:28, height:28, borderRadius:7, cursor:'pointer', fontSize:15 }}>✕</button>
        </div>
        <div style={{ padding:'22px 24px' }}>
          {!isEdit && (
            <div style={{ background:'#f0f4fa', borderRadius:10, padding:'12px 14px', marginBottom:16, fontSize:13, color:'#4a5a6a' }}>
              💡 An email will be sent with a link for them to create their own password.
            </div>
          )}

          {[['Full Name','name','text','Sarah Kim'],['Email Address','email','email','sarah@peaceontax.com'],['Job Title','title','text','Senior Accountant'],['Phone','phone','tel','(617) 555-0000']].map(([l,k,t,p]) => (
            <div key={k} style={{ marginBottom:14 }}>
              <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:5 }}>{l}{k==='name'||k==='email'?' *':''}</label>
              <input type={t} value={(form as any)[k]} onChange={e => set(k,e.target.value)} placeholder={p}
                disabled={isEdit && k==='email'}
                style={{ width:'100%', padding:'10px 13px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, boxSizing:'border-box' as const, outline:'none', background:isEdit&&k==='email'?'#f8faff':'#fff', color:isEdit&&k==='email'?'#9aaab0':'#1a2a3a' }} />
            </div>
          ))}

          <div style={{ marginBottom:16 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:5 }}>Access Level *</label>
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {ROLES.map(r => (
                <label key={r.value} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', borderRadius:9, border:form.role===r.value?`2px solid ${r.color}`:'1.5px solid #e2e8f4', background:form.role===r.value?r.bg:'#fff', cursor:'pointer' }}>
                  <input type="radio" name="role" value={r.value} checked={form.role===r.value} onChange={() => set('role',r.value)} style={{ accentColor:r.color }} />
                  <div>
                    <div style={{ fontWeight:700, fontSize:13, color:form.role===r.value?r.color:'#1a2a3a' }}>{r.label}</div>
                    <div style={{ fontSize:11, color:'#6a7a9a', marginTop:1 }}>{r.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {error && <div style={{ background:'#fdf0f0', color:'#b02020', padding:'9px 13px', borderRadius:8, fontSize:13, marginBottom:14 }}>{error}</div>}

          <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
            <button onClick={onClose} style={{ padding:'10px 18px', borderRadius:9, border:'1px solid #e2e8f4', background:'#f8faff', color:'#6a7a9a', cursor:'pointer', fontSize:13 }}>Cancel</button>
            <button onClick={save} disabled={saving} style={{ padding:'10px 24px', borderRadius:9, border:'none', background:saving?'#e2e8f4':'linear-gradient(135deg,#2D3278,#1a1f5e)', color:saving?'#9aaab0':'#fff', cursor:saving?'not-allowed':'pointer', fontSize:14, fontFamily:'Georgia,serif', fontWeight:700 }}>
              {saving?'Saving…':isEdit?'Update Member':'Send Invitation'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
