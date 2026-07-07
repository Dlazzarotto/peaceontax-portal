import { redirect } from 'next/navigation'
import { getUser, getRole, supabaseServer } from '@/lib/supabase-server'
import PortalNav from '@/components/PortalNav'
import ChatWidget from '@/components/portal/ChatWidget'

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser()
  if (!user) redirect('/login')
  if (getRole(user) !== 'client') redirect('/dashboard')

  const sb = await supabaseServer()
  const { data: client } = await sb
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
      <main style={{ padding:'24px 28px', maxWidth:1200, margin:'0 auto' }}>
        {children}
      </main>

      {/* Chat flutuante — só renderiza se tivermos o clientId */}
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
