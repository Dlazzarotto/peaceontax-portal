import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

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

export function getRole(user: any): 'firm' | 'client' {
  return user?.user_metadata?.role === 'firm' ? 'firm' : 'client'
}
