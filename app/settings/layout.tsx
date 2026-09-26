import { redirect } from 'next/navigation'
import { getUser, getRole } from '@/lib/supabase-server'
import { getStaffLevel } from '@/lib/staff-perms'
import Link from 'next/link'
import FirmNav from '@/components/FirmNav'

// Mesmo menu do resto da firma (components/FirmNav.tsx), mais a coluna
// lateral das configurações.

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser()
  if (!user) redirect('/login')
  if (getRole(user) !== 'firm') redirect('/portal')
  const name = user.user_metadata?.full_name?.split(' ')[0] || 'Staff'
  // O item Caixa (o livro da propria firma) so aparece para o socio.
  const socio = (await getStaffLevel(user.id)) === 'owner'

  return (
    <div style={{ minHeight: '100vh', background: '#f0f4fa' }}>
      <FirmNav name={name} socio={socio} />
      <div className="st-grade">
        <div style={{ background: '#fff', borderRadius: 12, padding: 14, border: '1px solid #e2e8f4', alignSelf: 'start' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6a7a9a', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10, padding: '0 4px' }}>Settings</div>
          <Link href="/settings/users" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, textDecoration: 'none', fontSize: 13, color: '#1a2a3a', marginBottom: 2 }}>
            👥 Team Members
          </Link>
        </div>
        <main>{children}</main>
      </div>
      <style>{`
        .st-grade { display:grid; grid-template-columns:200px 1fr; max-width:1200px; margin:0 auto; padding:24px 28px; gap:24px; }
        @media (max-width:820px) { .st-grade { grid-template-columns:1fr; padding:16px 14px; gap:14px; } }
      `}</style>
    </div>
  )
}
