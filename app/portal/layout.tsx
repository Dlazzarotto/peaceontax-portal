import { redirect } from 'next/navigation'
import { getUser, getRole } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import PortalNav from '@/components/PortalNav'
import ChatWidget from '@/components/portal/ChatWidget'
import ForcePasswordChange from '@/components/ForcePasswordChange'

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser()
  if (!user) redirect('/login')
  if (getRole(user) !== 'client') redirect('/dashboard')

  // Service role para buscar dados do cliente (contorna RLS da tabela clients)
  const sbAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY!
  )
  const { data: client } = await sbAdmin
    .from('clients')
    .select('id, name, type, language')
    .eq('user_id', user.id)
    .single()

  const clientType = (client?.type as 'business' | 'individual') || 'individual'
  const userName   = client?.name || user.email?.split('@')[0] || 'Cliente'
  const lang       = client?.language || 'pt'
  const clientId   = client?.id || ''

  return (
    <div style={{ minHeight:'100vh', background:'#f0f4fa' }}>
      <PortalNav userName={userName} clientType={clientType} />
      <ForcePasswordChange />
      <main style={{ padding:'24px 28px', maxWidth:1200, margin:'0 auto' }}>
        {children}
      </main>

      {clientId && (
        <ChatWidget
          clientId={clientId}
          clientName={userName}
          lang={lang}
        />
      )}
    </div>
  )
}


