// lib/relatorio-barra.ts — barra fixa dos relatórios impressos: Voltar + Imprimir.
//
// Todo relatório em HTML (P&L, balanço, fornecedores, detalhe de conta,
// fatura) usa a mesma barra, para o comportamento ser um só:
//   Voltar   → veio de OUTRO relatório nesta aba (P&L → detalhe da conta):
//              volta a ele pelo histórico;
//              abriu em aba nova (window.open da tela): fecha a aba — a tela
//              de origem continua como estava, na aba e no período;
//              aberto nesta mesma aba a partir de uma tela nossa: histórico;
//              sem nada disso (app instalado no celular, link salvo, aba que o
//              navegador não deixa fechar): vai para `voltarPara`, que é a
//              tela EXATA de onde o relatório saiu (voltarDosRelatoriosContabeis).
//              Antes era `/dashboard/bookkeeping` — a central, sem o cliente e
//              sem a aba Relatórios: "o voltar vai para o menu principal".
//              E o caso "fui ao detalhe e voltei" deixava o botão MUDO: o
//              histórico da aba tinha duas páginas, ele tentava voltar e não
//              havia para onde.
//   Painel   → destino FIXO, sempre. O Voltar depende do histórico e de o
//              navegador deixar fechar a aba — em celular, quem abriu o
//              relatório por um link ficava sem caminho de volta. Este não
//              depende de nada: navega para /dashboard (ou /portal, no
//              relatório do cliente).
//   Imprimir → window.print(); a barra some na impressão.
//
// SEGURANÇA: nada do que vem de fora entra dentro do <script>. O destino vai
// num atributo `data-destino` escapado, e o script é fixo — assim um parâmetro
// da URL com "</script>" não consegue fechar o bloco e injetar código. Um valor
// interpolado dentro de script por JSON.stringify NÃO é seguro: o JSON não
// escapa "</script>", e o parser de HTML fecha o bloco antes do JavaScript ler.

/**
 * Cabeçalho obrigatório de todo impresso. Sem o viewport, o celular renderiza
 * a página a ~980px e desenha tudo reduzido: o texto fica ilegível e a barra
 * de botões sai do alcance do dedo — o Voltar existia e não dava para clicar.
 * Nenhum dos oito impressos tinha esta linha.
 */
export const META_RELATORIO = '<meta name="viewport" content="width=device-width, initial-scale=1">'

const DATA = /^\d{4}-\d{2}-\d{2}$/
const periodoDaVolta = (q: URLSearchParams, de?: string | null, ate?: string | null) => {
  if (de && ate && DATA.test(de) && DATA.test(ate) && de <= ate) { q.set('de', de); q.set('ate', ate) }
}

/**
 * A tela de onde saem os relatórios contábeis (P&L, Balanço, Fornecedores,
 * 1099), na aba Relatórios e no período escolhido — o destino do Voltar
 * quando não há histórico nem aba para fechar. Cada tela lê estes parâmetros
 * ao abrir: a ficha do cliente (`aba`), o livro (`vista`, `de`, `ate`,
 * components/BookkeepingTab.tsx) e o portal (`de`, `ate`).
 */
export function voltarDosRelatoriosContabeis(o: {
  isClient: boolean; clientId: string; ehFirma: boolean; de?: string | null; ate?: string | null
}): string {
  const q = new URLSearchParams()
  let base = '/portal/reports'
  if (!o.isClient && o.ehFirma) { base = '/dashboard/caixa'; q.set('vista', 'reports') }
  else if (!o.isClient) {
    base = `/clients/${encodeURIComponent(o.clientId)}`
    q.set('aba', 'bookkeeping'); q.set('vista', 'reports')
  }
  periodoDaVolta(q, o.de, o.ate)
  const s = q.toString()
  return s ? `${base}?${s}` : base
}

/** O mesmo para os relatórios do Financeiro: a tela com o quadro de relatórios aberto. */
export function voltarDosRelatoriosDoFinanceiro(de?: string | null, ate?: string | null): string {
  const q = new URLSearchParams({ relatorios: '1' })
  periodoDaVolta(q, de, ate)
  return `/dashboard/billing?${q}`
}

