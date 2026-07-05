// GET  /api/fase1/folders?clientId=...      → árvore completa do cliente
// POST /api/fase1/folders                   → cria pasta customizada
//   Body: { clientId, parentId|null, name } (ex.: "Annual Report", "Sales Tax")
// AUDITAR: usar o server client autenticado do portal (respeita RLS),
// não o service role, para que cliente só veja as próprias pastas.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function db() {
  // Substituir pelo helper de sessão do portal (ex.: createServerClient de @supabase/ssr)
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function GET(req: NextRequest) {
  const clientId = req.nextUrl.searchParams.get("clientId");
  if (!clientId) return NextResponse.json({ error: "clientId obrigatório" }, { status: 400 });

  const { data, error } = await db()
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
  const { clientId, parentId, name } = await req.json();

  const clean = String(name ?? "").trim();
  if (!clientId || !clean) {
    return NextResponse.json({ error: "clientId e name obrigatórios" }, { status: 400 });
  }
  if (clean.length > 80 || /[\/\\<>:"|?*]/.test(clean)) {
    return NextResponse.json({ error: "Nome de pasta inválido" }, { status: 400 });
  }

  const { data, error } = await db()
    .from("client_folders")
    .insert({
      client_id: clientId,
      parent_id: parentId ?? null,
      name: clean,
      folder_type: "custom",
      is_system: false,
    })
    .select("id")
    .single();

  if (error) {
    const msg = error.code === "23505" ? "Já existe uma pasta com esse nome aqui" : error.message;
    return NextResponse.json({ error: msg }, { status: 409 });
  }
  return NextResponse.json({ ok: true, folderId: data.id });
}
