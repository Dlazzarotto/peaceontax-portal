// Autenticação/autorização das rotas de API (Fase 1+)
// - getAuth(): quem está logado e se é da equipe (role 'firm' no metadata)
// - canAccessClient(): staff acessa qualquer cliente; cliente só o próprio
// - serviceDb(): client com service role (aceita os dois nomes de variável)

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export interface AuthContext {
  userId: string;
  isStaff: boolean;
}

export async function getAuth(): Promise<AuthContext | null> {
  const cookieStore = cookies();
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  );
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  return {
    userId: user.id,
    isStaff: user.user_metadata?.role === "firm",
  };
}

export function serviceDb() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error("Service role key não configurada");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key);
}

export async function canAccessClient(
  auth: AuthContext,
  clientId: string
): Promise<boolean> {
  if (auth.isStaff) return true;
  const { data } = await serviceDb()
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("user_id", auth.userId)
    .maybeSingle();
  return !!data;
}
