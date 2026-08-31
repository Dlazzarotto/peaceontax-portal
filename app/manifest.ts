// app/manifest.ts — identidade quando o cliente salva o portal na tela inicial
//
// No celular, "Adicionar à tela de início" passa a criar um ícone com a logo
// da Peace on Tax, nome próprio e abertura em tela cheia (sem barra do
// navegador) — fica com cara de aplicativo, não de atalho de site.

import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Peace on Tax — Portal do Cliente',
    short_name: 'Peace on Tax',
    description: 'Documentos, relatórios contábeis e pagamentos da Peace on Tax Corp.',
    start_url: '/portal',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#2D3278',
    orientation: 'portrait',
    lang: 'pt-BR',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
