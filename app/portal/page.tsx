import { getUser, supabaseServer } from '@/lib/supabase-server'
import Link from 'next/link'

export default async function PortalPage() {
  const user = await getUser()
  const sb = await supabaseServer()
  const { data: client } = await sb.from('clients').select('*').eq('user_id', user!.id).single()
  const name = client?.name?.split(' ')[0] || 'there'

  return (
    <div>
      <h1 style={{ fontFamily: 'Georgia, serif', fontSize: 24, color: '#0f2340', marginBottom: 6 }}>
        Welcome back, {name}!
      </h1>
      <p style={{ color: '#6a7a9a', fontSize: 14, marginBottom: 28 }}>
        {client?.type === 'business' ? '🏢' : '👤'} {client?.name} · Tax Year 2024
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {[
          { href: '/portal/documents', icon: '📁', label: 'My Documents', desc: 'Upload and view files' },
          { href: '/portal/organizer', icon: '📋', label: 'Tax Organizer', desc: 'Complete your intake' },
          { href: '/portal/payments', icon: '💳', label: 'Payments', desc: client?.balance > 0 ? `$${client.balance} due` : 'No balance due' },
          { href: '/portal/messages', icon: '💬', label: 'Messages', desc: `Accountant: ${client?.assignee || '—'}` },
        ].map(l => (
          <Link key={l.href} href={l.href} style={{ textDecoration: 'none' }}>
            <div style={{ background: '#fff', borderRadius: 12, padding: '18px 20px', border: '1px solid #e2e8f4', display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer' }}>
              <div style={{ fontSize: 24, width: 44, height: 44, background: '#f0f4fa', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{l.icon}</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#1a2a3a' }}>{l.label}</div>
                <div style={{ fontSize: 12, color: '#6a7a9a', marginTop: 2 }}>{l.desc}</div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