/** Escapa texto para dentro de HTML (inclusive atributo com aspas duplas). */
export function escaparHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function barraDoRelatorio(opts: {
  /** caminho interno para onde ir quando não dá para voltar nem fechar (ex.: /dashboard/bookkeeping) */
  voltarPara: string
  /** destino fixo do botão Painel; padrão /dashboard, e /portal no relatório do cliente */
  painelPara?: string
  rotuloVoltar?: string
  rotuloPainel?: string
  rotuloImprimir?: string
}): { css: string; html: string } {
  // Só caminho interno: nunca uma URL de outro site nem javascript:
  const interno = (v: string | undefined, padrao: string) =>
    v && /^\/[^/\\]/.test(v) ? v : padrao
  const destino = interno(opts.voltarPara, '/dashboard')
  const painel = interno(opts.painelPara, '/dashboard')

  const css = `
  .barra-relatorio { position:fixed; top:14px; right:14px; display:flex; gap:8px; z-index:10; }
  .barra-relatorio button { border:none; font-family:inherit; font-size:15px; font-weight:700; padding:13px 20px; border-radius:8px; cursor:pointer; min-height:48px; }
  .barra-relatorio .voltar, .barra-relatorio .painel { background:#fff; color:#2D3278; border:1.5px solid #2D3278; }
  .barra-relatorio .imprimir { background:#2D3278; color:#fff; }
  @media screen and (max-width:640px) {
    .barra-relatorio { top:8px; right:8px; left:8px; justify-content:flex-end; flex-wrap:wrap; }
    .barra-relatorio button { font-size:14px; padding:11px 14px; }
    /* A barra e fixa e no celular quebra em duas linhas: sem esta folga ela
       cobriria o timbre do relatorio. Vale so na tela — na impressao ela some. */
    body { padding-top:118px; }
  }
  @media print { .barra-relatorio { display:none !important; } }`

  const html = `
  <div class="barra-relatorio">
    <button type="button" class="voltar" data-destino="${escaparHtml(destino)}">← ${escaparHtml(opts.rotuloVoltar || 'Voltar')}</button>
    <button type="button" class="painel" data-painel="${escaparHtml(painel)}">🏠 ${escaparHtml(opts.rotuloPainel || (painel.startsWith('/portal') ? 'Meu portal' : 'Dashboard'))}</button>
    <button type="button" class="imprimir">🖨️ ${escaparHtml(opts.rotuloImprimir || 'Print / Save PDF')}</button>
  </div>
  <script>
    (function () {
      var barra = document.querySelector('.barra-relatorio')
      if (!barra) return
      var voltar = barra.querySelector('.voltar')
      var painel = barra.querySelector('.painel')
      var imprimir = barra.querySelector('.imprimir')
      if (imprimir) imprimir.addEventListener('click', function () { window.print() })
      if (painel) painel.addEventListener('click', function () {
        var d = painel.getAttribute('data-painel') || '/dashboard'
        if (d.charAt(0) !== '/' || d.charAt(1) === '/') d = '/dashboard'
        // Aba nova: leva junto quem abriu, senão o relatório fica orfao numa aba
        if (window.opener && !window.opener.closed) {
          try { window.opener.location.href = d; window.close(); return } catch (e) {}
        }
        window.location.href = d
      })
      if (!voltar) return
      voltar.addEventListener('click', function () {
        var destino = voltar.getAttribute('data-destino') || '/dashboard'
        if (destino.charAt(0) !== '/' || destino.charAt(1) === '/') destino = '/dashboard'
        var ref = document.referrer || ''
        var daCasa = ref.indexOf(location.origin + '/') === 0
        var deOutroRelatorio = daCasa && ref.indexOf(location.origin + '/api/') === 0
        // 1. Veio de outro relatório nesta aba (P&L -> detalhe): volta a ele
        if (deOutroRelatorio && window.history.length > 1) { window.history.back(); return }
        // 2. Aba aberta pela tela: fechar devolve a tela como estava — também
        //    depois de ir ao detalhe e voltar, quando o histórico tem 2 páginas
        var dono = null
        try { dono = window.opener && !window.opener.closed ? window.opener : null } catch (e) {}
        if (dono) {
          window.close()
          // Navegador recusou fechar (app instalado): vai para a tela de origem
          setTimeout(function () { window.location.href = destino }, 250)
          return
        }
        // 3. Aberto nesta mesma aba a partir de uma tela nossa: volta a ela
        if (daCasa && window.history.length > 1) { window.history.back(); return }
        // 4. Sem caminho de volta (link salvo, aba sem dono): a tela de origem
        window.location.href = destino
      })
    })()
  </script>`
  return { css, html }
}
