import { redirect } from 'next/navigation'
import { getUser, getRole } from '@/lib/supabase-server'
import Link from 'next/link'

// Menu da FIRMA (Peace on Tax). A área do cliente é /portal e tem
// layout próprio — nada daqui aparece para o cliente.
//
// No computador: barra horizontal, como sempre foi.
// No celular (< 1100px): sanfona sob o botão Menu. Sem JavaScript,
// usando <details> — este é um Server Component e não pode ter estado.

const ITENS_1: [string, string][] = [
  ['Dashboard',   '/dashboard'],
  ['Clients',     '/clients'],
  ['Bookkeeping', '/dashboard/bookkeeping'],
  ['Invitations', '/invitations'],
  ['Agenda',      '/dashboard/agenda'],
  ['Financeiro',  '/dashboard/billing'],
  ['Atendimento', '/dashboard/atendimento'],
]

const LISTAS: [string, string][] = [
  ['Plano de contas',        '/dashboard/accounts'],
  ['Fornecedores e clientes','/dashboard/payees'],
  ['Regras gerais',          '/rules'],
  ['Equipe',                 '/team'],
]

const ITENS_2: [string, string][] = [
  ['Settings', '/settings/users'],
  ['Conta',    '/dashboard/account'],
  ['Precos',   '/dashboard/pricing'],
]

export default async function FirmLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser()
  if (!user) redirect('/login')
  if (getRole(user) !== 'firm') redirect('/portal')
  const name = user.user_metadata?.full_name?.split(' ')[0] || 'Staff'

  return (
    <div className="fw">
      <style>{CSS}</style>

      <nav className="fw-nav">
        <Link href="/dashboard" className="fw-marca">
          <img src="/logo.png" alt="Peace on Tax" />
        </Link>

        <details className="fw-menu">
          <summary className="fw-abrir" aria-label="Abrir menu">☰<span>Menu</span></summary>

          <div className="fw-itens">
            {ITENS_1.map(([l, h]) => (
              <Link key={h} href={h} className="fw-link">{l}</Link>
            ))}

            <details className="fw-sub">
              <summary className="fw-link fw-sub-abrir">Listas ▾</summary>
              <div className="fw-sub-itens">
                {LISTAS.map(([l, h]) => (
                  <Link key={h} href={h}>{l}</Link>
                ))}
              </div>
            </details>

            {ITENS_2.map(([l, h]) => (
              <Link key={h} href={h} className="fw-link">{l}</Link>
            ))}

            {/* No celular a saída fica dentro da sanfona, ao alcance do polegar */}
            <form action="/api/auth/logout" method="POST" className="fw-sair-mobile">
              <button type="submit">Sign out</button>
            </form>
          </div>
        </details>

        <div className="fw-usuario">
          <span className="fw-nome">{name}</span>
          <form action="/api/auth/logout" method="POST">
            <button type="submit" className="fw-sair">Sign out</button>
          </form>
        </div>
      </nav>

      <main className="fw-main">{children}</main>
    </div>
  )
}

const CSS = `
.fw { min-height:100vh; background:#f0f4fa; }
.fw-nav {
  background:linear-gradient(135deg,#2D3278,#1a1f5e); color:#fff;
  padding:0 16px; min-height:60px; display:flex; align-items:center; gap:6px;
  box-shadow:0 2px 16px rgba(45,50,120,0.4); position:sticky; top:0; z-index:100;
}
.fw-marca { display:flex; align-items:center; text-decoration:none; margin-right:8px; }
.fw-marca img { height:34px; width:auto; }
.fw-menu { position:relative; }
.fw-menu > summary::-webkit-details-marker { display:none; }
.fw-abrir {
  list-style:none; cursor:pointer; display:flex; align-items:center; gap:8px;
  min-height:48px; padding:0 14px; border-radius:10px;
  font-size:16px; font-weight:700; color:#fff; user-select:none;
  background:rgba(255,255,255,0.12);
}
.fw-menu[open] > .fw-abrir { background:rgba(255,255,255,0.22); }
.fw-link {
  display:block; text-decoration:none; border-radius:10px;
  padding:12px 14px; min-height:48px; line-height:24px;
  font-size:16px; color:#0F2340;
}
.fw-usuario { margin-left:auto; display:flex; align-items:center; gap:10px; }
.fw-nome { font-size:14px; color:rgba(255,255,255,0.75); }
.fw-sair {
  background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.25);
  color:#fff; padding:10px 16px; border-radius:8px; cursor:pointer;
  font-size:14px; min-height:44px;
}
.fw-main { padding:24px 28px; max-width:1400px; margin:0 auto; }

/* ── Celular e tablet: sanfona ───────────────────────────── */
@media (max-width:1099px) {
  .fw-itens {
    position:absolute; top:56px; left:0; z-index:200;
    width:min(88vw,340px); max-height:calc(100vh - 120px); overflow-y:auto;
    background:#fff; border-radius:14px; padding:8px;
    box-shadow:0 14px 40px rgba(15,35,64,0.30);
    display:flex; flex-direction:column; gap:2px;
  }
  .fw-link:active, .fw-sub-itens a:active { background:#F0F4FF; }
  .fw-sub-abrir { list-style:none; cursor:pointer; font-weight:700; }
  .fw-sub-abrir::-webkit-details-marker { display:none; }
  .fw-sub-itens { display:flex; flex-direction:column; padding-left:10px; }
  .fw-sub-itens a {
    padding:12px 14px; min-height:48px; line-height:24px;
    border-radius:10px; font-size:16px; color:#0F2340; text-decoration:none;
  }
  .fw-sair-mobile { margin-top:8px; border-top:1px solid #e3e8f5; padding-top:8px; }
  .fw-sair-mobile button {
    width:100%; min-height:48px; border-radius:10px; cursor:pointer;
    background:#fff; border:2px solid #2D3278; color:#2D3278;
    font-size:16px; font-weight:700;
  }
  .fw-usuario .fw-sair { display:none; }
  .fw-nome { display:none; }
  .fw-main { padding:16px 14px; }
}

/* ── Computador: barra horizontal, como era ──────────────── */
@media (min-width:1100px) {
  .fw-abrir { display:none; }
  .fw-menu { position:static; }
  .fw-itens { display:flex; align-items:center; gap:2px; }
  .fw-link { color:rgba(255,255,255,0.78); font-size:14px; padding:9px 12px; min-height:0; }
  .fw-link:hover { background:rgba(255,255,255,0.12); color:#fff; }
  .fw-sub { position:relative; }
  .fw-sub-abrir { list-style:none; cursor:pointer; }
  .fw-sub-abrir::-webkit-details-marker { display:none; }
  .fw-sub[open] > .fw-sub-abrir { background:rgba(255,255,255,0.12); color:#fff; }
  .fw-sub-itens {
    position:absolute; top:42px; left:0; min-width:240px; z-index:200;
    background:#fff; border-radius:12px; padding:6px;
    box-shadow:0 14px 40px rgba(15,35,64,0.28);
  }
  .fw-sub-itens a {
    display:block; padding:10px 12px; border-radius:8px;
    font-size:14px; color:#0F2340; text-decoration:none;
  }
  .fw-sub-itens a:hover { background:#F0F4FF; }
  .fw-sair-mobile { display:none; }
}
`
