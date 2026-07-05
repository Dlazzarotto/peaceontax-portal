// POST /api/fase1/backfill — SOMENTE EQUIPE — rodar UMA vez
// Aplica o template de pastas em todos os clientes ativos que ainda não têm pastas.
// Idempotente: re-executar não duplica nada.
// Uso: logado como equipe no portal, abra o console do navegador (F12) e rode:
//   fetch('/api/fase1/backfill', { method: 'POST' }).then(r => r.json()).then(console.log)

import { NextResponse } from "next/server";
import { getAuth, serviceDb } from "@/lib/api-auth";
import { applyFolderTemplate, type ClientType } from "@/lib/folder-templates";

export const maxDuration = 60;

export async function POST() {
  const auth = await getAuth();
  if (!auth?.isStaff) {
    return NextResponse.json({ error: "Acesso restrito à equipe" }, { status: 403 });
  }

  const db = serviceDb();
  const { data: clients, error } = await db
    .from("clients")
    .select("id, name, type")
    .eq("active", true);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const year = new Date().getFullYear();
  const results: Array<{ client: string; status: string }> = [];

  for (const c of clients ?? []) {
    try {
      const { count } = await db
        .from("client_folders")
        .select("id", { count: "exact", head: true })
        .eq("client_id", c.id);

      if ((count ?? 0) > 0) {
        results.push({ client: c.name, status: "já tinha pastas — pulado" });
        continue;
      }

      // clients.type pode vir como 'business', 'Business', 'empresa' etc.
      const clientType: ClientType =
        (c.type ?? "").toLowerCase().includes("bus") ||
        (c.type ?? "").toLowerCase().includes("emp")
          ? "business"
          : "individual";

      const r = await applyFolderTemplate(db, {
        clientId: c.id,
        clientType,
        years: [year],
        createdBy: auth.userId,
      });
      results.push({ client: c.name, status: `criadas ${r.created} pastas (${clientType})` });
    } catch (e) {
      results.push({ client: c.name, status: `ERRO: ${(e as Error).message}` });
    }
  }

  return NextResponse.json({
    ok: true,
    total: clients?.length ?? 0,
    processados: results,
  });
}
