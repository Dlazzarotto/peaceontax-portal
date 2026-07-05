// POST /api/fase1/apply-template
// Body: { clientId, clientType: "individual"|"business", years?: number[] }
// Chamar após criar o cliente (e ao abrir novo ano fiscal).
// AUDITAR: troque createClient pelo helper de server client já usado no portal.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { applyFolderTemplate } from "@/lib/folder-templates";

export async function POST(req: NextRequest) {
  try {
    const { clientId, clientType, years } = await req.json();

    if (!clientId || !["individual", "business"].includes(clientType)) {
      return NextResponse.json({ error: "clientId e clientType obrigatórios" }, { status: 400 });
    }

    // Service role: rota deve ser protegida por auth de staff (middleware do portal)
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const result = await applyFolderTemplate(supabase, { clientId, clientType, years });
    return NextResponse.json({ ok: true, foldersCreated: result.created });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
