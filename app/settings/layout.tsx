import { redirect } from 'next/navigation'
import { getUser, getRole } from '@/lib/supabase-server'
import Link from 'next/link'

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser()
  if (!user) redirect('/login')
  if (getRole(user) !== 'firm') redirect('/portal')
  return (
    <div style={{ minHeight:'100vh', background:'#f0f4fa' }}>
      <nav style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', color:'#fff', padding:'0 24px', height:56, display:'flex', alignItems:'center', gap:20, boxShadow:'0 2px 16px rgba(45,50,120,0.4)' }}>
        <Link href="/dashboard" style={{ display:'flex', alignItems:'center', textDecoration:'none' }}>
          <img src="/logo.png" alt="Peace on Tax" style={{ height:30, width:'auto' }} />
        </Link>
        {[['Dashboard','/dashboard'],['Clients','/clients'],['Invitations','/invitations'],['Settings','/settings/users']].map(([l,h]) => (
          <Link key={h} href={h} style={{ textDecoration:'none', fontSize:13, color:'rgba(255,255,255,0.7)' }}>{l}</Link>
        ))}
      </nav>
      <div style={{ display:'grid', gridTemplateColumns:'200px 1fr', maxWidth:1200, margin:'0 auto', padding:'24px 28px', gap:24 }}>
        <div style={{ background:'#fff', borderRadius:12, padding:14, border:'1px solid #e2e8f4', alignSelf:'start' }}>
          <div style={{ fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase', letterSpacing:0.5, marginBottom:10, padding:'0 4px' }}>Settings</div>
          <Link href="/settings/users" style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', borderRadius:8, textDecoration:'none', fontSize:13, color:'#1a2a3a', marginBottom:2 }}>
            👥 Team Members
          </Link>
        </div>
        <main>{children}</main>
      </div>
    </div>
  )
}
