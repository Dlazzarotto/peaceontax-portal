// Autenticação/autorização das rotas de API (Fase 1+)
// - getAuth(): quem está logado e se é da equipe (lib/papeis.ts decide)
// - canAccessClient(): O FUNIL. ~40 rotas passam por aqui; quem muda a regra
//   de quem vê qual cliente muda AQUI, uma vez.
// - serviceDb(): reexportado de lib/service-db.ts (ver o comentário lá:
//   separá-lo desfez o ciclo api-auth → staff-perms → api-auth)

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { papelDoLogin } from "@/lib/papeis";
import { serviceDb } from "@/lib/service-db";
import { getStaffLevel, concessoesDe } from "@/lib/staff-perms";
import { permissoesDe } from "@/lib/permissoes";
import { idDaFirma } from "@/lib/caixa-firma";

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
    // O papel mora em app_metadata -- user_metadata e gravavel pelo proprio
    // usuario. Ver lib/papeis.ts.
    isStaff: papelDoLogin(user) === 'firm',
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
 * A FIRMA é o caso à parte: o caixa da própria Peace on Tax é uma linha em
 * `clients` (ver lib/caixa-firma.ts) e é SÓ DO SÓCIO. Não basta ser da
 * equipe, e `verEmpresas` não serve: o gerente tem essa autorização por
 * nível e abriria a folha de pagamento e o resultado da firma.
 *
 * O nível só é consultado quando o cliente É empresa: pessoa física, que é o
 * caso comum no balcão, custa uma consulta só.
 */
export async function canAccessClient(
  auth: AuthContext,
  clientId: string
): Promise<boolean> {
  const db = serviceDb();
  const { data } = await db
    .from("clients")
    .select("user_id, type")
    .eq("id", clientId)
    .maybeSingle();
  if (!data) return false;

  // Cliente: só o próprio cadastro, como sempre.
  if (!auth.isStaff) return data.user_id === auth.userId;

  // O caixa da firma. Perguntado pelo id -- e nao por uma coluna no select
  // acima -- porque `is_firm` pode ainda nao ter sido migrada, e uma coluna
  // que falta nao pode derrubar o funil inteiro (ver lib/caixa-firma.ts).
  if (clientId === (await idDaFirma(db))) {
    return (await getStaffLevel(auth.userId)) === "owner";
  }

  if (data.type !== "business") return true;

  const nivel = await getStaffLevel(auth.userId);
  if (nivel === "owner") return true;
  return permissoesDe(nivel, await concessoesDe(auth.userId)).verEmpresas;
}

/** A mensagem de recusa, igual em todas as rotas. */
export const SEM_ACESSO_EMPRESA =
  "Este é um cliente Empresa. Atender empresas exige autorização — fale com o sócio.";

/**
 * Ids de cliente que NAO entram nas listas desta pessoa.
 *
 * canAccessClient responde por UM cliente. As telas que agregam a carteira
 * (central de bookkeeping, alertas do painel) e os seletores de cliente
 * (fatura, contrato) nao perguntam por um cliente: elas listam. Sem este
 * filtro, o assistente restrito a pessoa fisica nao abria a ficha de uma
 * empresa, mas via o NOME dela e quantos lancamentos ela tem no painel -- e
 * o tamanho da carteira de empresas e justamente o que o escopo esconde
 * (mesma correcao ja feita em /api/clients?resumo=1).
 *
 * Sao DUAS regras, e so uma depende do nivel:
 *   . a FIRMA sai da lista para todo mundo, socio inclusive. O caixa dela
 *     tem tela propria (/dashboard/caixa); no seletor de fatura ela seria
 *     um cliente a quem faturar por engano.
 *   . EMPRESA sai para quem nao tem `verEmpresas`.
 *
 * O erro da consulta VIAJA em vez de virar conjunto vazio: conjunto vazio
 * aqui nao esconde nada, e a tela mostraria justamente a carteira de
 * empresas que o escopo existe para esconder. Quem chama devolve o erro.
 */
export async function clientesOcultos(
  auth: AuthContext
): Promise<{ ocultos: Set<string>; erro: string | null }> {
  const ocultos = new Set<string>();
  const db = serviceDb();

  const firma = await idDaFirma(db);
  if (firma) ocultos.add(firma);

  if (!auth.isStaff) return { ocultos, erro: null };
  const nivel = await getStaffLevel(auth.userId);
  if (nivel === "owner") return { ocultos, erro: null };
  const perms = permissoesDe(nivel, await concessoesDe(auth.userId));
  if (perms.verEmpresas) return { ocultos, erro: null };

  const { data, error } = await db
    .from("clients").select("id").eq("type", "business");
  if (error) {
    return { ocultos, erro: `Nao foi possivel conferir o escopo de acesso: ${error.message}` };
  }
  for (const c of data || []) ocultos.add(c.id as string);
  return { ocultos, erro: null };
}
