// lib/relatorio-barra.ts — barra fixa dos relatórios impressos: Voltar + Imprimir.
//
// Todo relatório em HTML (P&L, balanço, fornecedores, detalhe de conta,
// fatura) usa a mesma barra, para o comportamento ser um só:
//   Voltar   → veio de uma página nossa na mesma aba: volta pelo histórico;
//              abriu em aba nova (window.open do painel/portal): fecha a aba;
//              se o navegador não deixar fechar, vai para a tela de origem.
//   Imprimir → window.print(); a barra some na impressão.

export function barraDoRelatorio(opts: {
  /** para onde ir quando não dá para voltar nem fechar (ex.: /dashboard/bookkeeping) */
  voltarPara: string
  rotuloVoltar?: string
  rotuloImprimir?: string
}): { css: string; html: string } {
  const css = `
  .barra-relatorio { position:fixed; top:14px; right:14px; display:flex; gap:8px; z-index:10; }
  .barra-relatorio button { border:none; font-family:inherit; font-size:15px; font-weight:700; padding:13px 20px; border-radius:8px; cursor:pointer; min-height:48px; }
  .barra-relatorio .voltar { background:#fff; color:#2D3278; border:1.5px solid #2D3278; }
  .barra-relatorio .imprimir { background:#2D3278; color:#fff; }
  @media print { .barra-relatorio { display:none !important; } }`

  const html = `
  <div class="barra-relatorio">
    <button type="button" class="voltar" onclick="voltarDoRelatorio()">← ${opts.rotuloVoltar || 'Voltar'}</button>
    <button type="button" class="imprimir" onclick="window.print()">🖨️ ${opts.rotuloImprimir || 'Print / Save PDF'}</button>
  </div>
  <script>
    function voltarDoRelatorio() {
      var destino = ${JSON.stringify(opts.voltarPara)};
      var ref = document.referrer || '';
      var mesmoSite = ref.indexOf(location.host) !== -1;
      if (mesmoSite && window.history.length > 1) { window.history.back(); return; }
      // Aba aberta pelo painel ou pelo portal: fechar é o "voltar"
      window.close();
      // Navegador recusou fechar (aba não aberta por script): vai para a origem
      setTimeout(function () { window.location.href = destino; }, 200);
    }
  </script>`
  return { css, html }
}
