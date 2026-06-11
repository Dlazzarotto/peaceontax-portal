import { redirect } from 'next/navigation'
import { getUser, getRole } from '@/lib/supabase-server'

export default async function ClientDetailLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser()
  if (!user) redirect('/login')
  if (getRole(user) !== 'firm') redirect('/portal')
  return (
    <div style={{ minHeight:'100vh', background:'#f0f4fa' }}>
      <nav style={{ background:'#0f2340', color:'#fff', padding:'0 24px', height:56, display:'flex', alignItems:'center', gap:20 }}>
        <a href="/dashboard" style={{ color:'#fff', textDecoration:'none', fontFamily:'Georgia,serif', fontWeight:700, fontSize:16 }}>📒 Peace on Tax</a>
        <a href="/clients" style={{ color:'rgba(255,255,255,0.7)', textDecoration:'none', fontSize:13 }}>Clients</a>
      </nav>
      <main style={{ padding:'24px 28px', maxWidth:1280, margin:'0 auto' }}>{children}</main>
    </div>
  )
}
