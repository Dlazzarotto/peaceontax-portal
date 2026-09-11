// /dashboard — painel da equipe.
//
// Sócio vê o negócio (receita, recorrente, contas a receber com aging);
// gerente e assistente veem a operação e a carteira. A separação segue
// lib/billing-perms (verTotais é só do owner) — esconder não basta, por isso
// os dados de dinheiro nem são buscados para quem não pode ver.
//
// As contas ficam em lib/painel.ts (puras, testáveis). Aging e receita
// recorrente vêm de lib/relatorios-financeiro, para o painel e o relatório
// impresso nunca discordarem.

import { getUser } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import { getStaffLevel } from '@/lib/staff-perms'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { money } from '@/lib/format'
import { hojeET, janelas, somaPeriodo, variacao, serieMensal, resumoCarteira, resumoFila, inicioDoDiaET, amanha } from '@/lib/painel'
import { agregarAberto, agregarRecorrente, FAIXAS, round2 } from '@/lib/relatorios-financeiro'

export const dynamic = 'force-dynamic'

// Etapas do pipeline: valor no banco → rótulo na tela
const STAGES: [string, string][] = [
  ['Onboarding', 'Início'], ['Gathering Docs', 'Documentos'], ['In Preparation', 'Em preparação'],
  ['Under Review', 'Em revisão'], ['Filed', 'Enviada'], ['Complete', 'Concluída'],
]

const TINTA = '#0F2340', FRACO = '#6A7A9A', LINHA = '#E2E8F4', LINK = '#2D3278', VERMELHO = '#B02020'

const MES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

