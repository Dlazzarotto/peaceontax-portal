/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },

  // O painel e as telas de trabalho mostram número que muda o tempo todo.
  // Por padrão o Next guarda a página já renderizada por 30s e a reaproveita
  // quando se volta a ela pelo menu — dava a impressão de número travado.
  // Zero: toda visita busca de novo. As páginas estáticas seguem no padrão.
  experimental: { staleTimes: { dynamic: 0 } },
}
module.exports = nextConfig
