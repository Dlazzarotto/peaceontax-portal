"use client";
// FASE 1 — Upload com classificação por IA
// Fluxo: seleciona arquivo → IA sugere tipo + pasta → usuário CONFIRMA ou ajusta
// → onConfirm() grava (storage + client_documents) usando a rota já existente
// de upload do portal, agora enviando também os metadados.

import { useState } from "react";

interface Classification {
  doc_type: string;
  fiscal_year: number | null;
  statement_month: number | null;
  bank_account_hint: string | null;
  summary: string;
  confidence: number;
  ocr_text: string;
}

interface Props {
  clientId: string;
  folders: Array<{ id: string; name: string }>;
  onConfirm: (payload: {
    file: File;
    folderId: string;
    classification: Classification;
    classifiedBy: "ai" | "manual";
  }) => Promise<void>;
}

const DOC_LABELS: Record<string, string> = {
  tax_return: "Declaração de Imposto", w2: "W-2", "1099": "1099", w9: "W-9",
  w8ben: "W-8BEN", id_document: "Documento de Identidade", proof_address: "Comprovante de Endereço",
  ein_letter: "Carta do EIN", articles: "Articles of Organization",
  operating_agreement: "Operating Agreement", license: "Licença",
  bank_statement: "Extrato Bancário", receipt_income: "Comprovante de Receita",
  receipt_expense: "Comprovante de Despesa", pl_report: "P&L",
  balance_sheet: "Balance Sheet", annual_report: "Annual Report",
  sales_tax: "Sales Tax", other: "Outro",
};

export default function DocumentUpload({ clientId, folders, onConfirm }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "classifying" | "review" | "saving" | "done" | "error">("idle");
  const [result, setResult] = useState<Classification | null>(null);
  const [folderId, setFolderId] = useState<string>("");
  const [wasAdjusted, setWasAdjusted] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  async function handleFile(f: File) {
    setFile(f);
    setStatus("classifying");
    setErrorMsg("");
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("clientId", clientId);
      const res = await fetch("/api/fase1/classify", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Falha na classificação");
      setResult(data.classification);
      setFolderId(data.suggestedFolderId ?? "");
      setWasAdjusted(false);
      setStatus("review");
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStatus("error");
    }
  }

  async function confirm() {
    if (!file || !result || !folderId) return;
    setStatus("saving");
    try {
      await onConfirm({
        file,
        folderId,
        classification: result,
        classifiedBy: wasAdjusted ? "manual" : "ai",
      });
      setStatus("done");
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStatus("error");
    }
  }

  const btn =
    "min-h-[52px] px-6 rounded-xl text-[18px] font-semibold focus-visible:outline " +
    "focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#F47B20]";

  return (
    <div className="space-y-5 text-[18px] text-[#1a1d4d]">
      {(status === "idle" || status === "done" || status === "error") && (
        <label
          className="block border-[3px] border-dashed border-[#2D3278] rounded-2xl p-8 text-center
                     cursor-pointer hover:bg-[#2D3278]/5 min-h-[120px]"
        >
          <span className="block text-[20px] font-semibold text-[#2D3278]">
            📤 Enviar documento
          </span>
          <span className="block mt-1">PDF, JPG ou PNG · até 20 MB</span>
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
        </label>
      )}

      {status === "classifying" && (
        <p role="status" className="font-semibold text-[#2D3278]">
          🔎 Lendo e classificando o documento…
        </p>
      )}

      {status === "review" && result && (
        <div className="border-2 border-[#2D3278] rounded-2xl p-5 space-y-4 bg-white">
          <h3 className="text-[20px] font-bold text-[#2D3278]">Confira antes de salvar</h3>

          <p><strong>Arquivo:</strong> {file?.name}</p>
          <p><strong>Identificado como:</strong> {DOC_LABELS[result.doc_type] ?? result.doc_type}
            {result.fiscal_year ? ` · Ano ${result.fiscal_year}` : ""}
            {result.bank_account_hint ? ` · Conta ****${result.bank_account_hint}` : ""}
          </p>
          <p><strong>Resumo:</strong> {result.summary}</p>
          <p>
            <strong>Confiança da IA:</strong>{" "}
            <span className={result.confidence >= 0.95 ? "text-green-700 font-semibold" : "text-[#F47B20] font-semibold"}>
              {Math.round(result.confidence * 100)}%
              {result.confidence < 0.95 && " — confira com atenção"}
            </span>
          </p>

          <div>
            <label htmlFor="folder-select" className="block font-semibold mb-1">Pasta de destino</label>
            <select
              id="folder-select"
              value={folderId}
              onChange={(e) => { setFolderId(e.target.value); setWasAdjusted(true); }}
              className="w-full min-h-[52px] text-[18px] border-2 border-[#2D3278] rounded-xl px-3 bg-white"
            >
              <option value="">Escolha a pasta…</option>
              {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>

          <div className="flex flex-wrap gap-3">
            <button onClick={confirm} disabled={!folderId}
              className={`${btn} bg-[#2D3278] text-white disabled:opacity-40`}>
              ✓ Confirmar e salvar
            </button>
            <button onClick={() => { setStatus("idle"); setFile(null); }}
              className={`${btn} border-2 border-[#2D3278] text-[#2D3278] bg-white`}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {status === "saving" && <p role="status" className="font-semibold text-[#2D3278]">💾 Salvando…</p>}

      {status === "done" && (
        <p role="status" className="font-semibold text-green-700">✓ Documento salvo na pasta correta.</p>
      )}

      {status === "error" && (
        <p role="alert" className="font-semibold text-red-700">
          Não foi possível concluir: {errorMsg}. Tente novamente.
        </p>
      )}
    </div>
  );
}
