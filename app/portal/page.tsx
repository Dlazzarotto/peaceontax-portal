import { getUser, supabaseServer } from '@/lib/supabase-server'
import Link from 'next/link'

const T: Record<string, any> = {
  en: { welcome: 'Welcome back', docs: 'My Documents', docsDesc: 'Upload and view your files', organizer: 'Tax Organizer', organizerDesc: 'Track your return status', payments: 'Payments', messages: 'Messages', messagesDesc: 'Chat with your accountant', noBalance: 'No balance due', taxYear: 'Tax Year 2024' },
  pt: { welcome: 'Bem-vindo de volta', docs: 'Meus Documentos', docsDesc: 'Envie e visualize seus arquivos', organizer: 'Organizador Fiscal', organizerDesc: 'Acompanhe o status da sua declaração', payments: 'Pagamentos', messages: 'Mensagens', messagesDesc: 'Converse com seu contador', noBalance: 'Sem saldo pendente', taxYear: 'Ano Fiscal 2024' },
  es: { welcome: 'Bienvenido de nuevo', docs: 'Mis Documentos', docsDesc: 'Suba y vea sus archivos', organizer: 'Organizador Fiscal', organizerDesc: 'Rastree el estado de su declaración', payments: 'Pagos', messages: 'Mensajes', messagesDesc: 'Hable con su contador', noBalance: 'Sin saldo pendiente', taxYear: 'Año Fiscal 2024' },
  zh: { welcome: '欢迎回来', docs: '我的文件', docsDesc: '上传和查看您的文件', organizer: '税务组织器', organizerDesc: '跟踪您的申报状态', payments: '付款', messages: '消息', messagesDesc: '与您的会计师聊天', noBalance: '无未结余额', taxYear: '2024税务年度' },
}

export default async function PortalPage() {
  const user = await getUser()
  const sb   = await supabaseServer()

  const { data: client } = await sb
    .from('clients')
    .select('*')
    .eq('user_id', user!.id)
    .single()

  const { data: docs } = await sb
    .from('documents')
    .select('id, file_name, status, created_at, category')
    .eq('client_id', client?.id || '')
    .order('created_at', { ascending: false })
    .limit(5)

  const lang    = (client?.language || 'en') as string
  const t       = T[lang] || T.en
  const firstName = client?.name?.split(' ')[0] || 'there'
  const balance   = client?.balance || 0

  const quickLinks = [
    { href: '/portal/documents', icon: '📁', label: t.docs,       desc: t.docsDesc,       count: docs?.length || 0 },
    { href: '/portal/organizer', icon: '📋', label: t.organizer,  desc: client?.stage || 'Onboarding', badge: client?.stage },
    { href: '/portal/payments',  icon: '💳', label: t.payments,   desc: balance > 0 ? `$${balance.toLocaleString()} due` : t.noBalance, highlight: balance > 0 },
    { href: '/portal/messages',  icon: '💬', label: t.messages,   desc: t.messagesDesc },
  ]

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 26, color: '#0f2340', margin: '0 0 4px' }}>
          {t.welcome}, {firstName}! 👋
        </h1>
        <p style={{ color: '#6a7a9a', fontSize: 14, margin: 0 }}>
          {client?.type === 'business' ? '🏢' : '👤'} {client?.name} · {t.taxYear}
        </p>
      </div>

      {/* Quick links */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14, marginBottom: 28 }}>
        {quickLinks.map(l => (
          <Link key={l.href} href={l.href} style={{ textDecoration: 'none' }}>
            <div style={{ background: l.highlight ? 'linear-gradient(135deg,#2D3278,#1a1f5e)' : '#fff', borderRadius: 14, padding: '18px 20px', border: l.highlight ? 'none' : '1px solid #e2e8f4', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14, transition: 'all 0.15s' }}>
              <div style={{ width: 46, height: 46, borderRadius: 12, background: l.highlight ? 'rgba(255,255,255,0.15)' : '#f0f4fa', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>
                {l.icon}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: l.highlight ? '#fff' : '#1a2a3a' }}>{l.label}</div>
                <div style={{ fontSize: 12, color: l.highlight ? 'rgba(255,255,255,0.7)' : '#6a7a9a', marginTop: 2 }}>{l.desc}</div>
              </div>
              <span style={{ color: l.highlight ? 'rgba(255,255,255,0.6)' : '#9aaab0', fontSize: 16 }}>→</span>
            </div>
          </Link>
        ))}
      </div>

      {/* Recent documents */}
      <div style={{ background: '#fff', borderRadius: 14, padding: 20, border: '1px solid #e2e8f4' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 16, color: '#0f2340', margin: 0 }}>Recent Documents</h2>
          <Link href="/portal/documents" style={{ fontSize: 12, color: '#6a7a9a', textDecoration: 'none' }}>View all →</Link>
        </div>
        {(!docs || docs.length === 0) ? (
          <div style={{ textAlign: 'center', padding: '24px 0', color: '#9aaab0' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📁</div>
            <div style={{ fontSize: 13, marginBottom: 12 }}>No documents yet</div>
            <Link href="/portal/documents" style={{ background: '#2D3278', color: '#fff', padding: '8px 18px', borderRadius: 8, fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>Upload First Document</Link>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {docs.map((doc: any) => (
              <div key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px', borderRadius: 10, background: '#f8faff' }}>
                <span style={{ fontSize: 18 }}>📄</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: '#1a2a3a' }}>{doc.file_name}</div>
                  <div style={{ fontSize: 11, color: '#6a7a9a' }}>{doc.category}</div>
                </div>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, fontWeight: 700, background: doc.status === 'approved' ? '#e8f5ee' : '#f0f4fa', color: doc.status === 'approved' ? '#1a6b4a' : '#6a7a9a' }}>{doc.status}</span>
                <span style={{ fontSize: 11, color: '#9aaab0' }}>{new Date(doc.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
