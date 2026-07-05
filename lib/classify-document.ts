// FASE 1 — Classificação de documento por IA (server-side apenas)
// Requer env: ANTHROPIC_API_KEY (Vercel → Settings → Environment Variables)
// Recebe o arquivo em base64, retorna JSON com tipo, ano, confiança e pasta sugerida.

const MODEL = process.env.CLASSIFIER_MODEL ?? "claude-sonnet-4-6";

export interface ClassificationResult {
  doc_type: string;          // um dos valores do CHECK em client_documents.doc_type
  fiscal_year: number | null;
  bank_account_hint: string | null; // últimos 4 dígitos se for extrato
  statement_month: number | null;   // 1–12 se for extrato
  language: string;                 // pt, en, es, zh, fr...
  summary: string;                  // 1 frase, usada no atendimento IA
  confidence: number;               // 0–1
  ocr_text: string;                 // texto relevante extraído
}

const SYSTEM_PROMPT = `Você classifica documentos de um escritório de contabilidade nos EUA (clientes brasileiros e internacionais).
Responda SOMENTE com JSON válido, sem markdown, no formato:
{"doc_type":"...","fiscal_year":2025|null,"bank_account_hint":"1234"|null,"statement_month":3|null,"language":"pt","summary":"...","confidence":0.97,"ocr_text":"..."}

doc_type deve ser exatamente um destes:
tax_return, w2, 1099, w9, w8ben, id_document, proof_address, ein_letter, articles,
operating_agreement, license, bank_statement, receipt_income, receipt_expense,
pl_report, balance_sheet, annual_report, sales_tax, other

Regras:
- fiscal_year = ano fiscal do documento (ex.: W-2 de 2025 → 2025), null se não identificável.
- bank_account_hint e statement_month: apenas para bank_statement.
- ocr_text: transcreva os campos importantes (nomes, valores, datas, números de formulário). Máx. 2000 caracteres.
- confidence < 0.7 quando houver dúvida real. Nunca invente dados.`;

export async function classifyDocument(params: {
  base64: string;
  mimeType: string; // application/pdf | image/jpeg | image/png | image/webp
  fileName: string;
}): Promise<ClassificationResult> {
  const isPdf = params.mimeType === "application/pdf";

  const contentBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: params.base64 } }
    : { type: "image", source: { type: "base64", media_type: params.mimeType, data: params.base64 } };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          contentBlock,
          { type: "text", text: `Nome do arquivo: ${params.fileName}. Classifique.` },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const text: string = (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n");

  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean) as ClassificationResult;

  // Sanitização defensiva
  parsed.confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  if (parsed.statement_month && (parsed.statement_month < 1 || parsed.statement_month > 12)) {
    parsed.statement_month = null;
  }
  return parsed;
}

/**
 * Sugere a pasta de destino com base na classificação + árvore existente do cliente.
 * Retorna folder_id ou null (vai para revisão manual).
 */
export function suggestFolder(
  result: ClassificationResult,
  folders: Array<{
    id: string; folder_type: string; fiscal_year: number | null;
    bank_account_label: string | null; statement_month: number | null;
  }>
): string | null {
  const year = result.fiscal_year;

  const byType = (t: string) =>
    folders.find(f => f.folder_type === t && (year == null || f.fiscal_year === year || f.fiscal_year == null));

  switch (result.doc_type) {
    case "bank_statement": {
      if (!year) return null;
      const month = folders.find(f =>
        f.folder_type === "statement_month" &&
        f.fiscal_year === year &&
        f.statement_month === result.statement_month &&
        (!result.bank_account_hint || f.bank_account_label?.includes(result.bank_account_hint))
      );
      return month?.id ?? byType("bank_statements")?.id ?? null;
    }
    case "tax_return": case "w2": case "1099":
      return byType("income_proof")?.id ?? byType("tax_year")?.id ?? byType("tax_business")?.id ?? null;
    case "receipt_income":  return byType("income_proof")?.id ?? null;
    case "receipt_expense": return byType("expense_proof")?.id ?? null;
    case "pl_report": case "balance_sheet":
      return byType("pl_reports")?.id ?? null;
    case "id_document": case "proof_address":
      return byType("personal_docs")?.id ?? byType("company_docs")?.id ?? null;
    case "ein_letter": case "articles": case "operating_agreement": case "license": case "w9": case "w8ben":
      return byType("company_docs")?.id ?? byType("personal_docs")?.id ?? null;
    default:
      return null;
  }
}
