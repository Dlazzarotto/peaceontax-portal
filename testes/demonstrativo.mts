// testes/demonstrativo.mts — o desenho do Balanço e do P&L (formato QuickBooks)
//
// Decisão do sócio (11/2026): o demonstrativo é do cliente — a empresa dele
// no topo, a Peace on Tax só no rodapé, pequena e sem logo — e no formato do
// QuickBooks (o modelo foi um Balance Sheet exportado de lá). Aqui: os
// números como o QuickBooks escreve, o carimbo do rodapé no fuso do
// escritório (o do modelo: "Wednesday, February 26, 2025 07:33 PM
// GMT-05:00"), as sub-contas debaixo da mãe, o período do P&L e o HTML: sem
// timbre, com o nome escapado e os avisos fora do impresso.

import {
  valorDaConta, valorDoTotal, carimboDoRodape, linhasDasContas, htmlDoDemonstrativo,
} from '../lib/demonstrativo.ts'
import { periodoNoPadraoQB } from '../lib/periodo-relatorio.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const sim = (n: string, c: boolean) => eq(n, c, true)

// ── Números, como no modelo ───────────────────────────────────────────────
eq('conta: milhar e centavos, sem cifrão', valorDaConta(173912), '1,739.12')
eq('conta: negativa com sinal de menos', valorDaConta(-548112), '-5,481.12')
eq('conta: zerada fica em branco', valorDaConta(0), '')
eq('conta: centavos', valorDaConta(5), '0.05')
eq('conta: centavos negativos', valorDaConta(-5), '-0.05')
eq('conta: milhões', valorDaConta(48395915), '483,959.15')
eq('total: com cifrão', valorDoTotal(58106409), '$581,064.09')
eq('total: negativo como o QuickBooks escreve', valorDoTotal(-3311934), '$ -33,119.34')
eq('total: zero aparece', valorDoTotal(0), '$0.00')
eq('total: valor não finito vira zero', valorDoTotal(NaN), '$0.00')

// ── Rodapé no fuso do escritório ──────────────────────────────────────────
eq('carimbo do modelo (inverno, GMT-05:00)', carimboDoRodape(new Date('2025-02-27T00:33:00Z')), 'Wednesday, February 26, 2025 07:33 PM GMT-05:00')
eq('carimbo no horário de verão (GMT-04:00)', carimboDoRodape(new Date('2026-07-01T16:05:00Z')), 'Wednesday, July 1, 2026 12:05 PM GMT-04:00')
eq('às 20h de Malden o servidor já está no dia seguinte: vale o dia do escritório', carimboDoRodape(new Date('2026-11-26T01:00:00Z')), 'Wednesday, November 25, 2026 08:00 PM GMT-05:00')

// ── Período do P&L ────────────────────────────────────────────────────────
eq('ano inteiro', periodoNoPadraoQB('2024-01-01', '2024-12-31'), 'January - December 2024')
eq('mês inteiro', periodoNoPadraoQB('2026-10-01', '2026-10-31'), 'October 2026')
eq('trimestre', periodoNoPadraoQB('2026-07-01', '2026-09-30'), 'July - September 2026')
eq('fevereiro bissexto inteiro', periodoNoPadraoQB('2024-02-01', '2024-02-29'), 'February 2024')
eq('do começo do ano até hoje', periodoNoPadraoQB('2026-01-01', '2026-11-25'), 'January 1 - November 25, 2026')
eq('meses que atravessam o ano', periodoNoPadraoQB('2025-12-01', '2026-01-31'), 'December 2025 - January 2026')
eq('datas que atravessam o ano', periodoNoPadraoQB('2025-12-15', '2026-01-15'), 'December 15, 2025 - January 15, 2026')
eq('um dia só', periodoNoPadraoQB('2026-03-05', '2026-03-05'), 'March 5, 2026')

// ── Contas e sub-contas ───────────────────────────────────────────────────
{
  const ls = linhasDasContas([
    { conta: 'Utilities: Gas', valor: 3000 },
    { conta: 'Rent', valor: 120000 },
    { conta: 'Utilities', valor: 500 },
    { conta: 'Utilities: Electric', valor: 7000 },
    { conta: 'advertising', valor: 100 },
  ], 1, c => `/d?c=${c}`)
  eq('ordem alfabética sem diferença de maiúscula; sub-contas debaixo da mãe', ls.map(l => `${l.tipo}|${l.nivel}|${l.rotulo}|${l.valor ?? ''}|${l.href ?? ''}`), [
    'conta|1|advertising|100|/d?c=advertising',
    'conta|1|Rent|120000|/d?c=Rent',
    'titulo|1|Utilities||',
    'conta|2|Electric|7000|/d?c=Utilities: Electric',
    'conta|2|Gas|3000|/d?c=Utilities: Gas',
    'conta|2|Utilities - Other|500|/d?c=Utilities',
    'total|1|Total Utilities|10500|',
  ])
  const semDireto = linhasDasContas([{ conta: 'Loans: GM Financial', valor: -548112 }], 4)
  eq('mãe só com filha: sem a linha "- Other"', semDireto.map(l => `${l.tipo}|${l.rotulo}|${l.valor ?? ''}`), [
    'titulo|Loans|', 'conta|GM Financial|-548112', 'total|Total Loans|-548112',
  ])
  eq('sem link quando não se pede', semDireto.some(l => l.href), false)
}

