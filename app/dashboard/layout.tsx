import { redirect } from 'next/navigation'
import { getUser, getRole } from '@/lib/supabase-server'
import Link from 'next/link'

export default async function FirmLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser()
  if (!user) redirect('/login')
  if (getRole(user) !== 'firm') redirect('/portal')
  const name = user.user_metadata?.full_name?.split(' ')[0] || 'Staff'

  return (
    <div style={{ minHeight:'100vh', background:'#f0f4fa' }}>
      <style>{`
        .navmenu { position:relative; }
        .navmenu > summary {
          list-style:none; cursor:pointer; padding:8px 12px; border-radius:8px;
          font-size:13px; color:rgba(255,255,255,0.7); user-select:none;
        }
        .navmenu > summary::-webkit-details-marker { display:none; }
        .navmenu[open] > summary { background:rgba(255,255,255,0.12); color:#fff; }
        .navmenu-itens {
          position:absolute; top:38px; left:0; min-width:230px; z-index:200;
          background:#fff; border-radius:12px; padding:6px;
          box-shadow:0 14px 40px rgba(15,35,64,0.28);
        }
        .navmenu-itens a {
          display:block; padding:10px 12px; border-radius:8px;
          font-size:14px; color:#0F2340; text-decoration:none;
        }
        .navmenu-itens a:hover { background:#F0F4FF; }
      `}</style>
      <nav style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', color:'#fff', padding:'0 24px', height:56, display:'flex', alignItems:'center', gap:4, boxShadow:'0 2px 16px rgba(45,50,120,0.4)', position:'sticky', top:0, zIndex:100 }}>
        <Link href="/dashboard" style={{ display:'flex', alignItems:'center', gap:8, textDecoration:'none', marginRight:12 }}>
          <img src="/logo.png" alt="Peace on Tax" style={{ height:32, width:'auto' }} />
        </Link>
        {[
          ['Dashboard',  '/dashboard'],
          ['Clients',    '/clients'],
          ['Bookkeeping','/dashboard/bookkeeping'],
          ['Invitations','/invitations'],
          ['Agenda',     '/dashboard/agenda'],
        ].map(([l,h]) => (
          <Link key={h} href={h} style={{ padding:'8px 12px', borderRadius:8, textDecoration:'none', fontSize:13, color:'rgba(255,255,255,0.7)' }}>{l}</Link>
        ))}

        {/* Listas — cadastros que valem para todos os clientes */}
        <details className="navmenu">
          <summary>Listas ▾</summary>
          <div className="navmenu-itens">
            <Link href="/dashboard/accounts">Plano de contas</Link>
            <Link href="/dashboard/payees">Fornecedores e clientes</Link>
            <Link href="/rules">Regras gerais</Link>
            <Link href="/team">Equipe</Link>
          </div>
        </details>

        {[
          ['Settings',   '/settings/users'],
          ['Conta',      '/dashboard/account'],
          ['Precos',     '/dashboard/pricing'],
        ].map(([l,h]) => (
          <Link key={h} href={h} style={{ padding:'8px 12px', borderRadius:8, textDecoration:'none', fontSize:13, color:'rgba(255,255,255,0.7)' }}>{l}</Link>
        ))}
        <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontSize:12, color:'rgba(255,255,255,0.6)' }}>{name}</span>
          <form action="/api/auth/logout" method="POST">
            <button type="submit" style={{ background:'rgba(255,255,255,0.1)', border:'1px solid rgba(255,255,255,0.2)', color:'rgba(255,255,255,0.7)', padding:'5px 12px', borderRadius:7, cursor:'pointer', fontSize:12 }}>Sign out</button>
          </form>
        </div>
      </nav>
      <main style={{ padding:'24px 28px', maxWidth:1400, margin:'0 auto' }}>{children}</main>
    </div>
  )
}