const pct = (v: number | null) =>
  v === null ? '' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(0)}%`

export default async function DashboardPage() {
  const user = await getUser()
  if (!user) redirect('/login')

  // Página interna da equipe: lê pelo servidor, sem depender das políticas
  // de acesso do portal do cliente (era o que zerava os números).
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY!
  )

  const agora = new Date()
  const hoje = hojeET(agora)
  const j = janelas(hoje)
  const nivel = await getStaffLevel(user.id)
  const ehSocio = nivel === 'owner'

  // Janela dos gráficos: 12 meses fechando no mês corrente (inclui 1º de janeiro,
  // então o acumulado do ano sai da mesma consulta).
  const inicioSerie = (() => {
    const d = new Date(Date.UTC(+j.ym.slice(0, 4), +j.ym.slice(5, 7) - 1 - 11, 1))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
  })()


  const [
    { data: clientes, error: eClientes },
    fila,
    { count: convites, error: eConvites },
    { data: agenda, error: eAgenda },
    planos,
  ] = await Promise.all([
    sb.from('clients').select('id, name, business_name, type, stage, assignee, created_at')
      .eq('active', true).limit(5000),
    sb.from('v_painel_lancamentos').select('client_id, sem_classificacao, aguardando_aprovacao'),
    sb.from('client_invitations').select('id', { count: 'exact', head: true })
      .in('status', ['sent', 'opened']),
    sb.from('bookings')
      .select('id, guest_name, guest_phone, starts_at, notes, meeting_types(name)')
      .eq('status', 'booked')
      .gte('starts_at', inicioDoDiaET(hoje)).lt('starts_at', inicioDoDiaET(amanha(hoje)))
      .order('starts_at'),
    ehSocio
      ? sb.from('payment_plans').select('id, kind, status, monthly_amount, installments, installment_amount, paid_installments, clients(name, business_name)')
          .in('status', ['active', 'paused', 'payment_failed', 'awaiting_entry', 'awaiting_setup', 'awaiting_signature'])
      : sb.from('payment_plans').select('id, status')
          .in('status', ['awaiting_entry', 'awaiting_setup', 'awaiting_signature']),
  ])

  // Sem a visão do painel (migração ainda não rodada), o total ainda sai —
  // só a quebra por cliente é que não.
  let semView: string | null = null
  let semClassificacao = 0, aguardandoAprovacao = 0
  let porCliente: ReturnType<typeof resumoFila>['porCliente'] = []
  const ativos = new Set((clientes || []).map((c: any) => c.id))
  const nomes = Object.fromEntries((clientes || []).map((c: any) => [c.id, c.business_name || c.name]))

  if (fila.error) {
    semView = fila.error.message
    const [{ count: p }, { count: a }] = await Promise.all([
      sb.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      sb.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('status', 'auto'),
    ])
    semClassificacao = p || 0
    aguardandoAprovacao = a || 0
  } else {
    const r = resumoFila((fila.data as any) || [], nomes, ativos)
    semClassificacao = r.semClassificacao
    aguardandoAprovacao = r.aguardandoAprovacao
    porCliente = r.porCliente
  }

  // Financeiro: exclusivo do sócio (lib/billing-perms → verTotais)
  let fin: any = null
  if (ehSocio) {
    const [{ data: faturas }, { data: pagamentos }] = await Promise.all([
      sb.from('invoices').select('id, due_date, total, paid_total, clients(name, business_name)')
        .eq('doc_type', 'invoice').in('status', ['sent', 'partial', 'overdue']),
      sb.from('invoice_payments').select('amount, received_at').gte('received_at', inicioSerie),
    ])
    const pg = (pagamentos || []) as any[]
    const aberto = agregarAberto((faturas || []) as any[], hoje)
    const mes = somaPeriodo(pg, j.inicioMes, hoje)
    const mesmoPeriodoAnterior = somaPeriodo(pg, j.inicioMesAnterior, j.mesmoDiaMesAnterior)
    fin = {
      mes, mesmoPeriodoAnterior,
      variacaoMes: variacao(mes, mesmoPeriodoAnterior),
      mesAnteriorCheio: somaPeriodo(pg, j.inicioMesAnterior, j.fimMesAnterior),
      ano: somaPeriodo(pg, j.inicioAno, hoje),
      pagamentosNoAno: pg.filter(p => String(p.received_at).slice(0, 10) >= j.inicioAno).length,
      serie: serieMensal(pg, j.ym, 12),
      aberto: aberto,
      vencido: round2(aberto.total - aberto.totalFaixas[0]),
      recorrente: agregarRecorrente((planos.data || []) as any[]),
    }
  }

  const carteira = resumoCarteira((clientes || []) as any[], hoje)
  const semResponsavel = (clientes || []).filter((c: any) => !c.assignee).length
  const contratosPendentes = ((planos.data || []) as any[])
    .filter(p => ['awaiting_entry', 'awaiting_setup', 'awaiting_signature'].includes(p.status)).length

  // Só a primeira letra: 'capitalize' do CSS deixaria "Quarta-Feira, 09 De Setembro".
  const dataHoje = (d => d.charAt(0).toUpperCase() + d.slice(1))(
    new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/New_York',
    }).format(agora))
  const atualizado = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York',
  }).format(agora)
  const hhmm = (iso: string) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso))

  const operacao = [
    { n: semClassificacao, rotulo: 'Lançamentos sem classificação',
      nota: 'ninguém classificou ainda', href: '/dashboard/bookkeeping' },
    { n: aguardandoAprovacao, rotulo: 'Classificados aguardando aprovação',
      nota: 'regra ou IA já classificou; falta aprovar', href: '/dashboard/bookkeeping' },
    { n: contratosPendentes, rotulo: 'Contratos aguardando o cliente',
      nota: 'assinatura, entrada ou cadastro do débito', href: '/dashboard/billing' },
    { n: convites || 0, rotulo: 'Convites sem cadastro',
      nota: 'enviados ou abertos, ainda sem primeiro acesso', href: '/invitations' },
    { n: semResponsavel, rotulo: 'Clientes sem responsável',
      nota: 'ninguém da equipe atribuído', href: '/clients' },
  ]

  const falhas = ([['clientes', eClientes], ['convites', eConvites], ['agenda', eAgenda],
    ['contratos', planos.error]] as [string, any][]).filter(([, e]) => e)

  const maxSerie = Math.max(1, ...(fin?.serie || []).map((s: any) => s.total))

  return (
    <div className="pnl">
      <style>{CSS}</style>

      <header className="pnl-topo">
        <h1>Painel</h1>
        <p>
          {dataHoje} · Nova York · atualizado {atualizado}
        </p>
      </header>

      {falhas.length > 0 && (
        <div className="pnl-erro">
          <b>Alguns dados não carregaram</b>
          {falhas.map(([nome, e]) => <div key={nome}>{nome}: {e.message}</div>)}
        </div>
      )}

      {/* ── Resultado (só o sócio) ─────────────────────────────── */}
      {fin && (
        <section className="pnl-sec">
          <h2>Resultado</h2>
          <div className="pnl-num">
            <div>
              <span className="rot">Recebido em {MES_CURTO[+j.ym.slice(5, 7) - 1]}</span>
              <strong>{money(fin.mes)}</strong>
              <span className="nota">
                {fin.variacaoMes === null
                  ? `sem base no mesmo período de ${MES_CURTO[+j.inicioMesAnterior.slice(5, 7) - 1]}`
                  : <>
                      <span style={{ color: fin.variacaoMes >= 0 ? '#1A6B4A' : VERMELHO, fontWeight: 700 }}>
                        {pct(fin.variacaoMes)}
                      </span>
                      {' '}vs. {money(fin.mesmoPeriodoAnterior)} no mesmo período do mês anterior
                    </>}
              </span>
            </div>
            <div>
              <span className="rot">Recebido em {hoje.slice(0, 4)}</span>
              <strong>{money(fin.ano)}</strong>
              <span className="nota">{fin.pagamentosNoAno} pagamento(s) no ano</span>
            </div>
            <div>
              <span className="rot">Recorrente contratado</span>
              <strong>{money(fin.recorrente.mrr)}<em>/mês</em></strong>
              <span className="nota">
                {fin.recorrente.ativosMensais} contrato(s) ativo(s) ·
                {' '}{money(fin.recorrente.aReceber)} em parcelas a receber
              </span>
            </div>
            <div>
              <span className="rot">A receber</span>
              <strong>{money(fin.aberto.total)}</strong>
              <span className="nota">
                {fin.vencido > 0
                  ? <><span style={{ color: VERMELHO, fontWeight: 700 }}>{money(fin.vencido)}</span> vencido</>
                  : 'nada vencido'}
              </span>
            </div>
          </div>

          <div className="pnl-serie">
            {fin.serie.map((s: any, i: number) => {
              const atual = s.ym === j.ym
              return (
                <div key={s.ym} className="pnl-barra" title={`${s.ym}: ${money(s.total)}`}>
                  <div className="pnl-haste">
                    <div style={{
                      height: `${Math.max(s.total > 0 ? 2 : 0, (s.total / maxSerie) * 100)}%`,
                      background: atual ? LINK : '#C3CDE0',
                    }} />
                  </div>
                  <span className={atual ? 'mes atual' : 'mes'}>
                    {MES_CURTO[+s.ym.slice(5, 7) - 1]}{i === 0 || s.ym.slice(5, 7) === '01' ? ` ${s.ym.slice(2, 4)}` : ''}
                  </span>
                </div>
              )
            })}
          </div>
          <p className="pnl-legenda">Recebimentos por mês de entrada, 12 meses. Fonte: baixas registradas no financeiro.</p>
        </section>
      )}

      {/* ── Contas a receber (só o sócio) ──────────────────────── */}
      {fin && fin.aberto.total > 0 && (
        <section className="pnl-sec">
          <h2>Contas a receber</h2>
          <table className="pnl-tab">
            <thead>
              <tr>
                <th>Cliente</th>
                {FAIXAS.map(f => <th key={f} className="d">{f}</th>)}
                <th className="d">Total</th>
              </tr>
            </thead>
            <tbody>
              {fin.aberto.linhas.slice(0, 6).map((l: any) => (
                <tr key={l.nome}>
                  <td>{l.nome}</td>
                  {l.faixas.map((v: number, i: number) => (
                    <td key={i} className="d" style={{ color: v > 0 && i > 0 ? VERMELHO : undefined }}>
                      {v > 0 ? money(v) : '—'}
                    </td>
                  ))}
                  <td className="d b">{money(l.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="b">Todos os clientes</td>
                {fin.aberto.totalFaixas.map((v: number, i: number) => (
                  <td key={i} className="d b" style={{ color: v > 0 && i > 0 ? VERMELHO : undefined }}>{money(v)}</td>
                ))}
                <td className="d b">{money(fin.aberto.total)}</td>
              </tr>
            </tfoot>
          </table>
          <p className="pnl-legenda">
            {fin.aberto.linhas.length > 6 ? `Seis maiores de ${fin.aberto.linhas.length} clientes com saldo. ` : ''}
            <Link href="/dashboard/billing">Financeiro e relatórios →</Link>
          </p>
        </section>
      )}

      {/* ── Carteira ───────────────────────────────────────────── */}
      <section className="pnl-sec">
        <h2>Carteira</h2>
        <div className="pnl-num">
          <div><span className="rot">Clientes ativos</span><strong>{carteira.ativos}</strong>
            <span className="nota">{carteira.empresas} empresa(s) · {carteira.pessoas} pessoa(s)</span></div>
          <div><span className="rot">Novos em {MES_CURTO[+j.ym.slice(5, 7) - 1]}</span><strong>{carteira.novosNoMes}</strong>
            <span className="nota">entraram na carteira este mês</span></div>
          <div><span className="rot">Sem responsável</span>
            <strong style={{ color: semResponsavel > 0 ? VERMELHO : undefined }}>{semResponsavel}</strong>
            <span className="nota">ninguém da equipe atribuído</span></div>
          <div><span className="rot">Reuniões hoje</span><strong>{(agenda || []).length}</strong>
            <span className="nota">agenda de Nova York</span></div>
        </div>

        <div className="pnl-pipe">
          {STAGES.map(([k, l]) => (
            <div key={k}>
              <span className="n">{carteira.porEtapa[k] || 0}</span>
              <span className="l">{l}</span>
            </div>
          ))}
          <Link href="/clients" className="pnl-mais">Abrir CRM →</Link>
        </div>
      </section>

      {/* ── Operação ───────────────────────────────────────────── */}
      <section className="pnl-sec">
        <h2>Operação</h2>
        <table className="pnl-tab">
          <tbody>
            {operacao.map(o => (
              <tr key={o.rotulo}>
                <td className="q" style={{ color: o.n > 0 ? TINTA : FRACO }}>{o.n.toLocaleString('pt-BR')}</td>
                <td>
                  <Link href={o.href}>{o.rotulo}</Link>
                  <div className="sub">{o.nota}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {semView ? (
          <p className="pnl-legenda">
            A quebra por cliente precisa da visão <code>v_painel_lancamentos</code> —
            rode <code>sql/painel-v1.sql</code> no Supabase. ({semView})
          </p>
        ) : porCliente.length > 0 && (
          <>
            <h3>Onde está a fila</h3>
            <table className="pnl-tab">
              <thead>
                <tr><th>Cliente</th><th className="d">Sem classificação</th><th className="d">Aguardando aprovação</th></tr>
              </thead>
              <tbody>
                {porCliente.slice(0, 6).map(c => (
                  <tr key={c.clientId}>
                    <td><Link href={`/clients/${c.clientId}`}>{c.nome}</Link></td>
                    <td className="d">{c.semClassificacao.toLocaleString('pt-BR')}</td>
                    <td className="d">{c.aguardandoAprovacao.toLocaleString('pt-BR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="pnl-legenda">
              {porCliente.length > 6 ? `Seis maiores de ${porCliente.length} clientes com fila. ` : ''}
              Aprovar é o que tira a linha da fila — classificar por regra mantém em “aguardando aprovação”.
            </p>
          </>
        )}
      </section>

      {/* ── Agenda ─────────────────────────────────────────────── */}
      <section className="pnl-sec">
        <h2>Agenda de hoje</h2>
        {(agenda || []).length === 0 ? (
          <p className="pnl-vazio">
            Nenhuma reunião marcada. <Link href="/agendar">Compartilhar link de agendamento →</Link>
          </p>
        ) : (
          <table className="pnl-tab">
            <tbody>
              {(agenda || []).map((b: any) => (
                <tr key={b.id}>
                  <td className="h">{hhmm(b.starts_at)}</td>
                  <td>
                    {b.guest_name}
                    <div className="sub">
                      {b.meeting_types?.name ?? 'Reunião'}{b.guest_phone ? ` · ${b.guest_phone}` : ''}
                      {b.notes ? ` · ${b.notes}` : ''}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="pnl-legenda"><Link href="/dashboard/agenda">Ver a semana →</Link></p>
      </section>

      <footer className="pnl-rodape">
        <Link href="/dashboard/accounts">Plano de contas</Link>
        <Link href="/dashboard/payees">Fornecedores e clientes</Link>
        <Link href="/rules">Regras gerais</Link>
        {ehSocio && <Link href="/dashboard/billing">Relatórios do faturamento</Link>}
      </footer>
    </div>
  )
}

const CSS = `
.pnl { max-width: 1080px; color: ${TINTA}; }
.pnl a { color: ${LINK}; text-decoration: none; }
.pnl a:hover { text-decoration: underline; }
.pnl-topo { margin-bottom: 26px; }
.pnl-topo h1 { font-family: Georgia, serif; font-size: 26px; font-weight: 400; margin: 0 0 3px; }
.pnl-topo p { margin: 0; font-size: 13px; color: ${FRACO}; }
.pnl-erro { border: 1px solid #E9B0B0; background: #FEF4F4; border-radius: 8px;
  padding: 10px 14px; margin-bottom: 20px; font-size: 13px; color: #7A2020; line-height: 1.6; }
.pnl-sec { margin-bottom: 30px; }
.pnl-sec h2 { font-family: Georgia, serif; font-size: 15px; font-weight: 400; color: ${TINTA};
  margin: 0 0 12px; padding-bottom: 7px; border-bottom: 1px solid ${LINHA}; }
.pnl-sec h3 { font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  color: ${FRACO}; margin: 22px 0 8px; }

.pnl-num { display: grid; gap: 26px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
.pnl-num .rot { display: block; font-size: 11.5px; font-weight: 700; letter-spacing: .06em;
  text-transform: uppercase; color: ${FRACO}; margin-bottom: 5px; }
.pnl-num strong { display: block; font-size: 25px; font-weight: 600; letter-spacing: -.01em;
  font-variant-numeric: tabular-nums; line-height: 1.1; }
.pnl-num strong em { font-size: 13px; font-style: normal; font-weight: 400; color: ${FRACO}; }
.pnl-num .nota { display: block; font-size: 12.5px; color: ${FRACO}; margin-top: 5px; line-height: 1.45; }

.pnl-serie { display: flex; align-items: flex-end; gap: 6px; height: 104px; margin: 26px 0 6px; }
.pnl-barra { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 5px; height: 100%; }
.pnl-haste { flex: 1; width: 100%; display: flex; align-items: flex-end;
  border-bottom: 1px solid ${LINHA}; }
.pnl-haste > div { width: 100%; border-radius: 2px 2px 0 0; }
.pnl-barra .mes { font-size: 10.5px; color: ${FRACO}; white-space: nowrap; }
.pnl-barra .mes.atual { color: ${LINK}; font-weight: 700; }
.pnl-legenda { font-size: 12px; color: ${FRACO}; margin: 10px 0 0; line-height: 1.5; }
.pnl-legenda code { font-size: 11.5px; background: #F4F7FC; padding: 1px 5px; border-radius: 4px; }

.pnl-tab { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.pnl-tab th { text-align: left; font-size: 11px; font-weight: 700; letter-spacing: .05em;
  text-transform: uppercase; color: ${FRACO}; padding: 0 10px 7px; border-bottom: 1px solid ${LINHA}; }
.pnl-tab td { padding: 9px 10px; border-bottom: 1px solid #F1F4FA; vertical-align: top; }
.pnl-tab tfoot td { border-top: 1px solid ${LINHA}; border-bottom: none; }
.pnl-tab .d { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pnl-tab .b { font-weight: 700; }
.pnl-tab .q { width: 84px; text-align: right; font-size: 19px; font-weight: 600;
  font-variant-numeric: tabular-nums; padding-right: 16px; }
.pnl-tab .h { width: 84px; font-variant-numeric: tabular-nums; color: ${LINK}; font-weight: 600; }
.pnl-tab .sub { font-size: 12px; color: ${FRACO}; margin-top: 2px; }

.pnl-pipe { display: flex; flex-wrap: wrap; gap: 26px; align-items: baseline; margin-top: 20px; }
.pnl-pipe .n { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; }
.pnl-pipe .l { display: block; font-size: 12px; color: ${FRACO}; margin-top: 1px; }
.pnl-mais { font-size: 13px; margin-left: auto; }
.pnl-vazio { font-size: 13.5px; color: #4A5A70; margin: 0; }
.pnl-rodape { display: flex; flex-wrap: wrap; gap: 20px; font-size: 13px;
  border-top: 1px solid ${LINHA}; padding-top: 14px; }
@media (max-width: 720px) {
  .pnl-serie { height: 84px; }
  .pnl-tab { font-size: 12.5px; }
}
`
