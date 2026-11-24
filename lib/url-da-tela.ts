// lib/url-da-tela.ts — a aba e o período em que a tela está, guardados na URL.
//
// A aba Relatórios do livro (components/BookkeepingTab.tsx), a aba da ficha do
// cliente e o quadro de relatórios do Financeiro eram só estado do React. O
// relatório abre em aba nova e, quando o Voltar não consegue fechá-la (app
// instalado no celular, link salvo), ele navega para uma tela — que abria na
// aba INICIAL: "o voltar vai para o menu principal". Com a aba na URL, a tela
// lê onde estava e reabre ali (lib/relatorio-barra.ts monta esse endereço).
//
// Sem `useSearchParams` (pediria Suspense na página inteira, o mesmo motivo do
// Financeiro) e sem `router.replace` (navegação do Next: rola a tela e refaz a
// árvore). Só troca o endereço, devolvendo ao histórico o estado que o
// roteador do Next guarda nele — passar `null` ali quebraria o voltar do
// próprio Next.

/** O endereço com os parâmetros trocados; `null`/vazio tira o parâmetro. Puro. */
export function comParametros(caminho: string, valores: Record<string, string | null | undefined>): string {
  const i = caminho.indexOf('#')
  const semHash = i >= 0 ? caminho.slice(0, i) : caminho
  const hash = i >= 0 ? caminho.slice(i) : ''
  const j = semHash.indexOf('?')
  const base = j >= 0 ? semHash.slice(0, j) : semHash
  const q = new URLSearchParams(j >= 0 ? semHash.slice(j + 1) : '')
  for (const [k, v] of Object.entries(valores)) {
    if (v === null || v === undefined || v === '') q.delete(k)
    else q.set(k, v)
  }
  const s = q.toString()
  return `${base}${s ? `?${s}` : ''}${hash}`
}

/** Um parâmetro da URL atual, ou null (fora do navegador, ou sem ele). */
export function lerDaUrl(nome: string): string | null {
  try { return new URLSearchParams(window.location.search).get(nome) } catch { return null }
}

/** Grava parâmetros na URL atual sem navegar. Falhar aqui não pode derrubar a tela. */
export function gravarNaUrl(valores: Record<string, string | null | undefined>): void {
  try {
    const atual = window.location.pathname + window.location.search + window.location.hash
    const novo = comParametros(atual, valores)
    if (novo !== atual) window.history.replaceState(window.history.state, '', novo)
  } catch { /* sem histórico gravável: a tela segue, só não lembra a aba */ }
}
