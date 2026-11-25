// lib/demonstrativo.ts — o demonstrativo contábil do cliente no formato do
// QuickBooks: Balanço e DRE (P&L).
//
// Decisão do sócio (11/2026): o demonstrativo é DO CLIENTE. No topo vai só a
// empresa dele, o nome do relatório e a data ou o período, centralizados; a
// Peace on Tax sai do cabeçalho (nada de timbre nem logo) e fica só no
// rodapé, em letra pequena. É o formato que o cliente conhece do QuickBooks
// (o modelo foi um Balance Sheet exportado de lá):
//   · uma coluna TOTAL, com linha em cima e embaixo do título dela;
//   · as contas recuadas por grupo, sem cifrão; conta zerada fica em branco;
//   · cada "Total …" em negrito, com cifrão e um traço em cima, que começa no
//     recuo do grupo;
//   · os totais finais (TOTAL ASSETS, NET INCOME…) com linha dupla embaixo;
//   · negativo com sinal de menos, nunca parênteses: "-5,481.12" na conta e
//     "$ -33,119.34" no total, como o QuickBooks escreve;
//   · rodapé cinza: o regime (Cash Basis) e o momento em que foi gerado, no
//     fuso do escritório.
//
// Módulo puro: as duas rotas montam as linhas e chamam `htmlDoDemonstrativo`.
// Tudo o que vem do banco (nome da empresa, das contas) é escapado AQUI — a
// rota não interpola texto em HTML.

import { escaparHtml } from './relatorio-barra.ts'

export type TipoDaLinha = 'titulo' | 'conta' | 'total' | 'totalGeral'

export interface LinhaDoDemonstrativo {
  tipo: TipoDaLinha
  rotulo: string
  /** 0 = grupo de fora (ASSETS, Income); cada nível recua um passo. */
  nivel: number
  /** Em CENTAVOS, já com o sinal de exibição. Título não tem valor. */
  valor?: number
  /** Link para o detalhe da conta (as contas do P&L). */
  href?: string
}

const inteiro = (c: number) => Number.isFinite(c) ? Math.round(c) : 0

function digitos(centavos: number): string {
  const abs = Math.abs(inteiro(centavos))
  const reais = Math.floor(abs / 100).toLocaleString('en-US')
  return `${reais}.${String(abs % 100).padStart(2, '0')}`
}

/** Valor de CONTA: "1,739.12", "-5,481.12"; zero fica em branco, como no QuickBooks. */
export function valorDaConta(centavos: number): string {
  const c = inteiro(centavos)
  if (c === 0) return ''
  return `${c < 0 ? '-' : ''}${digitos(c)}`
}

/** Valor de TOTAL: "$581,064.09", "$ -33,119.34", "$0.00". */
export function valorDoTotal(centavos: number): string {
  const c = inteiro(centavos)
  return c < 0 ? `$ -${digitos(c)}` : `$${digitos(c)}`
}

/**
 * "Tuesday, November 25, 2026 10:05 AM GMT-05:00" — o carimbo do rodapé, no
 * fuso do escritório (e não no do servidor, que é UTC: às 20h de Malden o
 * servidor já está no dia seguinte).
 */
export function carimboDoRodape(agora: Date, fuso = 'America/New_York'): string {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone: fuso, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true, timeZoneName: 'longOffset',
  }).formatToParts(agora)) p[x.type] = x.value
  // No meridiano zero o Intl escreve só "GMT"; o QuickBooks escreve o deslocamento.
  const fusoTxt = !p.timeZoneName || p.timeZoneName === 'GMT' ? 'GMT+00:00' : p.timeZoneName
  return `${p.weekday}, ${p.month} ${p.day}, ${p.year} ${p.hour}:${p.minute} ${String(p.dayPeriod || '').toUpperCase()} ${fusoTxt}`
}

/** "Mãe: Filha" → "Mãe"; conta sem mãe → null (a mesma regra do P&L). */
function maeDe(conta: string): string | null {
  const i = conta.indexOf(':')
  return i > 0 ? conta.slice(0, i).trim() : null
}

/**
 * As contas de um grupo, em ordem alfabética, com as sub-contas ("Mãe:
 * Filha") debaixo da mãe e o "Total <Mãe>" delas — como o QuickBooks mostra.
 * O lançamento feito direto na mãe que tem filhas vira a linha "<Mãe> - Other"
 * (o nome que o QuickBooks Desktop dá a ela). Os valores chegam em centavos e
 * já com o sinal de exibição.
 */
