import { getUser, supabaseServer } from '@/lib/supabase'

export default async function DashboardPage() {
  const user = await getUser()
  const sb = await supabaseServer()
  const { count: totalClients } = await sb.from('clients').select('*', { count: 'exact', head: true })
  const name = user?.user_metadata?.full_name?.split(' ')[0] || 'there'

  return (
    <div>
      <h1 style={{ fontFamily: 'Georgia, serif', fontSize: 24, color: '#0f2340', marginBottom: 8 }}>
        Good morning, {name} 👋
      </h1>
      <p style={{ color: '#6a7a9a', fontSize: 14, marginBottom: 28 }}>
        {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14 }}>
        {[
          { label: 'Active Clients', value: totalClients || 0, icon: '👥' },
          { label: 'Tax Season', value: '2024', icon: '📅' },
          { label: 'Portal', value: 'Online', icon: '✅' },
        ].map(s => (
          <div key={s.label} style={{ background: '#fff', borderRadius: 12, padding: '16px 18px', border: '1px solid #e2e8f4' }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>{s.icon}</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: '#0f2340', fontFamily: 'monospace' }}>{s.value}</div>
            <div style={{ fontSize: 12, color: '#6a7a9a', marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
