-- ═══════════════════════════════════════════════════════════
-- PeaceOnTax — Clients & Documents Schema
-- Run in: Supabase → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════

-- ─── CLIENTS ─────────────────────────────────────────────
create table if not exists clients (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete set null,
  name          text not null,
  email         text not null,
  phone         text,
  type          text not null default 'individual' check (type in ('individual','business')),
  language      text not null default 'en' check (language in ('en','pt','es','zh')),
  assignee      text,
  stage         text not null default 'Onboarding',
  balance       numeric(10,2) default 0,
  notes         text,
  -- Business specific
  business_name text,
  ein           text,
  business_type text,  -- LLC, S-Corp, C-Corp, Sole Prop, Partnership
  industry      text,
  -- Individual specific
  ssn_last4     text,
  filing_status text,  -- Single, MFJ, MFS, HoH, QW
  -- Address
  address_line1 text,
  address_line2 text,
  city          text,
  state         text default 'MA',
  zip           text,
  -- Metadata
  active        boolean default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─── DOCUMENT FOLDERS (per client per year) ──────────────
-- Folder structure: year > category > subcategory
-- Categories differ for individual vs business

-- ─── DOCUMENTS ───────────────────────────────────────────
create table if not exists documents (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  tax_year      int not null default extract(year from now())::int,
  category      text not null,  -- see categories below
  subcategory   text,
  file_name     text not null,
  storage_path  text not null,
  file_size     bigint,
  file_type     text,
  status        text not null default 'uploaded'
                  check (status in ('uploaded','reviewed','approved','signed','archived')),
  notes         text,
  uploaded_by   text default 'firm',  -- 'firm' or 'client'
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─── INDEXES ─────────────────────────────────────────────
create index if not exists idx_clients_email    on clients(email);
create index if not exists idx_clients_type     on clients(type);
create index if not exists idx_clients_assignee on clients(assignee);
create index if not exists idx_clients_active   on clients(active);
create index if not exists idx_docs_client      on documents(client_id);
create index if not exists idx_docs_year        on documents(tax_year);
create index if not exists idx_docs_category    on documents(category);

-- ─── RLS ──────────────────────────────────────────────────
alter table clients   enable row level security;
alter table documents enable row level security;

-- A EQUIPE TRABALHA PELO SERVIDOR com a service role (passa por cima da RLS).
-- As policies `firm_all_*` liam raw_user_meta_data -- o mesmo campo que o
-- cliente forja -- por subconsulta em auth.users. Alem de forjaveis em tese,
-- davam `permission denied for table users` para quem nao e dono (anon/
-- authenticated nao tem grant em auth.users), entao nem funcionavam. Saem, e
-- a tabela fecha para o navegador. Ver sql/rls-tabelas-expostas-v2.sql.
-- Tambem derruba qualquer resquicio das policies antigas, caso ja aplicadas.
drop policy if exists "firm_all_clients"   on clients;
drop policy if exists "firm_all_documents" on documents;
revoke all on clients, documents from anon, authenticated;

-- Client sees only their own record
drop policy if exists "client_own_record" on clients;
create policy "client_own_record" on clients
  for select using (user_id = auth.uid());

-- Client sees only their documents
drop policy if exists "client_own_documents" on documents;
create policy "client_own_documents" on documents
  for select using (
    client_id in (select id from clients where user_id = auth.uid())
  );

-- ─── STORAGE BUCKET ──────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('client-documents', 'client-documents', false)
on conflict (id) do nothing;

-- Storage policy
drop policy if exists "firm_storage_all" on storage.objects;
create policy "firm_storage_all" on storage.objects
  for all using (
    bucket_id = 'client-documents' and
    (select raw_user_meta_data->>'role' from auth.users where id = auth.uid()) = 'firm'
  );

drop policy if exists "client_storage_own" on storage.objects;
create policy "client_storage_own" on storage.objects
  for select using (
    bucket_id = 'client-documents' and
    (storage.foldername(name))[1] in (
      select id::text from clients where user_id = auth.uid()
    )
  );

select 'Clients & Documents schema created ✓' as status;
