'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase-browser'
import { useState, useEffect } from 'react'

export default function PortalNav({ userName, clientType }: { userName?: string; clientType?: string }) {
  const pathname = usePathname()
  const router   = useRouter()
  const [out, setOut]   = useState(false)
  const [open, setOpen] = useState(false)

  // Fecha o menu ao trocar de página
  useEffect(() => { setOpen(false) }, [pathname])

  const signOut = async () => {
    setOut(true)
    await supabaseBrowser().auth.signOut()
    router.push('/login')
  }

  const ehEmpresa = clientType === 'business'

  const links = [
    { href:'/portal',           label:'Home',          icon:'🏠' },
    { href:'/portal/documents', label:'Documents',     icon:'📁' },
    { href:'/portal/organizer', label:'Tax Organizer', icon:'📋' },
    { href:'/portal/bank',      label:'Banks',         icon:'🏦' },
    // Contabilidade: P&L, Balanço e Fornecedores — só faz sentido para empresa
    ...(ehEmpresa ? [{ href:'/portal/reports', label:'Accounting', icon:'📊' }] : []),
    { href:'/portal/messages',  label:'Messages',      icon:'💬' },
    { href:'/portal/payments',  label:'Payments',      icon:'💳' },
  ]

  const isActive = (href: string) =>
    pathname === href || (href !== '/portal' && pathname.startsWith(href))

  return (
    <>
      <style>{`
        .ptnav {
          background: linear-gradient(135deg,#2D3278,#1a1f5e);
          color:#fff; padding:0 14px; min-height:58px;
          display:flex; align-items:center; gap:8px;
          position:sticky; top:0; z-index:100;
          box-shadow:0 2px 16px rgba(45,50,120,0.4);
        }
        .ptnav-logo { display:flex; align-items:center; gap:9px; text-decoration:none; flex-shrink:0; }
        .ptnav-type { font-size:10.5px; color:rgba(255,255,255,0.5); white-space:nowrap; }
        .ptnav-links { display:flex; gap:2px; flex:1; }
        .ptnav-link {
          display:flex; align-items:center; gap:6px; padding:8px 12px; border-radius:8px;
          text-decoration:none; font-size:13px; white-space:nowrap;
          color:rgba(255,255,255,0.68); border-bottom:2px solid transparent;
        }
        .ptnav-link.on { color:#F47B20; font-weight:700; background:rgba(244,123,32,0.15); border-bottom-color:#F47B20; }
        .ptnav-right { display:flex; align-items:center; gap:10px; flex-shrink:0; margin-left:auto; }
        .ptnav-user { font-size:12px; color:rgba(255,255,255,0.6); }
        .ptnav-signout {
          background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.22);
          color:rgba(255,255,255,0.85); padding:7px 13px; border-radius:8px;
          cursor:pointer; font-size:12.5px; font-weight:600;
        }
        .ptnav-burger { display:none; }

        /* ===== CELULAR ===== */
        @media (max-width: 820px) {
          .ptnav-links, .ptnav-user, .ptnav-right .ptnav-signout { display:none !important; }
          .ptnav-burger {
            display:flex; align-items:center; justify-content:center; gap:7px;
            background:rgba(255,255,255,0.12); border:1px solid rgba(255,255,255,0.25);
            color:#fff; border-radius:10px; padding:9px 14px; min-height:44px;
            font-size:14px; font-weight:700; cursor:pointer; margin-left:auto;
          }
          .ptnav-panel {
            position:fixed; top:58px; left:0; right:0; bottom:0;
            background:#1a1f5e; z-index:99; overflow-y:auto;
            padding:10px 14px 30px;
          }
          .ptnav-panel a, .ptnav-panel button {
            display:flex; align-items:center; gap:12px; width:100%;
            padding:16px 14px; margin-bottom:6px; border-radius:12px;
            font-size:16.5px; font-weight:600; text-decoration:none;
            color:rgba(255,255,255,0.9); background:rgba(255,255,255,0.07);
            border:none; cursor:pointer; text-align:left; min-height:56px;
            box-sizing:border-box;
          }
          .ptnav-panel a.on { background:rgba(244,123,32,0.22); color:#F9A76A; }
          .ptnav-panel .ptnav-panel-user {
            color:rgba(255,255,255,0.55); font-size:12.5px;
            padding:10px 14px 4px; background:none; display:block;
          }
        }
      `}</style>

      <nav className="ptnav">
        <Link href="/portal" className="ptnav-logo" onClick={() => setOpen(false)}>
          <img src="/logo.png" alt="Peace on Tax" style={{ height:30, width:'auto' }} />
          <span className="ptnav-type">{ehEmpresa ? '🏢 Business' : '👤 Individual'}</span>
        </Link>

        {/* Desktop */}
        <div className="ptnav-links">
          {links.map(l => (
            <Link key={l.href} href={l.href} className={`ptnav-link${isActive(l.href) ? ' on' : ''}`}>
              <span style={{ fontSize:14 }}>{l.icon}</span>{l.label}
            </Link>
          ))}
        </div>

        <div className="ptnav-right">
          {userName && <span className="ptnav-user">{userName}</span>}
          <button onClick={signOut} disabled={out} className="ptnav-signout">
            {out ? '…' : 'Sign out'}
          </button>
        </div>

        {/* Celular */}
        <button className="ptnav-burger" onClick={() => setOpen(o => !o)}
          aria-label="Menu" aria-expanded={open}>
          {open ? '✕' : '☰'} Menu
        </button>
      </nav>

      {open && (
        <div className="ptnav-panel">
          {userName && <span className="ptnav-panel-user">{userName}</span>}
          {links.map(l => (
            <Link key={l.href} href={l.href} className={isActive(l.href) ? 'on' : ''}
              onClick={() => setOpen(false)}>
              <span style={{ fontSize:20 }}>{l.icon}</span>{l.label}
            </Link>
          ))}
          <button onClick={signOut} disabled={out}
            style={{ marginTop:10, background:'rgba(255,255,255,0.14)' }}>
            <span style={{ fontSize:20 }}>🚪</span>{out ? 'Saindo…' : 'Sign out'}
          </button>
        </div>
      )}
    </>
  )
}
