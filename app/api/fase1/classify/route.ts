// POST /api/fase1/classify  (multipart/form-data: file, clientId)
// 1. Classifica o documento com IA (tipo, ano, banco/mês, ocr_text)
// 2. Sugere pasta de destino na árvore do cliente
// 3. NÃO grava nada — devolve a sugestão para o componente confirmar.
//    A gravação (storage + client_documents) acontece só após confirmação
//    do usuário no componente DocumentUpload (POST separado do portal).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { classifyDocument, suggestFolder } from "@/lib/classify-document";

export const runtime = "nodejs";
export const maxDuration = 60;

const ACCEPTED = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const clientId = form.get("clientId") as string | null;

    if (!file || !clientId) {
      return NextResponse.json({ error: "file e clientId obrigatórios" }, { status: 400 });
    }
    if (!ACCEPTED.includes(file.type)) {
      return NextResponse.json({ error: "Formato não suportado. Envie PDF, JPG, PNG ou WebP." }, { status: 415 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "Arquivo acima de 20 MB." }, { status: 413 });
    }

    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");

    const result = await classifyDocument({
      base64,
      mimeType: file.type,
      fileName: file.name,
    });

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const { data: folders } = await supabase
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
