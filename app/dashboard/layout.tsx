import { redirect } from 'next/navigation'
import { getUser, getRole } from '@/lib/supabase-server'

export default async function FirmLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser()
  if (!user) redirect('/login')
  if (getRole(user) !== 'firm') redirect('/portal')
  return (
    <div style={{ minHeight: '100vh', background: '#f0f4fa' }}>
      <nav style={{ background: '#0f2340', color: '#fff', padding: '0 24px', height: 56, display: 'flex', alignItems: 'center', gap: 20 }}>
        <span style={{ fontFamily: 'Georgia, serif', fontWeight: 700, fontSize: 16 }}>📒 Peace on Tax</span>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>Firm Dashboard</span>
      </nav>
      <main style={{ padding: '24px 28px', maxWidth: 1280, margin: '0 auto' }}>{children}</main>
    </div>
  )
}
