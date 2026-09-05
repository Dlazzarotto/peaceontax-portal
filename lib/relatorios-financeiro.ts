// lib/relatorios-financeiro.ts — relatórios do faturamento, exclusivos do sócio.
//
// Aqui ficam só as CONTAS (agregações) e o HTML impresso. A rota
// /api/billing/reports busca os dados e confere a permissão (verRelatorios,
// que só o owner tem — lib/billing-perms.ts). Funções puras: testáveis sem banco.
//
// Formato dos relatórios (especificação 4.2): preto e branco, timbre com a
// logo, subtotais em negrito, total em linha dupla, sinal de menos (nunca
// parênteses), Georgia/Times. Datas MM/DD/YYYY, moeda em dólar.

import { barraDoRelatorio } from '@/lib/relatorio-barra'
import { FIRM } from '@/lib/contract-html'

export type Periodo = { from: string; to: string }   // YYYY-MM-DD, inclusivo

export const RELATORIOS = [
  { id: 'faturamento',  titulo: 'Faturamento por mês',        desc: 'Emitido, recebido e em aberto, mês a mês' },
  { id: 'recebimentos', titulo: 'Recebimentos',               desc: 'Por forma de pagamento e por cliente' },
  { id: 'aberto',       titulo: 'Contas a receber',           desc: 'Saldo em aberto por cliente e por atraso (aging)' },
  { id: 'recorrente',   titulo: 'Contratos e parcelamentos',  desc: 'Receita recorrente mensal e parcelas a receber' },
  { id: 'servicos',     titulo: 'Faturamento por serviço',    desc: 'O que foi faturado, por item do catálogo' },
  { id: 'estornos',     titulo: 'Estornos e cancelamentos',   desc: 'Pagamentos estornados e faturas canceladas' },
] as const
export type RelatorioId = typeof RELATORIOS[number]['id']

