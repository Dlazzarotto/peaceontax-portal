import BookkeepingAlertsCard from '@/components/BookkeepingAlertsCard'
import { getUser, supabaseServer } from '@/lib/supabase-server'
import Link from 'next/link'

const STAGE_COLOR: Record<string,string> = {
  'Onboarding':'#6a7a9a','Gathering Docs':'#c06010','In Preparation':'#2D3278',
  'Under Review':'#5a1a8a','Filed':'#1a6b4a','Complete':'#1a6b4a',
}

const MODE_LABEL: Record<string,string> = {
  video:'ðŸ“¹ VÃ­deo', phone:'ðŸ“ž Telefone', in_person:'ðŸ¢ Presencial',
}

export default async function DashboardPage() {
  const user = await getUser()
  const sb   = await supabaseServer()

  // --- Data de hoje em ET (America/New_York) ---
  const nowET   = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}))
  const todayET = new Date(nowET); todayET.setHours(0,0,0,0)
  const tmrwET  = new Date(todayET); tmrwET.setDate(tmrwET.getDate()+1)

  const [
    { count: totalClients },
    { count: pendingInvites },
    { count: docsToReview },
    { data: recentClients },
    { data: stageCounts },
    { data: todayBookings },
  ] = await Promise.all([
    sb.from('clients').select('*',{count:'exact',head:true}).eq('active',true),
    sb.from('client_invitations').select('*',{count:'exact',head:true}).eq('status','sent'),
    // Documentos classificados pela IA com confianÃ§a < 95% aguardando revisÃ£o
    sb.from('documents').select('*',{count:'exact',head:true})
      .not('ai_confidence','is',null)
      .lt('ai_confidence',0.95),
    sb.from('clients').select('id,name,type,stage,assignee')
      .eq('active',true).order('created_at',{ascending:false}).limit(8),
    sb.from('clients').select('stage').eq('active',true),
    // ReuniÃµes de hoje (ET)
    sb.from('bookings')
      .select('id,guest_name,guest_email,guest_phone,starts_at,notes,meeting_types(name,mode)')
      .eq('status','booked')
      .gte('starts_at', todayET.toISOString())
      .lt('starts_at',  tmrwET.toISOString())
      .order('starts_at'),
  ])

  const name    = user?.user_metadata?.full_name?.split(' ')[0] || 'there'
  const byStage = (s: string) => (stageCounts||[]).filter((c: any) => c.stage===s).length

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:true})

  const hour = nowET.getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  return (
    <div>
      {/* ---- CabeÃ§alho ---- */}
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontFamily:'Georgia,serif', fontSize:26, color:'#0f2340', margin:'0 0 4px' }}>
          {greeting}, {name} ðŸ‘‹
        </h1>
        <p style={{ color:'#6a7a9a', fontSize:14, margin:0 }}>
          {new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}
        </p>
      </div>

      {/* ---- Cards de estatÃ­stica ---- */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:14, marginBottom:24 }}>
        {[
          { label:'Active Clients',       value:totalClients||0,      icon:'ðŸ‘¥', href:'/clients',           color:'#2D3278' },
          { label:'Pending Invitations',  value:pendingInvites||0,    icon:'âœ‰ï¸',  href:'/invitations',       color:'#c06010' },
          { label:'In Preparation',       value:byStage('In Preparation'), icon:'âš™ï¸', href:'/clients',       color:'#2D3278' },
          { label:'Filed This Season',    value:byStage('Filed'),     icon:'âœ…', href:'/clients',            color:'#1a6b4a' },
        ].map(s => (
          <Link key={s.label} href={s.href} style={{ textDecoration:'none' }}>
            <div style={{ background:'#fff', borderRadius:14, padding:'16px 18px', border:'1px solid #e2e8f4', cursor:'pointer' }}>
              <div style={{ fontSize:22, marginBottom:6 }}>{s.icon}</div>
              <div style={{ fontFamily:'monospace', fontSize:28, fontWeight:800, color:s.color }}>{s.value}</div>
              <div style={{ fontSize:12, color:'#6a7a9a', marginTop:2 }}>{s.label}</div>
            </div>
          </Link>
        ))}
      </div>

      {/* ---- Alerta de documentos para revisar ---- */}
      {(docsToReview||0) > 0 && (
        <div style={{ background:'#fff8e8', border:'1.5px solid #e0b84a', borderRadius:12, padding:'12px 18px', marginBottom:18, display:'flex', alignItems:'center', gap:12 }}>
          <span style={{ fontSize:20 }}>âš ï¸</span>
          <div style={{ flex:1 }}>
            <span style={{ fontWeight:700, color:'#7a5a00', fontSize:14 }}>
              {docsToReview} documento{(docsToReview||0)>1?'s':''} classificado{(docsToReview||0)>1?'s':''} pela IA com confianÃ§a abaixo de 95% aguardando revisÃ£o.
            </span>
          </div>
          <Link href="/clients" style={{ fontSize:12, fontWeight:700, color:'#c06010', textDecoration:'none', whiteSpace:'nowrap' }}>
            Ver clientes â†’
          </Link>
        </div>
      )}

      {/* ---- Grid principal ---- */}
      <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:18 }}>

        {/* Recent Clients */}
        <div style={{ background:'#fff', borderRadius:14, padding:20, border:'1px solid #e2e8f4' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
            <h2 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:0 }}>Recent Clients</h2>
            <Link href="/clients" style={{ fontSize:12, color:'#6a7a9a', textDecoration:'none' }}>View CRM â†’</Link>
          </div>
          {(recentClients||[]).length===0 ? (
            <div style={{ textAlign:'center', padding:'20px 0', color:'#9aaab0' }}>
              <div style={{ fontSize:32, marginBottom:8 }}>ðŸ‘¥</div>
              <div style={{ fontSize:13, marginBottom:12 }}>No clients yet</div>
              <Link href="/invitations" style={{ background:'#2D3278', color:'#fff', padding:'8px 18px', borderRadius:8, fontSize:12, fontWeight:700, textDecoration:'none' }}>
                Send First Invitation
              </Link>
            </div>
          ) : (recentClients||[]).map((c: any) => (
            <Link key={c.id} href={`/clients/${c.id}`} style={{ textDecoration:'none' }}>
              <div style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 12px', borderRadius:10, background:'#f8faff', marginBottom:6 }}>
                <div style={{ width:32, height:32, borderRadius:8, background: c.type==='business'?'#2D327815':'#5a1a8a15', display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, flexShrink:0 }}>
                  {c.type==='business' ? 'ðŸ¢' : 'ðŸ‘¤'}
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:700, color:'#1a2a3a' }}>{c.name}</div>
                  <div style={{ fontSize:11, color:'#6a7a9a' }}>{c.assignee||'â€”'}</div>
                </div>
                <span style={{ fontSize:11, padding:'2px 8px', borderRadius:20, fontWeight:700, color:STAGE_COLOR[c.stage]||'#6a7a9a', background:`${STAGE_COLOR[c.stage]||'#6a7a9a'}15` }}>
                  {c.stage}
                </span>
              </div>
            </Link>
          ))}
        </div>

        {/* Painel direito */}
        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

          {/* Agenda de hoje */}
          <div style={{ background:'#fff', borderRadius:14, padding:20, border:'1px solid #e2e8f4' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
              <h2 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:0 }}>ðŸ“… Agenda de Hoje (ET)</h2>
              <Link href="/dashboard/agenda" style={{ fontSize:12, color:'#6a7a9a', textDecoration:'none' }}>Ver tudo â†’</Link>
            </div>
            {(todayBookings||[]).length===0 ? (
              <div style={{ textAlign:'center', padding:'14px 0', color:'#9aaab0' }}>
                <div style={{ fontSize:13 }}>Nenhuma reuniÃ£o hoje.</div>
                <Link href="/agendar" style={{ fontSize:12, color:'#2D3278', fontWeight:700, textDecoration:'none', display:'block', marginTop:6 }}>
                  ðŸ”— Link de agendamento
                </Link>
              </div>
            ) : (todayBookings||[]).map((b: any) => (
              <div key={b.id} style={{ padding:'10px 12px', borderRadius:10, background:'#f0f4ff', marginBottom:8, borderLeft:'3px solid #2D3278' }}>
                <div style={{ fontSize:13, fontWeight:700, color:'#2D3278' }}>
                  {fmtTime(b.starts_at)} Â· {b.meeting_types?.name ?? 'ReuniÃ£o'}
                </div>
                <div style={{ fontSize:12, color:'#4a5a6a', marginTop:2 }}>
                  ðŸ‘¤ {b.guest_name}
                  {b.guest_phone && <span> Â· ðŸ“± {b.guest_phone}</span>}
                </div>
                {b.notes && <div style={{ fontSize:11, color:'#6a7a9a', marginTop:2 }}>ðŸ’¬ {b.notes}</div>}
              </div>
            ))}
          </div>

          {/* Quick Actions */}
          <div style={{ background:'#fff', borderRadius:14, padding:20, border:'1px solid #e2e8f4' }}>
            <h2 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:'0 0 14px' }}>Quick Actions</h2>
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {[
                { href:'/clients',          label:'CRM Pipeline',     icon:'ðŸ—‚',  desc:'Kanban + list view' },
                { href:'/invitations',      label:'Send Invitation',  icon:'âœ‰ï¸',  desc:'Email or bulk CSV' },
                { href:'/dashboard/agenda', label:'Minha Agenda',     icon:'ðŸ“…',  desc:'ReuniÃµes e disponibilidade' },
                { href:'/agendar',          label:'Link de Agendamento', icon:'ðŸ”—', desc:'Compartilhar com clientes' },
              ].map(a => (
                <Link key={a.label} href={a.href} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 12px', borderRadius:9, background:'#f8faff', textDecoration:'none' }}>
                  <span style={{ fontSize:18 }}>{a.icon}</span>
                  <div>
                    <div style={{ fontSize:13.5, fontWeight:700, color:'#1a2a3a' }}>{a.label}</div>
                    <div style={{ fontSize:11, color:'#6a7a9a' }}>{a.desc}</div>
                  </div>
                  <span style={{ marginLeft:'auto', color:'#9aaab0' }}>â†’</span>
                </Link>
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}

