// lib/relatorio-barra.ts — barra fixa dos relatórios impressos: Voltar + Imprimir.
//
// Todo relatório em HTML (P&L, balanço, fornecedores, detalhe de conta,
// fatura) usa a mesma barra, para o comportamento ser um só:
//   Voltar   → veio de uma página nossa na mesma aba: volta pelo histórico;
//              abriu em aba nova (window.open do painel/portal): fecha a aba;
//              se o navegador não deixar fechar, vai para a tela de origem.
//   Imprimir → window.print(); a barra some na impressão.
//
// SEGURANÇA: nada do que vem de fora entra dentro do <script>. O destino vai
// num atributo `data-destino` escapado, e o script é fixo — assim um parâmetro
// da URL com "</script>" não consegue fechar o bloco e injetar código. Um valor
// interpolado dentro de script por JSON.stringify NÃO é seguro: o JSON não
// escapa "</script>", e o parser de HTML fecha o bloco antes do JavaScript ler.

/** Escapa texto para dentro de HTML (inclusive atributo com aspas duplas). */
export function escaparHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function barraDoRelatorio(opts: {
  /** caminho interno para onde ir quando não dá para voltar nem fechar (ex.: /dashboard/bookkeeping) */
  voltarPara: string
  rotuloVoltar?: string
  rotuloImprimir?: string
}): { css: string; html: string } {
  // Só caminho interno: nunca uma URL de outro site nem javascript:
  const destino = /^\/[^/\\]/.test(opts.voltarPara) ? opts.voltarPara : '/dashboard'

  const css = `
  .barra-relatorio { position:fixed; top:14px; right:14px; display:flex; gap:8px; z-index:10; }
  .barra-relatorio button { border:none; font-family:inherit; font-size:15px; font-weight:700; padding:13px 20px; border-radius:8px; cursor:pointer; min-height:48px; }
  .barra-relatorio .voltar { background:#fff; color:#2D3278; border:1.5px solid #2D3278; }
  .barra-relatorio .imprimir { background:#2D3278; color:#fff; }
  @media print { .barra-relatorio { display:none !important; } }`

  const html = `
  <div class="barra-relatorio">
    <button type="button" class="voltar" data-destino="${escaparHtml(destino)}">← ${escaparHtml(opts.rotuloVoltar || 'Voltar')}</button>
    <button type="button" class="imprimir">🖨️ ${escaparHtml(opts.rotuloImprimir || 'Print / Save PDF')}</button>
  </div>
  <script>
    (function () {
      var barra = document.querySelector('.barra-relatorio')
      if (!barra) return
      var voltar = barra.querySelector('.voltar')
      var imprimir = barra.querySelector('.imprimir')
      if (imprimir) imprimir.addEventListener('click', function () { window.print() })
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
