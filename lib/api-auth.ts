// Autenticação/autorização das rotas de API (Fase 1+)
// - getAuth(): quem está logado e se é da equipe (lib/papeis.ts decide)
// - canAccessClient(): O FUNIL. ~40 rotas passam por aqui; quem muda a regra
//   de quem vê qual cliente muda AQUI, uma vez.
// - serviceDb(): reexportado de lib/service-db.ts (ver o comentário lá:
//   separá-lo desfez o ciclo api-auth → staff-perms → api-auth)

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { ehDaFirma } from "@/lib/papeis";
import { serviceDb } from "@/lib/service-db";
import { getStaffLevel, concessoesDe } from "@/lib/staff-perms";
import { permissoesDe } from "@/lib/permissoes";

export { serviceDb };

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
    isStaff: ehDaFirma(user.user_metadata?.role),
  };
}

/**
 * Quem pode abrir a ficha, os documentos e o bookkeeping deste cliente.
 *
 * ~40 rotas chamam esta função. Ela era `if (auth.isStaff) return true` —
 * toda a equipe via os quase mil cadastros. O sócio decidiu que quem atende
 * o balcão fica em PESSOA FÍSICA: Empresa é a carteira do ano todo
 * (bookkeeping, payroll, EIN) e exige a autorização `verEmpresas`.
 *
 * O tipo do cliente vira, assim, uma fronteira de acesso — por isso trocá-lo
 * na ficha pede senha e motivo e sai na trilha como `type_changed`.
 *
 * O nível só é consultado quando o cliente É empresa: pessoa física, que é o
 * caso comum no balcão, custa uma consulta só.
 */
export async function canAccessClient(
  auth: AuthContext,
  clientId: string
): Promise<boolean> {
  const { data } = await serviceDb()
    .from("clients")
    .select("user_id, type")
    .eq("id", clientId)
    .maybeSingle();
  if (!data) return false;

  // Cliente: só o próprio cadastro, como sempre.
  if (!auth.isStaff) return data.user_id === auth.userId;

  if (data.type !== "business") return true;

  const nivel = await getStaffLevel(auth.userId);
  if (nivel === "owner") return true;
  return permissoesDe(nivel, await concessoesDe(auth.userId)).verEmpresas;
}

/** A mensagem de recusa, igual em todas as rotas. */
export const SEM_ACESSO_EMPRESA =
  "Este é um cliente Empresa. Atender empresas exige autorização — fale com o sócio.";
