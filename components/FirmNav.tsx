'use client'
// Menu da FIRMA (Peace on Tax), num lugar só.
//
// Antes existia copiado em quatro layouts (dashboard, clients, invitations,
// settings) — e três deles traziam um menu pela metade, com três itens. Quem
// entrava em Clients perdia o caminho para Bookkeeping, Financeiro e o resto.
//
// Duas estruturas INDEPENDENTES, cada uma escondida na largura da outra:
//   .fw-desk  → computador (>= 1100px): barra horizontal sempre visível
//   .fw-mob   → celular/tablet (< 1100px): sanfona sob o botão ☰ Menu
//
// É um client component, e não mais um <details> nativo, por um motivo: a
// navegação do App Router não recarrega a página, então o <details> ficava
// ABERTO depois de escolher o item e só fechava clicando no ☰ de novo.
// Aqui a escolha fecha o menu, e a troca de rota também.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useEffect, useRef } from 'react'

const ITENS_1: [string, string][] = [
  ['Dashboard',   '/dashboard'],
  ['Clients',     '/clients'],
  ['Bookkeeping', '/dashboard/bookkeeping'],
  ['Invitations', '/invitations'],
  ['Agenda',      '/dashboard/agenda'],
  ['Financeiro',  '/dashboard/billing'],
  ['Atendimento', '/dashboard/atendimento'],
]

// O caixa da PROPRIA firma so existe para o socio -- a rota recusa qualquer
// outro nivel. Oferecer o item a quem vai levar 403 e oferecer o que nao se
// pode fazer, o mesmo defeito ja corrigido no seletor de cliente da fatura.
const CAIXA: [string, string] = ['Caixa', '/dashboard/caixa']

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

