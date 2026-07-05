// POST /api/fase1/classify (multipart: file, clientId)
// Staff: qualquer cliente; cliente logado: só os próprios uploads. Não grava nada.

import { NextRequest, NextResponse } from "next/server";
import { getAuth, canAccessClient, serviceDb } from "@/lib/api-auth";
import { classifyDocument, suggestFolder } from "@/lib/classify-document";

export const runtime = "nodejs";
export const maxDuration = 60;

const ACCEPTED = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 20 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuth();
    if (!auth) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

    const form = await req.formData();
    const file = form.get("file") as File | null;
    const clientId = form.get("clientId") as string | null;

    if (!file || !clientId) {
      return NextResponse.json({ error: "file e clientId obrigatórios" }, { status: 400 });
    }
    if (!(await canAccessClient(auth, clientId))) {
      return NextResponse.json({ error: "Sem acesso a este cliente" }, { status: 403 });
    }
    if (!ACCEPTED.includes(file.type)) {
      return NextResponse.json({ error: "Formato não suportado. Envie PDF, JPG, PNG ou WebP." }, { status: 415 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "Arquivo acima de 20 MB." }, { status: 413 });
    }

    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const result = await classifyDocument({ base64, mimeType: file.type, fileName: file.name });

    const { data: folders } = await serviceDb()
      .from("client_folders")
      .select("id,folder_type,fiscal_year,bank_account_label,statement_month")
      .eq("client_id", clientId);

    const suggestedFolderId = suggestFolder(result, folders ?? []);

    return NextResponse.json({
      classification: result,
      suggestedFolderId,
      needsReview: result.confidence < 0.95 || !suggestedFolderId,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
