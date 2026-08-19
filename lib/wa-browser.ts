// lib/wa-browser.ts — cliente do navegador usado pelo Atendimento
// Arquivo próprio para que a tela e o bloco do painel compartilhem
// a MESMA instância (duas instâncias disputam a sessão e o console
// enche de aviso "Multiple GoTrueClient instances").

import { createClient } from '@supabase/supabase-js'

export const waBrowser = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

/** Cabeçalho com o token da sessão. Lança quando não há sessão. */
export async function comToken(extra: Record<string, string> = {}) {
  const { data } = await waBrowser.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Sessão expirada. Entre de novo.')
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra }
}