// ── A página ──────────────────────────────────────────────────────────────
{
  const html = htmlDoDemonstrativo({
    empresa: 'Activation <script>alert(1)</script> Church',
    titulo: 'Balance Sheet', periodo: 'As of December 31, 2024',
    linhas: [
      { tipo: 'titulo', rotulo: 'ASSETS', nivel: 0 },
      { tipo: 'conta', rotulo: 'Conta <b>x</b>', nivel: 3, valor: 173912, href: '/api/x?a=1&b="2"' },
      { tipo: 'total', rotulo: 'Total Bank Accounts', nivel: 2, valor: 173912 },
      { tipo: 'totalGeral', rotulo: 'TOTAL ASSETS', nivel: 0, valor: 173912 },
    ],
    agora: new Date('2025-02-27T00:33:00Z'), regime: 'Cash Basis',
    meta: '<meta name="viewport" content="width=device-width, initial-scale=1">',
    barra: { css: '.barra{}', html: '<div class="barra-relatorio"></div>' },
    avisos: ['3 transaction(s) <awaiting>'],
    notas: { titulo: 'Notas', frases: ['a & b'], tabela: { cabecalho: ['Conta'], linhas: [['<i>c</i>']] } },
  })
  sim('nome da empresa escapado', html.includes('Activation &lt;script&gt;alert(1)&lt;/script&gt; Church') && !html.includes('<script>alert(1)'))
  sim('nome da conta escapado', html.includes('Conta &lt;b&gt;x&lt;/b&gt;'))
  sim('link escapado no atributo', html.includes('href="/api/x?a=1&amp;b=&quot;2&quot;"'))
  sim('sem logo no cabeçalho', !/logo\.png|<img/i.test(html))
  sim('sem endereço nem telefone da firma', !/75 Pleasant|833\) 732|info@peaceontax/.test(html))
  sim('a firma só no rodapé, pequena', /<div class="rodape">[\s\S]*Prepared by Peace on Tax Corp/.test(html) && (html.match(/Peace on Tax/g) || []).length === 1)
  sim('rodapé com regime e carimbo', html.includes('Cash Basis&nbsp;&nbsp;Wednesday, February 26, 2025 07:33 PM GMT-05:00'))
  sim('coluna TOTAL', /<th class="v">TOTAL<\/th>/.test(html))
  sim('conta sem cifrão, total com cifrão', html.includes('>1,739.12<') && html.includes('<div>$1,739.12</div>'))
  sim('total geral com linha dupla', /tr class="total geral"/.test(html) && /border-bottom: 3px double/.test(html))
  sim('recuo do total começa no grupo', html.includes('<div style="margin-left:20px">Total Bank Accounts</div>'))
  sim('avisos e notas só na tela', /<div class="so-tela">[\s\S]*3 transaction\(s\) &lt;awaiting&gt;/.test(html) && /@media print[\s\S]*\.so-tela \{ display: none !important; \}/.test(html))
  sim('notas escapadas', html.includes('a &amp; b') && html.includes('&lt;i&gt;c&lt;/i&gt;'))
  sim('a barra entra na página', html.includes('<div class="barra-relatorio"></div>') && html.includes('.barra{}'))
  sim('viewport', html.includes('name="viewport"'))
  sim('título da aba escapado', html.includes('<title>Balance Sheet — Activation &lt;script&gt;alert(1)&lt;/script&gt; Church — As of December 31, 2024</title>'))
  sim('a empresa vai em caixa alta, como no modelo', /\.cab \.empresa \{[^}]*text-transform: uppercase/.test(html))
  sim('o rodapé fica no pé da página impressa, e o tfoot guarda o lugar', /\.rodape \{ position: fixed;[^}]*bottom: 0/.test(html) && /table\.dem tfoot \{ display: table-footer-group; \}/.test(html))
  const semNotas = htmlDoDemonstrativo({
    empresa: 'X', titulo: 'Profit and Loss', periodo: 'October 2026', linhas: [], agora: new Date(), regime: 'Cash Basis',
    meta: '', barra: { css: '', html: '' },
  })
  sim('sem avisos nem notas: nada de bloco da tela', !semNotas.includes('class="so-tela"'))
}

console.log(`demonstrativo: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
