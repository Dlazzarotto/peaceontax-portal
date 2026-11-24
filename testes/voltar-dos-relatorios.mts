// testes/voltar-dos-relatorios.mts — para onde o Voltar de um relatório leva
//
// O relatório abre em aba nova. Quando o Voltar não consegue fechá-la (app
// instalado no celular, link salvo), ele navega — e navegava para a central
// de bookkeeping (staff) ou para a tela inicial do Financeiro: "o voltar vai
// para o menu principal". Aqui: o endereço exato da tela de origem (ficha do
// cliente na aba Bookkeeping → Relatórios, caixa da firma, portal, Financeiro
// com o quadro aberto), no período em que estava, e o módulo que grava e lê
// esses parâmetros na URL da tela.

import { voltarDosRelatoriosContabeis, voltarDosRelatoriosDoFinanceiro, barraDoRelatorio } from '../lib/relatorio-barra.ts'
import { comParametros } from '../lib/url-da-tela.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const params = (url: string) => Object.fromEntries(new URL(url, 'https://x.test').searchParams)
const caminho = (url: string) => new URL(url, 'https://x.test').pathname

const cli = '3f2a9c1e-0000-4000-8000-000000000abc'

// ── Relatórios contábeis ──────────────────────────────────────────────────
{
  const u = voltarDosRelatoriosContabeis({ isClient: false, clientId: cli, ehFirma: false, de: '2025-01-01', ate: '2025-12-31' })
  eq('equipe: a ficha do cliente', caminho(u), `/clients/${cli}`)
  eq('…na aba Bookkeeping → Relatórios, no período', params(u), { aba: 'bookkeeping', vista: 'reports', de: '2025-01-01', ate: '2025-12-31' })
}
{
  const u = voltarDosRelatoriosContabeis({ isClient: false, clientId: cli, ehFirma: true, de: '2026-10-01', ate: '2026-10-31' })
  eq('o livro da firma volta ao caixa, não a uma ficha de cliente', caminho(u), '/dashboard/caixa')
  eq('…na aba Relatórios do livro', params(u), { vista: 'reports', de: '2026-10-01', ate: '2026-10-31' })
}
{
  const u = voltarDosRelatoriosContabeis({ isClient: true, clientId: cli, ehFirma: false, de: '2025-01-01', ate: '2025-12-31' })
  eq('cliente: a Contabilidade do portal', caminho(u), '/portal/reports')
  eq('…no período, sem aba de equipe', params(u), { de: '2025-01-01', ate: '2025-12-31' })
}
eq('cliente nunca vai para a caixa da firma, mesmo com ehFirma',
  caminho(voltarDosRelatoriosContabeis({ isClient: true, clientId: cli, ehFirma: true })), '/portal/reports')
eq('sem período, só a aba', params(voltarDosRelatoriosContabeis({ isClient: false, clientId: cli, ehFirma: false })),
  { aba: 'bookkeeping', vista: 'reports' })
eq('portal sem período: o endereço puro', voltarDosRelatoriosContabeis({ isClient: true, clientId: cli, ehFirma: false }), '/portal/reports')
eq('data inválida não entra', params(voltarDosRelatoriosContabeis({ isClient: false, clientId: cli, ehFirma: false, de: '2025-13', ate: '2025-12-31' })),
  { aba: 'bookkeeping', vista: 'reports' })
eq('período invertido não entra', params(voltarDosRelatoriosContabeis({ isClient: false, clientId: cli, ehFirma: false, de: '2025-12-31', ate: '2025-01-01' })),
  { aba: 'bookkeeping', vista: 'reports' })
eq('só uma das pontas não entra', params(voltarDosRelatoriosContabeis({ isClient: false, clientId: cli, ehFirma: false, de: null, ate: '2025-12-31' })),
  { aba: 'bookkeeping', vista: 'reports' })
{
  const u = voltarDosRelatoriosContabeis({ isClient: false, clientId: '../../dashboard?x=1#y', ehFirma: false })
  eq('id estranho não sai da ficha: fica codificado no caminho', caminho(u), '/clients/..%2F..%2Fdashboard%3Fx%3D1%23y')
}

// ── Financeiro ────────────────────────────────────────────────────────────
eq('Financeiro: o quadro de relatórios aberto, no período',
  voltarDosRelatoriosDoFinanceiro('2026-01-01', '2026-11-24'), '/dashboard/billing?relatorios=1&de=2026-01-01&ate=2026-11-24')
eq('Financeiro sem período válido: só o quadro', voltarDosRelatoriosDoFinanceiro('x', '2026-11-24'), '/dashboard/billing?relatorios=1')

// ── A barra aceita esses destinos (só caminho interno) ────────────────────
for (const u of [
  voltarDosRelatoriosContabeis({ isClient: false, clientId: cli, ehFirma: false, de: '2025-01-01', ate: '2025-12-31' }),
  voltarDosRelatoriosContabeis({ isClient: false, clientId: cli, ehFirma: true }),
  voltarDosRelatoriosContabeis({ isClient: true, clientId: cli, ehFirma: false }),
  voltarDosRelatoriosDoFinanceiro('2026-01-01', '2026-02-01'),
]) {
  const { html } = barraDoRelatorio({ voltarPara: u })
  eq(`a barra leva o destino exato: ${caminho(u)}`, html.includes(`data-destino="${u.replace(/&/g, '&amp;')}"`), true)
}
eq('destino de fora continua recusado pela barra',
  barraDoRelatorio({ voltarPara: '//evil.test/x' }).html.includes('data-destino="/dashboard"'), true)

// ── A tela grava e lê os mesmos nomes ─────────────────────────────────────
eq('grava a aba sem perder o que já estava', comParametros('/clients/1?x=2', { aba: 'bookkeeping' }), '/clients/1?x=2&aba=bookkeeping')
eq('troca o valor', comParametros('/clients/1?aba=documents', { aba: 'bookkeeping' }), '/clients/1?aba=bookkeeping')
eq('null tira o parâmetro', comParametros('/clients/1?aba=bookkeeping&vista=reports&de=2025-01-01', { vista: null, de: null }), '/clients/1?aba=bookkeeping')
eq('vazio também tira', comParametros('/dashboard/caixa?vista=reports', { vista: '' }), '/dashboard/caixa')
eq('mantém o #', comParametros('/portal/reports#topo', { de: '2025-01-01', ate: '2025-12-31' }), '/portal/reports?de=2025-01-01&ate=2025-12-31#topo')
eq('valor com & e espaço vai codificado', params(comParametros('/x', { a: 'b&c d' })), { a: 'b&c d' })
{
  // Ida e volta: o endereço que a rota monta é o que a tela lê.
  const u = voltarDosRelatoriosContabeis({ isClient: false, clientId: cli, ehFirma: false, de: '2025-04-01', ate: '2025-06-30' })
  const p = new URLSearchParams(u.slice(u.indexOf('?') + 1))
  eq('a ficha lê "aba" e o livro lê "vista", "de" e "ate"', [p.get('aba'), p.get('vista'), p.get('de'), p.get('ate')],
    ['bookkeeping', 'reports', '2025-04-01', '2025-06-30'])
  eq('sair do livro limpa o que é dele (o que a ficha grava ao trocar de aba)',
    comParametros(u, { aba: 'documents', vista: null, de: null, ate: null }), `/clients/${cli}?aba=documents`)
}

console.log(`voltar-dos-relatorios: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
