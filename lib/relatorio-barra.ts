// lib/relatorio-barra.ts — barra fixa dos relatórios impressos: Voltar + Imprimir.
//
// Todo relatório em HTML (P&L, balanço, fornecedores, detalhe de conta,
// fatura) usa a mesma barra, para o comportamento ser um só:
//   Voltar   → veio de uma página nossa na mesma aba: volta pelo histórico;
//              abriu em aba nova (window.open do painel/portal): fecha a aba;
//              se o navegador não deixar fechar, vai para a tela de origem.
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
        if (ref.indexOf(location.origin) === 0 && window.history.length > 1) { window.history.back(); return }
        // Aba aberta pelo painel ou pelo portal: fechar é o "voltar"
        window.close()
        // Navegador recusou fechar (aba não aberta por script): vai para a origem
        setTimeout(function () { window.location.href = destino }, 200)
      })
    })()
  </script>`
  return { css, html }
}
