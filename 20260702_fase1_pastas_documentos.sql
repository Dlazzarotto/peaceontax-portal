-- ============================================================
-- FASE 1 — Estrutura de Pastas e Metadados de Documentos
-- Peace on Tax OS · Migração Supabase
-- ATENÇÃO: rode primeiro em um branch/projeto de teste.
-- Ver AUDITORIA.md antes de aplicar em produção.
-- ============================================================

-- ---------- 1. Templates de pasta (JSONB tree) ----------
create table if not exists folder_templates (
  id uuid primary key default gen_random_uuid(),
  client_type text not null check (client_type in ('individual','business')),
  name text not null,
  tree jsonb not null,          -- árvore de pastas (ver seed abaixo)
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists folder_templates_default_uq
  on folder_templates (client_type) where is_default;

-- ---------- 2. Pastas por cliente ----------
create table if not exists client_folders (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,                    -- AUDITAR: FK para sua tabela de clientes
  parent_id uuid references client_folders(id) on delete cascade,
  name text not null,
  folder_type text not null default 'custom' check (folder_type in (
    'personal_docs','taxes','tax_year','income_proof','expense_proof',
    'company_docs','year','bank_statements','bank_account','statement_month',
    'pl_reports','tax_business','custom'
  )),
  fiscal_year int,                            -- ex.: 2026 (pastas de ano)
  bank_account_label text,                    -- ex.: 'Chase ****1234'
  statement_month int check (statement_month between 1 and 12),
  is_system boolean not null default false,   -- criada por template (não renomear/excluir pelo cliente)
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (client_id, parent_id, name)
);

create index if not exists client_folders_client_idx on client_folders (client_id);
create index if not exists client_folders_parent_idx on client_folders (parent_id);

-- ---------- 3. Documentos com metadados ----------
-- AUDITAR: se já existe tabela 'documents' no portal, NÃO crie esta.
-- Em vez disso, use o bloco ALTER no final (Opção B) para adicionar colunas.
create table if not exists client_documents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  folder_id uuid references client_folders(id) on delete set null,
  storage_path text not null,                 -- caminho no Supabase Storage
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  doc_type text check (doc_type in (
    'tax_return','w2','1099','w9','w8ben','id_document','proof_address',
    'ein_letter','articles','operating_agreement','license','bank_statement',
    'receipt_income','receipt_expense','pl_report','balance_sheet',
    'annual_report','sales_tax','other'
  )),
  fiscal_year int,
  bank_account_label text,
  statement_month int check (statement_month between 1 and 12),
  ocr_text text,                              -- texto extraído (para busca da IA)
  ai_tags jsonb,                              -- tags livres geradas pela IA
  ai_confidence numeric(4,3),                 -- 0.000–1.000
  classified_by text check (classified_by in ('ai','manual','rule')),
  uploaded_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists client_documents_client_idx on client_documents (client_id);
create index if not exists client_documents_folder_idx on client_documents (folder_id);
create index if not exists client_documents_year_idx on client_documents (client_id, fiscal_year);
-- Busca textual para o assistente ("cadê meu W-2 de 2024?")
create index if not exists client_documents_ocr_idx
  on client_documents using gin (to_tsvector('portuguese', coalesce(ocr_text,'')));

-- ---------- 4. RLS ----------
alter table folder_templates enable row level security;
alter table client_folders  enable row level security;
alter table client_documents enable row level security;

-- AUDITAR: as políticas abaixo assumem:
--   profiles(user_id uuid, role text)            role in ('owner','admin','staff','client')
--   client_users(client_id uuid, user_id uuid)   vínculo cliente ↔ usuário do portal
-- Ajuste os nomes para o schema real do peaceontax-portal antes de aplicar.

create policy "staff_all_templates" on folder_templates
  for all using (exists (
    select 1 from profiles p
    where p.user_id = auth.uid() and p.role in ('owner','admin','staff')
  ));

create policy "staff_all_folders" on client_folders
  for all using (exists (
    select 1 from profiles p
    where p.user_id = auth.uid() and p.role in ('owner','admin','staff')
  ));

create policy "client_own_folders" on client_folders
  for select using (exists (
    select 1 from client_users cu
    where cu.client_id = client_folders.client_id and cu.user_id = auth.uid()
  ));

create policy "staff_all_documents" on client_documents
  for all using (exists (
    select 1 from profiles p
    where p.user_id = auth.uid() and p.role in ('owner','admin','staff')
  ));

create policy "client_own_documents_select" on client_documents
  for select using (exists (
    select 1 from client_users cu
    where cu.client_id = client_documents.client_id and cu.user_id = auth.uid()
  ));

create policy "client_own_documents_insert" on client_documents
  for insert with check (exists (
    select 1 from client_users cu
    where cu.client_id = client_documents.client_id and cu.user_id = auth.uid()
  ));

-- ---------- 5. Seed: templates padrão ----------
insert into folder_templates (client_type, name, is_default, tree) values
('individual', 'Padrão Pessoa Física', true, '{
  "children": [
    { "name": "Documentos Pessoais", "folder_type": "personal_docs" },
    { "name": "Impostos", "folder_type": "taxes", "per_year": {
        "folder_type": "tax_year",
        "children": [
          { "name": "Declaração",              "folder_type": "tax_year" },
          { "name": "Comprovantes de Receita", "folder_type": "income_proof" },
          { "name": "Comprovantes de Despesa", "folder_type": "expense_proof" }
        ]
    }}
  ]
}'::jsonb)
on conflict do nothing;

insert into folder_templates (client_type, name, is_default, tree) values
('business', 'Padrão Business', true, '{
  "children": [
    { "name": "Documentos da Empresa", "folder_type": "company_docs" },
    { "per_year": {
        "folder_type": "year",
        "children": [
          { "name": "Extratos Bancários",        "folder_type": "bank_statements" },
          { "name": "P&L e Relatórios Contábeis","folder_type": "pl_reports" },
          { "name": "Impostos",                  "folder_type": "tax_business" }
        ]
    }}
  ]
}'::jsonb)
on conflict do nothing;

-- ============================================================
-- OPÇÃO B — se o portal JÁ tem tabela de documentos:
-- comente a criação de client_documents acima e rode:
-- ============================================================
-- alter table documents add column if not exists folder_id uuid references client_folders(id);
-- alter table documents add column if not exists doc_type text;
-- alter table documents add column if not exists fiscal_year int;
-- alter table documents add column if not exists bank_account_label text;
-- alter table documents add column if not exists statement_month int;
-- alter table documents add column if not exists ocr_text text;
-- alter table documents add column if not exists ai_tags jsonb;
-- alter table documents add column if not exists ai_confidence numeric(4,3);
-- alter table documents add column if not exists classified_by text;

-- ============================================================
-- ROLLBACK (se necessário):
-- drop table if exists client_documents;
-- drop table if exists client_folders;
-- drop table if exists folder_templates;
-- ============================================================
