// FASE 1 — Aplicação de templates de pasta
// Usado pelo endpoint /api/fase1/apply-template.
// Chame applyFolderTemplate() no fluxo de criação de cliente
// e também ao "abrir" um novo ano fiscal para um cliente existente.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ClientType = "individual" | "business";

export interface TemplateNode {
  name?: string;
  folder_type?: string;
  children?: TemplateNode[];
  /** Se presente, o nó é replicado por ano fiscal (nome = ano, ex.: "2026") */
  per_year?: { folder_type: string; children?: TemplateNode[] };
}

interface ApplyOptions {
  clientId: string;
  clientType: ClientType;
  /** Anos a criar. Padrão: [ano corrente] */
  years?: number[];
  createdBy?: string;
}

/**
 * Cria a árvore de pastas do template padrão para o cliente.
 * Idempotente: o UNIQUE (client_id, parent_id, name) impede duplicatas —
 * conflitos são ignorados, então é seguro re-executar.
 */
export async function applyFolderTemplate(
  supabase: SupabaseClient,
  opts: ApplyOptions
): Promise<{ created: number }> {
  const years = opts.years?.length ? opts.years : [new Date().getFullYear()];

  const { data: template, error } = await supabase
    .from("folder_templates")
    .select("tree")
    .eq("client_type", opts.clientType)
    .eq("is_default", true)
    .single();

  if (error || !template) {
    throw new Error(`Template padrão não encontrado para ${opts.clientType}`);
  }

  let created = 0;

  async function insertFolder(
    name: string,
    folderType: string,
    parentId: string | null,
    fiscalYear: number | null
  ): Promise<string | null> {
    const { data, error } = await supabase
      .from("client_folders")
      .upsert(
        {
          client_id: opts.clientId,
          parent_id: parentId,
          name,
          folder_type: folderType,
          fiscal_year: fiscalYear,
          is_system: true,
          created_by: opts.createdBy ?? null,
        },
        { onConflict: "client_id,parent_id,name", ignoreDuplicates: false }
      )
      .select("id")
      .single();

    if (error) throw new Error(`Falha ao criar pasta "${name}": ${error.message}`);
    created++;
    return data?.id ?? null;
  }

  async function walk(
    nodes: TemplateNode[],
    parentId: string | null,
    fiscalYear: number | null
  ) {
    for (const node of nodes) {
      if (node.per_year) {
        for (const year of years) {
          const yearId = await insertFolder(
            String(year),
            node.per_year.folder_type,
            parentId,
            year
          );
          if (node.per_year.children) {
            await walk(node.per_year.children, yearId, year);
          }
        }
      } else if (node.name) {
        const id = await insertFolder(
          node.name,
          node.folder_type ?? "custom",
          parentId,
          fiscalYear
        );
        if (node.children) await walk(node.children, id, fiscalYear);
      }
    }
  }

  const tree = template.tree as TemplateNode;
  await walk(tree.children ?? [], null, null);
  return { created };
}

/**
 * Cria as subpastas de uma conta bancária dentro de "Extratos Bancários":
 * [Banco – Conta ****1234] > Janeiro … Dezembro
 */
export async function createBankAccountFolders(
  supabase: SupabaseClient,
  params: {
    clientId: string;
    fiscalYear: number;
    bankStatementsFolderId: string;
    accountLabel: string; // ex.: "Chase – Conta ****1234"
    createdBy?: string;
  }
): Promise<void> {
  const { data: account, error } = await supabase
    .from("client_folders")
    .upsert(
      {
        client_id: params.clientId,
        parent_id: params.bankStatementsFolderId,
        name: params.accountLabel,
        folder_type: "bank_account",
        fiscal_year: params.fiscalYear,
        bank_account_label: params.accountLabel,
        is_system: true,
        created_by: params.createdBy ?? null,
      },
      { onConflict: "client_id,parent_id,name" }
    )
    .select("id")
    .single();

  if (error || !account) throw new Error(error?.message ?? "Falha ao criar conta");

  const MESES = [
    "Janeiro","Fevereiro","Março","Abril","Maio","Junho",
    "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro",
  ];

  const rows = MESES.map((nome, i) => ({
    client_id: params.clientId,
    parent_id: account.id,
    name: nome,
    folder_type: "statement_month",
    fiscal_year: params.fiscalYear,
    bank_account_label: params.accountLabel,
    statement_month: i + 1,
    is_system: true,
    created_by: params.createdBy ?? null,
  }));

  const { error: monthsError } = await supabase
    .from("client_folders")
    .upsert(rows, { onConflict: "client_id,parent_id,name" });

  if (monthsError) throw new Error(monthsError.message);
}