export default function FirmNav({ name, socio }: { name?: string; socio?: boolean }) {
  const pathname = usePathname()
  const itens1 = socio ? [...ITENS_1, CAIXA] : ITENS_1
  const [menu, setMenu] = useState(false)
  const [listas, setListas] = useState(false)
  const [listasMob, setListasMob] = useState(false)
  const caixaListas = useRef<HTMLDivElement>(null)

  // Trocou de rota: tudo fecha. Não basta — clicar no item da página em que já
  // se está não muda o pathname, então o clique também fecha (abaixo).
  useEffect(() => { setMenu(false); setListas(false); setListasMob(false) }, [pathname])

  // Computador: clicar fora fecha o "Listas ▾", como qualquer menu suspenso
  useEffect(() => {
    if (!listas) return
    const fora = (e: MouseEvent) => {
      if (caixaListas.current && !caixaListas.current.contains(e.target as Node)) setListas(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setListas(false) }
    document.addEventListener('mousedown', fora)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', fora); document.removeEventListener('keydown', esc) }
  }, [listas])

  const fechar = () => { setMenu(false); setListas(false); setListasMob(false) }

  // Item ativo: /dashboard só casa exato (senão acenderia em toda subpágina)
  const ativo = (href: string) =>
    pathname === href || (href !== '/dashboard' && pathname.startsWith(href + '/'))

  const link = (l: string, h: string, cls = 'fw-link') => (
    <Link key={h} href={h} className={`${cls}${ativo(h) ? ' on' : ''}`} onClick={fechar}>{l}</Link>
  )

  return (
    <nav className="fw-nav" aria-label="Menu da firma">
      <style>{CSS}</style>

      <Link href="/dashboard" className="fw-marca" onClick={fechar}>
        <img src="/logo.png" alt="Peace on Tax" />
      </Link>

      {/* ── Computador: barra sempre visível ── */}
      <div className="fw-desk">
        {itens1.map(([l, h]) => link(l, h))}

        <div className="fw-sub" ref={caixaListas}>
          <button type="button" className={`fw-link fw-sub-abrir${listas ? ' on' : ''}`}
            aria-expanded={listas} onClick={() => setListas(v => !v)}>
            Listas ▾
          </button>
          {listas && (
            <div className="fw-sub-itens">
              {LISTAS.map(([l, h]) => link(l, h, 'fw-sub-item'))}
            </div>
          )}
        </div>

        {ITENS_2.map(([l, h]) => link(l, h))}
      </div>

      {/* ── Celular e tablet: sanfona ── */}
      <div className="fw-mob">
        <button type="button" className={`fw-abrir${menu ? ' on' : ''}`}
          aria-expanded={menu} aria-label="Abrir menu" onClick={() => setMenu(v => !v)}>
          {menu ? '✕' : '☰'}<span>Menu</span>
        </button>

        {menu && (
          <div className="fw-itens">
            {itens1.map(([l, h]) => link(l, h))}

            <button type="button" className={`fw-link fw-sub-abrir${listasMob ? ' on' : ''}`}
              aria-expanded={listasMob} onClick={() => setListasMob(v => !v)}>
              Listas ▾
            </button>
            {listasMob && (
              <div className="fw-sub-itens">
                {LISTAS.map(([l, h]) => link(l, h, 'fw-sub-item'))}
              </div>
            )}

            {ITENS_2.map(([l, h]) => link(l, h))}

            {/* No celular a saída fica dentro da sanfona, ao alcance do polegar */}
            <form action="/api/auth/logout" method="POST" className="fw-sair-mobile">
              <button type="submit">Sign out</button>
            </form>
          </div>
        )}
      </div>

      <div className="fw-usuario">
        {name && <span className="fw-nome">{name}</span>}
        <form action="/api/auth/logout" method="POST">
          <button type="submit" className="fw-sair">Sign out</button>
        </form>
      </div>
    </nav>
  )
}

const CSS = `
.fw-nav {
  background:linear-gradient(135deg,#2D3278,#1a1f5e); color:#fff;
  padding:0 16px; min-height:60px; display:flex; align-items:center; gap:6px;
  box-shadow:0 2px 16px rgba(45,50,120,0.4); position:sticky; top:0; z-index:100;
}
.fw-marca { display:flex; align-items:center; text-decoration:none; margin-right:8px; }
.fw-marca img { height:34px; width:auto; }
.fw-usuario { margin-left:auto; display:flex; align-items:center; gap:10px; }
.fw-nome { font-size:14px; color:rgba(255,255,255,0.75); }
.fw-sair {
  background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.25);
  color:#fff; padding:10px 16px; border-radius:8px; cursor:pointer;
  font-size:14px; min-height:44px; font-family:inherit;
}
.fw-sub-abrir { background:none; border:none; font-family:inherit; cursor:pointer; }

/* ── Computador (>= 1100px): barra horizontal ────────────── */
@media (min-width:1100px) {
  .fw-mob { display:none; }
  .fw-desk { display:flex; align-items:center; gap:2px; }
  .fw-link {
    display:block; text-decoration:none; border-radius:8px;
    padding:9px 12px; font-size:14px; color:rgba(255,255,255,0.78);
  }
  .fw-link:hover { background:rgba(255,255,255,0.12); color:#fff; }
  .fw-link.on { background:rgba(244,123,32,0.20); color:#F9A76A; font-weight:700; }
  .fw-sub { position:relative; }
  .fw-sub-itens {
    position:absolute; top:42px; left:0; min-width:240px; z-index:200;
    background:#fff; border-radius:12px; padding:6px;
    box-shadow:0 14px 40px rgba(15,35,64,0.28);
  }
  .fw-sub-item {
    display:block; padding:10px 12px; border-radius:8px;
    font-size:14px; color:#0F2340; text-decoration:none;
  }
  .fw-sub-item:hover { background:#F0F4FF; }
  .fw-sub-item.on { background:#F0F4FF; font-weight:700; }
}

/* ── Celular e tablet (< 1100px): sanfona ────────────────── */
@media (max-width:1099px) {
  .fw-desk { display:none; }
  .fw-mob { position:relative; }
  .fw-abrir {
    display:flex; align-items:center; gap:8px;
    min-height:48px; padding:0 14px; border-radius:10px; border:none;
    font-size:16px; font-weight:700; color:#fff; user-select:none;
    background:rgba(255,255,255,0.14); cursor:pointer; font-family:inherit;
  }
  .fw-abrir.on { background:rgba(255,255,255,0.24); }
  .fw-itens {
    position:absolute; top:56px; left:0; z-index:200;
    width:min(88vw,340px); max-height:calc(100vh - 120px); overflow-y:auto;
    background:#fff; border-radius:14px; padding:8px;
    box-shadow:0 14px 40px rgba(15,35,64,0.30);
    display:flex; flex-direction:column; gap:2px;
  }
  .fw-link {
    display:block; text-decoration:none; border-radius:10px; text-align:left;
    padding:12px 14px; min-height:48px; line-height:24px;
    font-size:16px; color:#0F2340;
  }
  .fw-link:active, .fw-sub-item:active { background:#F0F4FF; }
  .fw-link.on { background:rgba(244,123,32,0.16); color:#A34A00; font-weight:700; }
  .fw-sub-abrir { font-weight:700; width:100%; }
  .fw-sub-itens { display:flex; flex-direction:column; padding-left:10px; }
  .fw-sub-item {
    display:block; padding:12px 14px; min-height:48px; line-height:24px;
    border-radius:10px; font-size:16px; color:#0F2340; text-decoration:none;
  }
  .fw-sub-item.on { background:#F0F4FF; font-weight:700; }
  .fw-sair-mobile { margin-top:8px; border-top:1px solid #e3e8f5; padding-top:8px; }
  .fw-sair-mobile button {
    width:100%; min-height:48px; border-radius:10px; cursor:pointer;
    background:#fff; border:2px solid #2D3278; color:#2D3278;
    font-size:16px; font-weight:700; font-family:inherit;
  }
  .fw-usuario .fw-sair { display:none; }
  .fw-nome { display:none; }
}
`
