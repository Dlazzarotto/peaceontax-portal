// GET  /api/fase1/folders?clientId=...  → árvore (staff: qualquer; cliente: só a própria)
// POST /api/fase1/folders               → pasta customizada (mesma regra)

import { NextRequest, NextResponse } from "next/server";
import { getAuth, canAccessClient, serviceDb } from "@/lib/api-auth";

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const clientId = req.nextUrl.searchParams.get("clientId");
  if (!clientId) return NextResponse.json({ error: "clientId obrigatório" }, { status: 400 });
  if (!(await canAccessClient(auth, clientId))) {
    return NextResponse.json({ error: "Sem acesso a este cliente" }, { status: 403 });
  }

  const { data, error } = await serviceDb()
    .from("client_folders")
    .select("id,parent_id,name,folder_type,fiscal_year,bank_account_label,statement_month,is_system")
    .eq("client_id", clientId)
    .order("fiscal_year", { ascending: false })
    .order("statement_month", { ascending: true })
    .order("name", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ folders: data });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const { clientId, parentId, name } = await req.json();
  const clean = String(name ?? "").trim();
  if (!clientId || !clean) {
    return NextResponse.json({ error: "clientId e name obrigatórios" }, { status: 400 });
  }
  if (clean.length > 80 || /[\/\\<>:"|?*]/.test(clean)) {
    return NextResponse.json({ error: "Nome de pasta inválido" }, { status: 400 });
  }
  if (!(await canAccessClient(auth, clientId))) {
    return NextResponse.json({ error: "Sem acesso a este cliente" }, { status: 403 });
  }

  const { data, error } = await serviceDb()
    .from("client_folders")
    .insert({
      client_id: clientId,
      parent_id: parentId ?? null,
      name: clean,
      folder_type: "custom",
      is_system: false,
      created_by: auth.userId,
    })
    .select("id")
    .single();

  if (error) {
    const msg = error.code === "23505" ? "Já existe uma pasta com esse nome aqui" : error.message;
    return NextResponse.json({ error: msg }, { status: 409 });
  }
  return NextResponse.json({ ok: true, folderId: data.id });
}
