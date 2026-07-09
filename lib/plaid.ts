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
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error_message || data?.error_code || `Plaid ${res.status}`)
  return data
}
