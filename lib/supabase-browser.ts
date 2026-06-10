import { createBrowserClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'

const URL  = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Safe to use in Client Components
export const supabaseBrowser = () => createBrowserClient(URL, ANON)

// Admin client - server API routes only
export const supabaseAdmin = () => createClient(
  URL,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)
