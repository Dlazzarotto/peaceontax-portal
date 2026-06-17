import { redirect } from 'next/navigation'
import { getUser, getRole } from '@/lib/supabase-server'
import Link from 'next/link'

export default async function ClientDetailLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser()
  if (!user) redirect('/login')
  if (getRole(user) !== 'firm') redirect('/portal')
  return (
    <div style={{ minHeight:'100vh', background:'#f0f4fa' }}>
      <nav style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', color:'#fff', padding:'0 24px', height:56, display:'flex', alignItems:'center', gap:20, boxShadow:'0 2px 16px rgba(45,50,120,0.4)' }}>
        <Link href="/dashboard" style={{ display:'flex', alignItems:'center', textDecoration:'none' }}>
          <img src="/logo.png" alt="Peace on Tax" style={{ height:30, width:'auto' }} />
        </Link>
        <Link href="/clients" style={{ color:'rgba(255,255,255,0.7)', textDecoration:'none', fontSize:13 }}>← Clients</Link>
      </nav>
      <main style={{ padding:'24px 28px', maxWidth:1280, margin:'0 auto' }}>{children}</main>
    </div>
  )
}