export function linhasDasContas(
  itens: readonly { conta: string; valor: number }[],
  nivel: number,
  hrefDe?: (conta: string) => string,
): LinhaDoDemonstrativo[] {
  const grupos = new Map<string, { direto: number; temDireto: boolean; filhas: { conta: string; nome: string; valor: number }[] }>()
  for (const it of itens) {
    const mae = maeDe(it.conta)
    const chave = mae ?? it.conta.trim()
    const g = grupos.get(chave) || { direto: 0, temDireto: false, filhas: [] }
    if (mae) g.filhas.push({ conta: it.conta, nome: it.conta.slice(it.conta.indexOf(':') + 1).trim(), valor: inteiro(it.valor) })
    else { g.direto += inteiro(it.valor); g.temDireto = true }
    grupos.set(chave, g)
  }
  const ordem = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })
  const linhas: LinhaDoDemonstrativo[] = []
  for (const mae of Array.from(grupos.keys()).sort(ordem)) {
    const g = grupos.get(mae)!
    const href = (c: string) => (hrefDe ? hrefDe(c) : undefined)
    if (g.filhas.length === 0) {
      linhas.push({ tipo: 'conta', rotulo: mae, nivel, valor: g.direto, href: href(mae) })
      continue
    }
    linhas.push({ tipo: 'titulo', rotulo: mae, nivel })
    for (const f of g.filhas.sort((a, b) => ordem(a.nome, b.nome))) {
      linhas.push({ tipo: 'conta', rotulo: f.nome, nivel: nivel + 1, valor: f.valor, href: href(f.conta) })
    }
    if (g.temDireto && g.direto !== 0) linhas.push({ tipo: 'conta', rotulo: `${mae} - Other`, nivel: nivel + 1, valor: g.direto, href: href(mae) })
    linhas.push({ tipo: 'total', rotulo: `Total ${mae}`, nivel, valor: g.direto + g.filhas.reduce((s, f) => s + f.valor, 0) })
  }
  return linhas
}

const PASSO = 10      // px de recuo por nível
const MARGEM = 6      // px antes do nível 0

function linhaHtml(l: LinhaDoDemonstrativo): string {
  const recuo = MARGEM + Math.max(0, l.nivel) * PASSO
  const texto = l.href
    ? `<a class="conta" href="${escaparHtml(l.href)}" title="Open the transactions in this account">${escaparHtml(l.rotulo)}</a>`
    : escaparHtml(l.rotulo)
  if (l.tipo === 'titulo') return `<tr class="titulo"><td style="padding-left:${recuo}px">${texto}</td><td class="v"></td></tr>`
  if (l.tipo === 'conta') return `<tr class="conta"><td style="padding-left:${recuo}px">${texto}</td><td class="v">${valorDaConta(l.valor ?? 0)}</td></tr>`
  // Total: o traço de cima começa no recuo do grupo (o rótulo vai num bloco
  // com margem, e o traço é dele) e segue até a borda pela célula do valor.
  const classe = l.tipo === 'totalGeral' ? 'total geral' : 'total'
  return `<tr class="${classe}"><td><div style="margin-left:${recuo - MARGEM}px">${texto}</div></td><td class="v"><div>${valorDoTotal(l.valor ?? 0)}</div></td></tr>`
}

export interface Demonstrativo {
  /** Empresa do cliente — vai em caixa alta, como no QuickBooks. */
  empresa: string
  /** "Balance Sheet", "Profit and Loss". */
  titulo: string
  /** "As of December 31, 2024", "January - December 2024". */
  periodo: string
  linhas: readonly LinhaDoDemonstrativo[]
  /** Momento em que foi gerado (rodapé). */
  agora: Date
  /** "Cash Basis" — o regime do livro. */
  regime: string
  /** META_RELATORIO (viewport) — obrigatório em todo impresso. */
  meta: string
  /** barraDoRelatorio(...): Voltar, Painel, Imprimir. */
  barra: { css: string; html: string }
  /** Avisos que aparecem só na TELA, nunca no impresso (texto puro). */
  avisos?: readonly string[]
  /** Notas da equipe, só na tela: um título, frases e uma tabela (texto puro). */
  notas?: { titulo: string; frases?: readonly string[]; tabela?: { cabecalho: readonly string[]; linhas: readonly (readonly string[])[] } }
}

