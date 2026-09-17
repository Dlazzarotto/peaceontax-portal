import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { papelDoLogin } from '@/lib/papeis'

const URL  = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export async function supabaseServer() {
  const store = await cookies()
  return createServerClient(URL, ANON, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (pairs) => {
        try { pairs.forEach(({ name, value, options }) => store.set(name, value, options)) }
        catch {}
      },
    },
  })
}

export async function getUser() {
  const sb = await supabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  return user
}

/** Firma x cliente. A regra mora em lib/papeis.ts — nao repita aqui. */
export function getRole(user: any): 'firm' | 'client' {
  return papelDoLogin(user)
}
