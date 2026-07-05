"use client";
// FASE 1 — Árvore de pastas do cliente
// Acessibilidade: texto ≥18px, alvos de toque ≥48px, alto contraste
// navy #2D3278 / laranja #F47B20, navegação por teclado (setas + Enter).

import { useMemo, useState } from "react";

export interface FolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  folder_type: string;
  fiscal_year: number | null;
  is_system: boolean;
}

interface Props {
  folders: FolderRow[];
  selectedId?: string | null;
  onSelect: (folder: FolderRow) => void;
  onCreateSubfolder?: (parent: FolderRow) => void; // abre modal do portal
}

interface Node extends FolderRow { children: Node[] }

function buildTree(rows: FolderRow[]): Node[] {
  const map = new Map<string, Node>();
  rows.forEach(r => map.set(r.id, { ...r, children: [] }));
  const roots: Node[] = [];
  map.forEach(n => {
    if (n.parent_id && map.has(n.parent_id)) map.get(n.parent_id)!.children.push(n);
    else roots.push(n);
  });
  return roots;
}

const ICON: Record<string, string> = {
  personal_docs: "🪪", taxes: "🧾", tax_year: "📅", income_proof: "💵",
  expense_proof: "🧾", company_docs: "🏢", year: "📅", bank_statements: "🏦",
  bank_account: "💳", statement_month: "📄", pl_reports: "📊",
  tax_business: "🧾", custom: "📁",
};

export default function FolderTree({ folders, selectedId, onSelect, onCreateSubfolder }: Props) {
  const tree = useMemo(() => buildTree(folders), [folders]);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setOpen(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  function Row({ node, depth }: { node: Node; depth: number }) {
    const hasChildren = node.children.length > 0;
    const isOpen = open.has(node.id);
    const isSelected = selectedId === node.id;

    return (
      <li role="treeitem" aria-expanded={hasChildren ? isOpen : undefined} aria-selected={isSelected}>
        <div
          className={`flex items-center gap-2 rounded-lg cursor-pointer select-none
            min-h-[48px] px-3 text-[18px] leading-snug
            focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#F47B20]
            ${isSelected ? "bg-[#2D3278] text-white font-semibold" : "text-[#1a1d4d] hover:bg-[#2D3278]/10"}`}
          style={{ paddingLeft: `${12 + depth * 24}px` }}
          tabIndex={0}
          onClick={() => { onSelect(node); if (hasChildren) toggle(node.id); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(node); }
            if (e.key === "ArrowRight" && hasChildren && !isOpen) toggle(node.id);
            if (e.key === "ArrowLeft" && isOpen) toggle(node.id);
          }}
        >
          {hasChildren && (
            <span aria-hidden className="w-5 text-[16px]">{isOpen ? "▾" : "▸"}</span>
          )}
          <span aria-hidden>{ICON[node.folder_type] ?? "📁"}</span>
          <span className="flex-1 truncate">{node.name}</span>

          {onCreateSubfolder && (
            <button
              aria-label={`Criar subpasta em ${node.name}`}
              title="Nova subpasta"
              className={`min-w-[48px] min-h-[44px] rounded-md text-[20px] font-bold
                ${isSelected ? "text-[#F47B20] bg-white/10" : "text-[#F47B20] hover:bg-[#F47B20]/15"}`}
              onClick={(e) => { e.stopPropagation(); onCreateSubfolder(node); }}
            >
              +
            </button>
          )}
        </div>

        {hasChildren && isOpen && (
          <ul role="group">
            {node.children.map(c => <Row key={c.id} node={c} depth={depth + 1} />)}
          </ul>
        )}
      </li>
    );
  }

  if (!folders.length) {
    return (
      <p className="text-[18px] text-[#1a1d4d] p-4">
        Nenhuma pasta ainda. Aplique o template padrão para criar a estrutura.
      </p>
    );
  }

  return (
    <ul role="tree" aria-label="Pastas do cliente" className="space-y-1">
      {tree.map(n => <Row key={n.id} node={n} depth={0} />)}
    </ul>
  );
}