export const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100
export const money = (n: number) => {
  const v = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${n < 0 ? '-' : ''}$${v}`
}
export const fmtUS = (iso: string | null | undefined) => {
  if (!iso) return ''
  const s = String(iso).slice(0, 10)
  return `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`
}
const MESES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const rotuloMes = (ym: string) => `${MESES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`
export const nomeCliente = (c: any) => c?.business_name || c?.name || '—'

export const FORMA: Record<string, string> = {
  card: 'Cartão', ach: 'Débito em conta (ACH)', external: 'Financiado', cash: 'Dinheiro',
  zelle: 'Zelle', venmo: 'Venmo', check: 'Cheque', wire: 'Wire',
}
const rotuloForma = (p: any) => p.method === 'external' ? `Financiado (${p.financier || 'terceiro'})` : (FORMA[p.method] || p.method)

// ── Agregações ───────────────────────────────────────────────

/** Faturamento por mês de emissão + recebimentos por mês de entrada. */
export function agregarFaturamento(faturas: any[], pagamentos: any[]) {
  const meses: Record<string, { qtd: number; emitido: number; recebidoDessas: number; aberto: number; recebidoNoMes: number }> = {}
  const m = (ym: string) => (meses[ym] = meses[ym] || { qtd: 0, emitido: 0, recebidoDessas: 0, aberto: 0, recebidoNoMes: 0 })
  for (const f of faturas) {
    const x = m(String(f.issue_date).slice(0, 7))
    x.qtd++; x.emitido = round2(x.emitido + Number(f.total))
    x.recebidoDessas = round2(x.recebidoDessas + Number(f.paid_total || 0))
    x.aberto = round2(x.aberto + Math.max(0, Number(f.total) - Number(f.paid_total || 0)))
  }
  for (const p of pagamentos) {
    const x = m(String(p.received_at).slice(0, 7))
    x.recebidoNoMes = round2(x.recebidoNoMes + Number(p.amount))
  }
  const linhas = Object.entries(meses).sort(([a], [b]) => a.localeCompare(b)).map(([ym, v]) => ({ mes: ym, ...v }))
  const total = linhas.reduce((t, l) => ({
    qtd: t.qtd + l.qtd, emitido: round2(t.emitido + l.emitido), recebidoDessas: round2(t.recebidoDessas + l.recebidoDessas),
    aberto: round2(t.aberto + l.aberto), recebidoNoMes: round2(t.recebidoNoMes + l.recebidoNoMes),
  }), { qtd: 0, emitido: 0, recebidoDessas: 0, aberto: 0, recebidoNoMes: 0 })
  return { linhas, total }
}

/** Recebimentos por forma e por cliente. */
export function agregarRecebimentos(pagamentos: any[]) {
  const porForma: Record<string, { qtd: number; total: number }> = {}
  const porCliente: Record<string, { qtd: number; total: number }> = {}
  for (const p of pagamentos) {
    const f = rotuloForma(p)
    porForma[f] = porForma[f] || { qtd: 0, total: 0 }
    porForma[f].qtd++; porForma[f].total = round2(porForma[f].total + Number(p.amount))
    const c = nomeCliente(p.clients)
    porCliente[c] = porCliente[c] || { qtd: 0, total: 0 }
    porCliente[c].qtd++; porCliente[c].total = round2(porCliente[c].total + Number(p.amount))
  }
  const total = round2(pagamentos.reduce((s, p) => s + Number(p.amount), 0))
  const ordenar = (o: Record<string, { qtd: number; total: number }>) =>
    Object.entries(o).map(([k, v]) => ({ nome: k, ...v })).sort((a, b) => b.total - a.total)
  return { porForma: ordenar(porForma), porCliente: ordenar(porCliente), total, qtd: pagamentos.length }
}

/** Contas a receber com aging pelo vencimento, na data de referência. */
export const FAIXAS = ['A vencer', '1–30 dias', '31–60 dias', '61–90 dias', '> 90 dias'] as const
export function faixaAtraso(dueDate: string | null, hoje: string): number {
  if (!dueDate) return 0
  const dias = Math.floor((Date.UTC(+hoje.slice(0, 4), +hoje.slice(5, 7) - 1, +hoje.slice(8, 10))
    - Date.UTC(+dueDate.slice(0, 4), +dueDate.slice(5, 7) - 1, +dueDate.slice(8, 10))) / 86400000)
  if (dias <= 0) return 0
  if (dias <= 30) return 1
  if (dias <= 60) return 2
  if (dias <= 90) return 3
  return 4
}
export function agregarAberto(faturas: any[], hoje: string) {
  const porCliente: Record<string, { faixas: number[]; total: number; faturas: number }> = {}
  const totalFaixas = [0, 0, 0, 0, 0]
  for (const f of faturas) {
    const saldo = round2(Number(f.total) - Number(f.paid_total || 0))
    if (saldo <= 0) continue
    const c = nomeCliente(f.clients)
    porCliente[c] = porCliente[c] || { faixas: [0, 0, 0, 0, 0], total: 0, faturas: 0 }
    const i = faixaAtraso(f.due_date, hoje)
    porCliente[c].faixas[i] = round2(porCliente[c].faixas[i] + saldo)
    porCliente[c].total = round2(porCliente[c].total + saldo)
    porCliente[c].faturas++
    totalFaixas[i] = round2(totalFaixas[i] + saldo)
  }
  const linhas = Object.entries(porCliente).map(([nome, v]) => ({ nome, ...v })).sort((a, b) => b.total - a.total)
  return { linhas, totalFaixas, total: round2(totalFaixas.reduce((s, v) => s + v, 0)) }
}

/** Contratos mensais (MRR) e parcelamentos em andamento (a receber). */
export function agregarRecorrente(planos: any[]) {
  const mensais = planos.filter(p => p.kind !== 'installment')
  const parcelados = planos.filter(p => p.kind === 'installment')
  const ativos = (l: any[]) => l.filter(p => p.status === 'active')
  const mrr = round2(ativos(mensais).reduce((s, p) => s + Number(p.monthly_amount || 0), 0))
  const restante = (p: any) => {
    const pagas = Number(p.paid_installments || 0)
    const n = Number(p.installments || 0)
    return round2(Math.max(0, n - pagas) * Number(p.installment_amount || 0))
  }
  const aReceber = round2(parcelados.filter(p => !['completed', 'cancelled'].includes(p.status)).reduce((s, p) => s + restante(p), 0))
  return {
    mensais: mensais.map(p => ({ ...p, cliente: nomeCliente(p.clients) })).sort((a, b) => Number(b.monthly_amount) - Number(a.monthly_amount)),
    parcelados: parcelados.map(p => ({ ...p, cliente: nomeCliente(p.clients), restante: restante(p) })).sort((a, b) => b.restante - a.restante),
    mrr, ativosMensais: ativos(mensais).length, aReceber,
  }
}

/** Faturamento por item do catálogo (ou descrição livre). */
export function agregarServicos(itens: any[]) {
  const por: Record<string, { qtd: number; total: number; faturas: Set<string> }> = {}
  for (const it of itens) {
    const k = it.pricing_items?.label || it.description || '(sem descrição)'
    por[k] = por[k] || { qtd: 0, total: 0, faturas: new Set() }
    por[k].qtd += Number(it.qty || 1); por[k].total = round2(por[k].total + Number(it.amount || 0)); por[k].faturas.add(it.invoice_id)
  }
  const linhas = Object.entries(por).map(([nome, v]) => ({ nome, qtd: v.qtd, total: v.total, faturas: v.faturas.size })).sort((a, b) => b.total - a.total)
  return { linhas, total: round2(linhas.reduce((s, l) => s + l.total, 0)) }
}

// ── HTML ─────────────────────────────────────────────────────

export type Coluna = { titulo: string; direita?: boolean }
export type Secao = { titulo?: string; colunas: Coluna[]; linhas: (string | number)[][]; total?: (string | number)[]; nota?: string }

const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function renderRelatorio(opts: { titulo: string; periodo: string; secoes: Secao[]; resumo?: { rotulo: string; valor: string }[]; voltarPara?: string }): string {
  const barra = barraDoRelatorio({ voltarPara: opts.voltarPara || '/dashboard/billing' })
  const cel = (v: string | number, c: Coluna, forte = false) =>
    `<td class="${c.direita ? 'r' : ''}${forte ? ' b' : ''}">${typeof v === 'number' ? money(v) : esc(v)}</td>`
  const secoes = opts.secoes.map(s => `
    ${s.titulo ? `<h3>${esc(s.titulo)}</h3>` : ''}
    <table>
      <tr>${s.colunas.map(c => `<th class="${c.direita ? 'r' : ''}">${esc(c.titulo)}</th>`).join('')}</tr>
      ${s.linhas.length ? s.linhas.map(l => `<tr>${l.map((v, i) => cel(v, s.colunas[i])).join('')}</tr>`).join('')
        : `<tr><td colspan="${s.colunas.length}" class="muted">Nada no período.</td></tr>`}
      ${s.total ? `<tr class="total">${s.total.map((v, i) => cel(v, s.colunas[i], true)).join('')}</tr>` : ''}
    </table>
    ${s.nota ? `<p class="nota">${esc(s.nota)}</p>` : ''}`).join('')
  const resumo = opts.resumo?.length
    ? `<table class="resumo">${opts.resumo.map(r => `<tr><td>${esc(r.rotulo)}</td><td class="r b">${esc(r.valor)}</td></tr>`).join('')}</table>` : ''

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(opts.titulo)} — ${esc(opts.periodo)}</title>
  <style>
    * { box-sizing:border-box; }
    body { font-family: Georgia, "Times New Roman", serif; color:#000; background:#fff; margin:0; padding:24px; font-size:13.5px; }
    .timbre { display:flex; align-items:center; gap:13px; border-bottom:2px solid #000; padding-bottom:11px; margin-bottom:14px; }
    .timbre img { height:42px; }
    .timbre .marca { font-size:18px; font-weight:700; letter-spacing:0.3px; }
    .timbre .contato { font-size:10px; line-height:1.45; }
    .sheet { max-width:860px; margin:0 auto; padding:24px 32px; }
    h1 { font-size:19px; font-weight:700; text-align:center; margin:0; }
    h2 { font-size:14px; text-align:center; font-weight:400; margin:4px 0 20px; }
    h3 { font-size:13px; font-weight:700; border-bottom:1px solid #000; padding-bottom:4px; margin:24px 0 6px; }
    table { width:100%; border-collapse:collapse; }
    th { text-align:left; font-size:11px; letter-spacing:0.4px; text-transform:uppercase; border-bottom:1px solid #000; padding:6px 8px; }
    td { padding:5px 8px; border-bottom:1px solid #e6e6e6; }
    td.r, th.r { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
    td.b { font-weight:700; }
    tr.total td { border-top:1px solid #000; border-bottom:3px double #000; font-weight:700; }
    .resumo { width:auto; margin:0 auto 6px; }
    .resumo td { border:none; padding:3px 14px; font-size:14px; }
    .muted { color:#555; font-size:12px; }
    .nota { font-size:11.5px; color:#333; margin:6px 0 0; }
    .foot { margin-top:32px; padding-top:10px; border-top:1px solid #000; text-align:center; font-size:11px; line-height:1.6; }
    ${barra.css}
    @media print { body { padding:0; } .sheet { padding:0; } }
  </style></head><body>
  <div class="timbre">
    <img src="https://peaceontax-portal.vercel.app/logo.png" alt="${esc(FIRM.name)}" />
    <div><div class="marca">${esc(FIRM.name)}</div>
      <div class="contato">${esc(FIRM.address)}<br>${esc(FIRM.phone)} &middot; ${esc(FIRM.email)} &middot; peaceontax.com</div></div>
  </div>
  ${barra.html}
  <div class="sheet">
    <h1>${esc(opts.titulo)}</h1>
    <h2>${esc(opts.periodo)}</h2>
    ${resumo}
    ${secoes}
    <div class="foot">${esc(FIRM.name)} · ${esc(FIRM.address)} · ${esc(FIRM.phone)}<br>Relatório interno do sócio · gerado em ${fmtUS(new Date().toISOString())} · confidencial</div>
  </div>
  </body></html>`
}
