import { redirect } from 'next/navigation'
import { getUser, getRole } from '@/lib/supabase-server'

export default async function ClientDetailLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser()
  if (!user) redirect('/login')
  if (getRole(user) !== 'firm') redirect('/portal')
  return (
    <div style={{ minHeight:'100vh', background:'#f0f4fa' }}>
      <nav style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', color:'#fff', padding:'0 24px', height:56, display:'flex', alignItems:'center', gap:20, boxShadow:'0 2px 16px rgba(45,50,120,0.4)' }}>
        <a href="/dashboard" style={{ color:'#fff', textDecoration:'none', fontFamily:'Georgia,serif', fontWeight:800, fontSize:16, display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ width:28, height:28, background:'linear-gradient(135deg,#F47B20,#e06010)', borderRadius:7, display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:14 }}>📒</span>
          Peace on Tax
        </a>
        <a href="/clients" style={{ color:'rgba(255,255,255,0.7)', textDecoration:'none', fontSize:13 }}>← Clients</a>
      </nav>
      <main style={{ padding:'24px 28px', maxWidth:1280, margin:'0 auto' }}>{children}</main>
    </div>
  )
}
