import { redirect } from 'next/navigation'
import { getUser, getRole } from '@/lib/supabase-server'
import FirmNav from '@/components/FirmNav'

// Área da FIRMA (Peace on Tax). A área do cliente é /portal e tem layout
// próprio — nada daqui aparece para o cliente.
//
// O menu vive em components/FirmNav.tsx e é o MESMO nos quatro layouts da
// firma. Item novo entra lá, uma vez só.

export default async function FirmLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser()
  if (!user) redirect('/login')
  if (getRole(user) !== 'firm') redirect('/portal')
  const name = user.user_metadata?.full_name?.split(' ')[0] || 'Staff'

  return (
    <div style={{ minHeight: '100vh', background: '#f0f4fa' }}>
      <FirmNav name={name} />
      <main className="fw-main">{children}</main>
      <style>{`
        .fw-main { padding:24px 28px; max-width:1400px; margin:0 auto; }
        @media (max-width:1099px) { .fw-main { padding:16px 14px; } }
      `}</style>
    </div>
  )
}
