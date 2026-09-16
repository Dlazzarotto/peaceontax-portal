import { redirect } from 'next/navigation'
import { getUser, getRole } from '@/lib/supabase-server'
import FirmNav from '@/components/FirmNav'

// Mesmo menu do resto da firma (components/FirmNav.tsx). Antes esta tela
// trazia um menu pela metade, com tres itens: quem entrava aqui perdia o
// caminho para Bookkeeping, Financeiro e Atendimento.

export default async function InvitationsLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser()
  if (!user) redirect('/login')
  if (getRole(user) !== 'firm') redirect('/portal')
  const name = user.user_metadata?.full_name?.split(' ')[0] || 'Staff'

  return (
    <div style={{ minHeight: '100vh', background: '#f0f4fa' }}>
      <FirmNav name={name} />
      <main className="fw-main">{children}</main>
      <style>{`
        .fw-main { padding:24px 28px; max-width:1200px; margin:0 auto; }
        @media (max-width:1099px) { .fw-main { padding:16px 14px; } }
      `}</style>
    </div>
  )
}
