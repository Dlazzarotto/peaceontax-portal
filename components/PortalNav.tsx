'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase-browser'
import { useState } from 'react'

export default function PortalNav({ userName, clientType }: { userName?: string; clientType?: string }) {
  const pathname = usePathname()
  const router   = useRouter()
  const [out, setOut] = useState(false)

  const signOut = async () => {
    setOut(true)
    await supabaseBrowser().auth.signOut()
    router.push('/login')
  }

  const links = [
    { href:'/portal',           label:'Home',          icon:'🏠' },
    { href:'/portal/documents', label:'Documents',     icon:'📁' },
    { href:'/portal/organizer', label:'Tax Organizer', icon:'📋' },
    { href:'/portal/messages',  label:'Messages',      icon:'💬' },
    { href:'/portal/payments',  label:'Payments',      icon:'💳' },
  ]

  return (
    <nav style={{ background:'linear-gradient(135deg,#2D3278,#1a1f5e)', color:'#fff', padding:'0 24px', height:56, display:'flex', alignItems:'center', gap:4, position:'sticky', top:0, zIndex:100, boxShadow:'0 2px 16px rgba(45,50,120,0.4)' }}>
      <Link href="/portal" style={{ display:'flex', alignItems:'center', gap:10, textDecoration:'none', marginRight:16, flexShrink:0 }}>
        <img src="/logo.png" alt="Peace on Tax" style={{ height:30, width:'auto' }} />
        <div style={{ fontSize:10, color:'rgba(255,255,255,0.45)' }}>
          {clientType==='business'?'🏢 Business':'👤 Individual'}
        </div>
      </Link>
      <div style={{ display:'flex', gap:2, flex:1 }}>
        {links.map(l => {
          const active = pathname===l.href || (l.href!=='/portal' && pathname.startsWith(l.href))
          return (
            <Link key={l.href} href={l.href} style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 12px', borderRadius:8, textDecoration:'none', fontSize:13, fontWeight:active?700:400, color:active?'#F47B20':'rgba(255,255,255,0.65)', background:active?'rgba(244,123,32,0.15)':'transparent', borderBottom:active?'2px solid #F47B20':'2px solid transparent' }}>
              <span style={{ fontSize:14 }}>{l.icon}</span>{l.label}
            </Link>
          )
        })}
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:10, flexShrink:0 }}>
        {userName && <span style={{ fontSize:12, color:'rgba(255,255,255,0.6)' }}>{userName}</span>}
        <button onClick={signOut} disabled={out} style={{ background:'rgba(255,255,255,0.1)', border:'1px solid rgba(255,255,255,0.2)', color:'rgba(255,255,255,0.7)', padding:'5px 12px', borderRadius:7, cursor:'pointer', fontSize:12, fontWeight:600 }}>
          {out?'…':'Sign out'}
        </button>
      </div>
    </nav>
  )
}
