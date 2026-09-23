// POST /api/fase1/apply-template — SOMENTE EQUIPE
// Body: { clientId, clientType: "individual"|"business", years?: number[] }

import { NextRequest, NextResponse } from "next/server";
import { getAuth, canAccessClient, serviceDb } from "@/lib/api-auth";
import { applyFolderTemplate } from "@/lib/folder-templates";

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuth();
    if (!auth?.isStaff) {
      return NextResponse.json({ error: "Acesso restrito à equipe" }, { status: 403 });
    }

    const { clientId, clientType, years } = await req.json();
    if (!clientId || !["individual", "business"].includes(clientType)) {
      return NextResponse.json({ error: "clientId e clientType obrigatórios" }, { status: 400 });
    // Escopo por TIPO: o assistente fica em pessoa fisica. canAccessClient
    // e o funil das outras ~40 rotas -- esta ficou de fora quando o escopo
    // foi criado, e sem ele bastava passar o id de uma empresa.
    if (!(await canAccessClient(auth, clientId)))
      return NextResponse.json({ error: "Sem acesso a este cliente" }, { status: 403 });
    }

    const result = await applyFolderTemplate(serviceDb(), { clientId, clientType, years });
    return NextResponse.json({ ok: true, foldersCreated: result.created });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
