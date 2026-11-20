// lib/plaid.ts — cliente Plaid via REST (sem SDK)
const ENV = process.env.PLAID_ENV || 'sandbox'
const BASE = ENV === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com'

export async function plaidPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      ...body,
    }),
  })
  // Resposta que não é JSON (página de erro de um intermediário) vira erro
  // com o status, não um "Unexpected token" que não diz nada.
  const data = await res.json().catch(() => null)
  if (!res.ok || !data) {
    const hasId = !!process.env.PLAID_CLIENT_ID
    const secretLen = (process.env.PLAID_SECRET || '').length
    const erro: Error & { codigo?: string | null } = new Error(`${data?.error_message || data?.error_code || `Plaid ${res.status}`} [env=${ENV}, client_id=${hasId ? 'present' : 'MISSING'}, secret_len=${secretLen}]`)
    // O CÓDIGO viaja junto: quem pagina precisa reconhecer o erro de mutação
    // (lib/plaid-paginacao.ts), e a mensagem traz a frase, não o código.
    erro.codigo = data?.error_code || null
    throw erro
  }
  return data
}
