import { getUser } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import { redirect } from 'next/navigation'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

// Etapas do pipeline: valor no banco → rótulo e cor na tela
const STAGES: { key: string; label: string; color: string }[] = [
  { key: 'Onboarding',     label: 'Início',        color: '#6A7A9A' },
  { key: 'Gathering Docs', label: 'Documentos',    color: '#C06010' },
  { key: 'In Preparation', label: 'Em preparação', color: '#2D3278' },
  { key: 'Under Review',   label: 'Em revisão',    color: '#5A1A8A' },
  { key: 'Filed',          label: 'Enviada',       color: '#1A6B4A' },
  { key: 'Complete',       label: 'Concluída',     color: '#0F6B4A' },
]

export default async function DashboardPage() {
  const user = await getUser()
  if (!user) redirect('/login')

  // Página interna da equipe: lê pelo servidor, sem depender das políticas
  // de acesso do portal do cliente (era o que zerava os números).
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY!
  )

  const nowET   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const todayET = new Date(nowET); todayET.setHours(0, 0, 0, 0)
  const tmrwET  = new Date(todayET); tmrwET.setDate(tmrwET.getDate() + 1)

  const [
    { count: totalClients, error: e1 },
    { count: pendingInvites, error: e2 },
    { count: docsToReview, error: e3 },
    { count: bookkeepingOpen, error: e4 },
    { count: semResponsavel, error: e5 },
    { data: recentClients, error: e6 },
    { data: stageRows, error: e7 },
    { data: todayBookings, error: e8 },
  ] = await Promise.all([
    sb.from('clients').select('*', { count: 'exact', head: true }).eq('active', true),
    sb.from('client_invitations').select('*', { count: 'exact', head: true }).eq('status', 'sent'),
    sb.from('documents').select('*', { count: 'exact', head: true })
      .not('ai_confidence', 'is', null).lt('ai_confidence', 0.95),
    sb.from('bank_transactions').select('*', { count: 'exact', head: true })
      .in('status', ['pending', 'auto']),
    sb.from('clients').select('*', { count: 'exact', head: true })
      .eq('active', true).is('assignee', null),
    sb.from('clients').select('id,name,type,stage,assignee,created_at')
      .eq('active', true).order('created_at', { ascending: false }).limit(6),
    sb.from('clients').select('stage').eq('active', true),
    sb.from('bookings')
      .select('id,guest_name,guest_phone,starts_at,notes,meeting_types(name,mode)')
      .eq('status', 'booked')
      .gte('starts_at', todayET.toISOString())
      .lt('starts_at', tmrwET.toISOString())
      .order('starts_at'),
  ])

  const nome = user?.user_metadata?.full_name?.split(' ')[0] || ''
  const hora = nowET.getHours()
  const saudacao = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite'
  const dataHoje = nowET.toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/New_York',
  })

  const porEtapa = (k: string) => (stageRows || []).filter((c: any) => c.stage === k).length
  const totalPipeline = (stageRows || []).length || 1

  const hhmm = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
    })

  const iniciais = (n: string) =>
    (n || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase()

  // Triagem: só aparece o que realmente precisa de ação
  const triagem = [
    {
      n: bookkeepingOpen || 0, cor: '#F47B20',
      titulo: 'lançamentos aguardando revisão',
      acao: 'Classificar e aprovar no bookkeeping', href: '/clients',
    },
    {
      n: docsToReview || 0, cor: '#C06010',
      titulo: 'documentos com classificação incerta',
      acao: 'Conferir o que a IA não reconheceu', href: '/clients',
    },
    {
      n: pendingInvites || 0, cor: '#5A1A8A',
      titulo: 'convites enviados sem resposta',
      acao: 'Cobrar o primeiro acesso do cliente', href: '/invitations',
    },
    {
      n: semResponsavel || 0, cor: '#2D3278',
      titulo: 'clientes sem responsável',
      acao: 'Atribuir alguém da equipe', href: '/clients',
    },
  ].filter(t => t.n > 0)

  return (
    <div>
      <style>{`
        .dash-grid { display:grid; gap:16px; grid-template-columns: 1.35fr 1fr; align-items:start; }
        .dash-triagem { display:grid; gap:12px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
        .dash-card { background:#fff; border:1px solid #E2E8F4; border-radius:16px; }
        .dash-link:focus-visible, .dash-row:focus-visible { outline:3px solid #2D3278; outline-offset:2px; }
        .dash-row:hover { background:#EEF3FF !important; }
        @media (max-width: 900px) {
          .dash-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      {(() => {
        const falhas = [
          ['clientes', e1], ['convites', e2], ['documentos', e3],
          ['bookkeeping', e4], ['sem responsável', e5],
          ['clientes recentes', e6], ['pipeline', e7], ['agenda', e8],
        ].filter(([, e]) => e) as [string, any][]
        return falhas.length === 0 ? null : (
          <div style={{ background:'#FEE2E2', border:'1px solid #B0202040', borderRadius:12, padding:'12px 16px', marginBottom:18 }}>
            <div style={{ fontSize:14, fontWeight:800, color:'#B02020', marginBottom:4 }}>
              Alguns dados não carregaram
            </div>
            {falhas.map(([nome, e]) => (
              <div key={nome} style={{ fontSize:13, color:'#7A2020', lineHeight:1.5 }}>
                {nome}: {e.message}
              </div>
            ))}
          </div>
        )
      })()}

      {/* Cabeçalho */}
      <header style={{ marginBottom: 22 }}>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 30, lineHeight: 1.15, color: '#0F2340', margin: '0 0 6px', fontWeight: 400 }}>
          {saudacao}{nome ? `, ${nome}` : ''}
        </h1>
        <p style={{ color: '#6A7A9A', fontSize: 15, margin: 0, textTransform: 'capitalize' as const }}>
          {dataHoje} · horário de Nova York
        </p>
      </header>

      {/* Triagem do dia — o elemento central da tela */}
      <section style={{ marginBottom: 22 }}>
        <h2 style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: 1.2, textTransform: 'uppercase' as const, color: '#6A7A9A', margin: '0 0 10px' }}>
          Precisa de você
        </h2>

        {triagem.length === 0 ? (
          <div className="dash-card" style={{ padding: '20px 22px', borderLeft: '5px solid #1A6B4A' }}>
            <div style={{ fontFamily: 'Georgia,serif', fontSize: 19, color: '#1A6B4A', marginBottom: 4 }}>
              Nada pendente agora.
            </div>
            <p style={{ fontSize: 14.5, color: '#4A5A70', margin: 0, lineHeight: 1.5 }}>
              Bom momento para revisar o pipeline ou adiantar os fechamentos do mês.
            </p>
          </div>
        ) : (
          <div className="dash-triagem">
            {triagem.map(t => (
              <Link key={t.titulo} href={t.href} className="dash-link" style={{ textDecoration: 'none' }}>
                <article className="dash-card" style={{ padding: '18px 20px', borderLeft: `5px solid ${t.cor}`, height: '100%' }}>
                  <div style={{ fontSize: 40, fontWeight: 800, color: t.cor, lineHeight: 1, fontVariantNumeric: 'tabular-nums' as const }}>
                    {t.n}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#0F2340', margin: '8px 0 4px', lineHeight: 1.3 }}>
                    {t.titulo}
                  </div>
                  <div style={{ fontSize: 13.5, color: '#6A7A9A', lineHeight: 1.4 }}>{t.acao} →</div>
                </article>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Pipeline da temporada */}
      <section className="dash-card" style={{ padding: '18px 20px', marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 18, color: '#0F2340', margin: 0, fontWeight: 400 }}>
            Pipeline · {totalClients || 0} clientes ativos
          </h2>
          <Link href="/clients" className="dash-link" style={{ fontSize: 14, color: '#2D3278', fontWeight: 700, textDecoration: 'none' }}>
            Abrir CRM →
          </Link>
        </div>

        <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', background: '#EEF1F7', marginBottom: 14 }}>
          {STAGES.map(s => {
            const n = porEtapa(s.key)
            return n === 0 ? null : (
              <div key={s.key} title={`${s.label}: ${n}`}
                style={{ width: `${(n / totalPipeline) * 100}%`, background: s.color }} />
            )
          })}
        </div>

        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
          {STAGES.map(s => (
            <div key={s.key} style={{ minWidth: 96 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color, display: 'inline-block' }} />
                <span style={{ fontSize: 21, fontWeight: 800, color: '#0F2340', fontVariantNumeric: 'tabular-nums' as const }}>
                  {porEtapa(s.key)}
                </span>
              </div>
              <div style={{ fontSize: 13, color: '#6A7A9A', marginTop: 1 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Listas — cadastros que valem para todos os clientes */}
      <section style={{ marginBottom: 22 }}>
        <h2 style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: 1.2, textTransform: 'uppercase' as const, color: '#6A7A9A', margin: '0 0 10px' }}>
          Listas
        </h2>
        <div className="dash-triagem">
          {[
            { href: '/dashboard/accounts', titulo: 'Plano de contas',
              desc: 'Criar, renomear, mudar de grupo e apagar contas contábeis' },
            { href: '/dashboard/payees', titulo: 'Fornecedores e clientes',
              desc: 'Vendors e customers de todos os clientes, com renomear e apagar' },
          ].map(l => (
            <Link key={l.href} href={l.href} className="dash-link" style={{ textDecoration: 'none' }}>
              <article className="dash-card" style={{ padding: '16px 18px', height: '100%' }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#0F2340', marginBottom: 4 }}>
                  {l.titulo}
                </div>
                <div style={{ fontSize: 13.5, color: '#6A7A9A', lineHeight: 1.45 }}>{l.desc} →</div>
              </article>
            </Link>
          ))}
        </div>
      </section>

      <div className="dash-grid">
        {/* Agenda de hoje */}
        <section className="dash-card" style={{ padding: '18px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 18, color: '#0F2340', margin: 0, fontWeight: 400 }}>
              Agenda de hoje
            </h2>
            <Link href="/dashboard/agenda" className="dash-link" style={{ fontSize: 14, color: '#2D3278', fontWeight: 700, textDecoration: 'none' }}>
              Ver semana →
            </Link>
          </div>

          {(todayBookings || []).length === 0 ? (
            <div style={{ padding: '14px 0' }}>
              <p style={{ fontSize: 15, color: '#4A5A70', margin: '0 0 10px' }}>Nenhuma reunião marcada para hoje.</p>
              <Link href="/agendar" className="dash-link" style={{ fontSize: 14, fontWeight: 700, color: '#2D3278', textDecoration: 'none' }}>
                Compartilhar link de agendamento →
              </Link>
            </div>
          ) : (todayBookings || []).map((b: any) => (
            <div key={b.id} style={{ display: 'flex', gap: 14, padding: '12px 0', borderTop: '1px solid #F0F4FA' }}>
              <div style={{ minWidth: 76, fontSize: 15, fontWeight: 800, color: '#2D3278', fontVariantNumeric: 'tabular-nums' as const }}>
                {hhmm(b.starts_at)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15.5, fontWeight: 700, color: '#0F2340' }}>{b.guest_name}</div>
                <div style={{ fontSize: 13.5, color: '#6A7A9A', marginTop: 2 }}>
                  {b.meeting_types?.name ?? 'Reunião'}
                  {b.guest_phone ? ` · ${b.guest_phone}` : ''}
                </div>
                {b.notes && (
                  <div style={{ fontSize: 13.5, color: '#4A5A70', marginTop: 4, lineHeight: 1.45 }}>{b.notes}</div>
                )}
              </div>
            </div>
          ))}
        </section>

        {/* Clientes recentes */}
        <section className="dash-card" style={{ padding: '18px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 18, color: '#0F2340', margin: 0, fontWeight: 400 }}>
              Entraram por último
            </h2>
            <Link href="/invitations" className="dash-link" style={{ fontSize: 14, color: '#2D3278', fontWeight: 700, textDecoration: 'none' }}>
              Convidar →
            </Link>
          </div>

          {(recentClients || []).length === 0 ? (
            <div style={{ padding: '14px 0' }}>
              <p style={{ fontSize: 15, color: '#4A5A70', margin: '0 0 10px' }}>Nenhum cliente cadastrado ainda.</p>
              <Link href="/invitations" className="dash-link" style={{ fontSize: 14, fontWeight: 700, color: '#2D3278', textDecoration: 'none' }}>
                Enviar o primeiro convite →
              </Link>
            </div>
          ) : (recentClients || []).map((c: any) => {
            const st = STAGES.find(s => s.key === c.stage)
            return (
              <Link key={c.id} href={`/clients/${c.id}`} className="dash-link" style={{ textDecoration: 'none' }}>
                <div className="dash-row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 10px', borderRadius: 12, marginBottom: 2 }}>
                  <div title={c.assignee || 'Sem responsável'}
                    style={{
                      width: 38, height: 38, borderRadius: 11, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 13, fontWeight: 800,
                      background: c.assignee ? '#2D327812' : '#FFF3E6',
                      color: c.assignee ? '#2D3278' : '#C06010',
                      border: c.assignee ? 'none' : '1px dashed #E0A860',
                    }}>
                    {c.assignee ? iniciais(c.assignee) : '—'}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15.5, fontWeight: 700, color: '#0F2340', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                      {c.type === 'business' ? '🏢 ' : ''}{c.name}
                    </div>
                    <div style={{ fontSize: 13, color: c.assignee ? '#6A7A9A' : '#C06010', marginTop: 1 }}>
                      {c.assignee || 'sem responsável'}
                    </div>
                  </div>
                  {st && (
                    <span style={{ fontSize: 12.5, fontWeight: 800, padding: '4px 10px', borderRadius: 20, whiteSpace: 'nowrap' as const, color: st.color, background: `${st.color}14` }}>
                      {st.label}
                    </span>
                  )}
                </div>
              </Link>
            )
          })}
        </section>
      </div>
    </div>
  )
}