/** A página inteira, pronta para abrir, imprimir ou salvar em PDF. */
export function htmlDoDemonstrativo(d: Demonstrativo): string {
  const avisos = (d.avisos || []).filter(Boolean)
  const notas = d.notas
  const tabelaDeNotas = notas?.tabela && notas.tabela.linhas.length
    ? `<table class="notas-tabela"><thead><tr>${notas.tabela.cabecalho.map(c => `<th>${escaparHtml(c)}</th>`).join('')}</tr></thead>
       <tbody>${notas.tabela.linhas.map(l => `<tr>${l.map(c => `<td>${escaparHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : ''
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${d.meta}
<title>${escaparHtml([d.titulo, d.empresa, d.periodo].join(' — '))}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { background: #eef0f3; color: #1d1f22; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }
  .folha { background: #fff; width: 100%; max-width: 8.5in; min-height: 11in; margin: 84px auto 28px; padding: 0.55in 0.5in 0.4in;
           box-shadow: 0 1px 4px rgba(0, 0, 0, 0.14); display: flex; flex-direction: column; }
  .cab { text-align: center; margin-bottom: 30px; }
  .cab .empresa { font-size: 20px; font-weight: 400; text-transform: uppercase; letter-spacing: 0.2px; }
  .cab .titulo { font-size: 15px; margin-top: 10px; }
  .cab .periodo { font-size: 12.5px; margin-top: 7px; }
  table.dem { width: 100%; border-collapse: collapse; font-size: 12.5px; line-height: 1.25; }
  table.dem thead th { font-weight: 400; font-size: 11px; letter-spacing: 0.4px; text-align: right; padding: 5px 6px 4px;
                       border-top: 1px solid #5f6368; border-bottom: 1px solid #5f6368; }
  table.dem td { padding: 3px 6px 3px; vertical-align: bottom; }
  table.dem td.v { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; width: 10em; }
  table.dem tr.total td { padding: 0; font-weight: 700; }
  table.dem tr.total td div { border-top: 1px solid #b6b9be; padding: 4px 6px 4px; }
  table.dem tr.total td.v div { text-align: right; }
  table.dem tr.total.geral td { border-bottom: 3px double #5f6368; }
  table.dem tr.total.geral td div { border-top-color: #5f6368; }
  table.dem a.conta { color: inherit; text-decoration: none; }
  table.dem a.conta:hover { text-decoration: underline; }
  table.dem tfoot td { padding: 0; height: 0; border: 0; }
  .rodape { margin-top: auto; padding-top: 34px; text-align: center; color: #9aa0a6; }
  .rodape .base { font-size: 9.5px; font-weight: 700; letter-spacing: 0.2px; }
  .rodape .firma { font-size: 8px; margin-top: 3px; }
  .so-tela { max-width: 8.5in; margin: 0 auto 28px; font-size: 12.5px; line-height: 1.5; color: #3c4043; }
  .avisos { border: 1px solid #d6a700; background: #fff8e1; padding: 9px 12px; margin-bottom: 10px; }
  .notas { border: 1px solid #d0d4da; background: #fff; padding: 10px 14px; }
  .notas h4 { margin: 0 0 6px; font-size: 12.5px; }
  .notas p { margin: 4px 0; }
  table.notas-tabela { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
  table.notas-tabela th, table.notas-tabela td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #e6e8eb; }
  ${d.barra.css}
  @media screen and (max-width: 700px) {
    body { background: #fff; }
    .folha { margin: 0; min-height: 0; padding: 22px 14px 18px; box-shadow: none; }
    .so-tela { padding: 0 14px; }
    table.dem { font-size: 12px; }
    table.dem td.v { width: 8.5em; }
  }
  @page { size: letter; margin: 0.5in 0.5in 0.45in; }
  @media print {
    body { background: #fff; }
    .folha { margin: 0; max-width: none; min-height: 0; padding: 0; box-shadow: none; display: block; }
    .so-tela { display: none !important; }
    table.dem a.conta { text-decoration: none; }
    table.dem thead { display: table-header-group; }
    /* O rodape fica no pe de cada pagina; o tfoot repete em cada pagina e
       guarda o lugar dele, para nenhuma linha passar por baixo. */
    table.dem tfoot { display: table-footer-group; }
    table.dem tfoot td { height: 0.42in; }
    .rodape { position: fixed; left: 0; right: 0; bottom: 0; padding-top: 0; }
    table.dem tr { page-break-inside: avoid; break-inside: avoid; }
  }
</style></head><body>
${d.barra.html}
<div class="folha">
  <div class="cab">
    <div class="empresa">${escaparHtml(d.empresa)}</div>
    <div class="titulo">${escaparHtml(d.titulo)}</div>
    <div class="periodo">${escaparHtml(d.periodo)}</div>
  </div>
  <table class="dem">
    <thead><tr><th></th><th class="v">TOTAL</th></tr></thead>
    <tfoot><tr><td></td><td></td></tr></tfoot>
    <tbody>
${d.linhas.map(linhaHtml).join('\n')}
    </tbody>
  </table>
  <div class="rodape">
    <div class="base">${escaparHtml(d.regime)}&nbsp;&nbsp;${escaparHtml(carimboDoRodape(d.agora))}</div>
    <div class="firma">Prepared by Peace on Tax Corp</div>
  </div>
</div>
${avisos.length || notas ? `<div class="so-tela">
  ${avisos.length ? `<div class="avisos">${avisos.map(a => `<div>${escaparHtml(a)}</div>`).join('')}</div>` : ''}
  ${notas ? `<div class="notas"><h4>${escaparHtml(notas.titulo)}</h4>${(notas.frases || []).map(f => `<p>${escaparHtml(f)}</p>`).join('')}${tabelaDeNotas}</div>` : ''}
</div>` : ''}
</body></html>`
}
