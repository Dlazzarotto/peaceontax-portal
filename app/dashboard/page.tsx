import { getUser, supabaseServer } from '@/lib/supabase-server'
import Link from 'next/link'

const STAGE_COLOR: Record<string,string> = { 'Onboarding':'#6a7a9a','Gathering Docs':'#c06010','In Preparation':'#2D3278','Under Review':'#5a1a8a','Filed':'#1a6b4a','Complete':'#1a6b4a' }

export default async function DashboardPage() {
  const user = await getUser()
  const sb   = await supabaseServer()
  const [{ count: totalClients },{ count: pendingInvites },{ data: recentClients },{ data: stageCounts }] = await Promise.all([
    sb.from('clients').select('*',{count:'exact',head:true}).eq('active',true),
    sb.from('client_invitations').select('*',{count:'exact',head:true}).eq('status','sent'),
    sb.from('clients').select('id,name,type,stage,assignee').eq('active',true).order('created_at',{ascending:false}).limit(8),
    sb.from('clients').select('stage').eq('active',true),
  ])
  const name = user?.user_metadata?.full_name?.split(' ')[0] || 'there'
  const byStage = (s: string) => (stageCounts||[]).filter((c: any) => c.stage===s).length

  return (
    <div>
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontFamily:'Georgia,serif', fontSize:26, color:'#0f2340', margin:'0 0 4px' }}>Good morning, {name} 👋</h1>
        <p style={{ color:'#6a7a9a', fontSize:14, margin:0 }}>{new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}</p>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:14, marginBottom:24 }}>
        {[
          {label:'Active Clients',value:totalClients||0,icon:'👥',href:'/clients',color:'#2D3278'},
          {label:'Pending Invitations',value:pendingInvites||0,icon:'✉️',href:'/invitations',color:'#c06010'},
          {label:'In Preparation',value:byStage('In Preparation'),icon:'⚙️',href:'/clients',color:'#2D3278'},
          {label:'Filed This Season',value:byStage('Filed'),icon:'✅',href:'/clients',color:'#1a6b4a'},
        ].map(s => (
          <Link key={s.label} href={s.href} style={{textDecoration:'none'}}>
            <div style={{background:'#fff',borderRadius:14,padding:'16px 18px',border:'1px solid #e2e8f4',cursor:'pointer'}}>
              <div style={{fontSize:22,marginBottom:6}}>{s.icon}</div>
              <div style={{fontFamily:'monospace',fontSize:28,fontWeight:800,color:s.color}}>{s.value}</div>
              <div style={{fontSize:12,color:'#6a7a9a',marginTop:2}}>{s.label}</div>
            </div>
          </Link>
        ))}
      </div>
      <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:18}}>
        <div style={{background:'#fff',borderRadius:14,padding:20,border:'1px solid #e2e8f4'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
            <h2 style={{fontFamily:'Georgia,serif',fontSize:16,color:'#0f2340',margin:0}}>Recent Clients</h2>
            <Link href="/clients" style={{fontSize:12,color:'#6a7a9a',textDecoration:'none'}}>View CRM →</Link>
          </div>
          {(recentClients||[]).length===0 ? (
            <div style={{textAlign:'center',padding:'20px 0',color:'#9aaab0'}}>
              <div style={{fontSize:32,marginBottom:8}}>👥</div>
              <div style={{fontSize:13,marginBottom:12}}>No clients yet</div>
              <Link href="/invitations" style={{background:'#2D3278',color:'#fff',padding:'8px 18px',borderRadius:8,fontSize:12,fontWeight:700,textDecoration:'none'}}>Send First Invitation</Link>
            </div>
          ) : (recentClients||[]).map((c: any) => (
            <Link key={c.id} href={`/clients/${c.id}`} style={{textDecoration:'none'}}>
              <div style={{display:'flex',alignItems:'center',gap:10,padding:'9px 12px',borderRadius:10,background:'#f8faff',marginBottom:6}}>
                <div style={{width:32,height:32,borderRadius:8,background:c.type==='business'?'#2D327815':'#5a1a8a15',display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,flexShrink:0}}>{c.type==='business'?'🏢':'👤'}</div>
                <div style={{flex:1}}><div style={{fontSize:14,fontWeight:700,color:'#1a2a3a'}}>{c.name}</div><div style={{fontSize:11,color:'#6a7a9a'}}>{c.assignee||'—'}</div></div>
                <span style={{fontSize:11,padding:'2px 8px',borderRadius:20,fontWeight:700,color:STAGE_COLOR[c.stage]||'#6a7a9a',background:`${STAGE_COLOR[c.stage]||'#6a7a9a'}15`}}>{c.stage}</span>
              </div>
            </Link>
          ))}
        </div>
        <div style={{background:'#fff',borderRadius:14,padding:20,border:'1px solid #e2e8f4'}}>
          <h2 style={{fontFamily:'Georgia,serif',fontSize:16,color:'#0f2340',margin:'0 0 14px'}}>Quick Actions</h2>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {[
              {href:'/clients',label:'CRM Pipeline',icon:'🗂',desc:'Kanban + list view'},
              {href:'/invitations',label:'Send Invitation',icon:'✉️',desc:'Email or bulk CSV'},
            ].map(a => (
              <Link key={a.label} href={a.href} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 12px',borderRadius:9,background:'#f8faff',textDecoration:'none'}}>
                <span style={{fontSize:18}}>{a.icon}</span>
                <div><div style={{fontSize:13.5,fontWeight:700,color:'#1a2a3a'}}>{a.label}</div><div style={{fontSize:11,color:'#6a7a9a'}}>{a.desc}</div></div>
                <span style={{marginLeft:'auto',color:'#9aaab0'}}>→</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
