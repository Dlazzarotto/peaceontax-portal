-- ═══════════════════════════════════════════════════════════
-- PeaceOnTax Portal — Database Schema
-- Run this entire file in: Supabase → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════

-- ─── Enable UUID extension ────────────────────────────────
create extension if not exists "pgcrypto";

-- ─── CLIENTS ──────────────────────────────────────────────
create table if not exists clients (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  name        text not null,
  email       text unique not null,
  phone       text,
  type        text not null check (type in ('business', 'individual')),
  language    text not null default 'en' check (language in ('en','pt','es','zh')),
  assignee    text,
  stage       text default 'Onboarding',
  balance     numeric(10,2) default 0,
  ein         text,
  entity_type text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ─── TRANSACTIONS ─────────────────────────────────────────
create table if not exists transactions (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  date         date not null,
  payee        text not null,
  memo         text,
  debit        numeric(12,2),
  deposit      numeric(12,2),
  category     text,
  account_code text,
  source       text not null check (source in ('AI','Rule','Manual')) default 'Manual',
  status       text not null check (status in ('auto','review','posted')) default 'review',
  confidence   int check (confidence between 0 and 100),
  reconciled   boolean not null default false,
  bank_name    text,
  statement_month text,
  statement_year  text,
  raw_payee    text,
  created_at   timestamptz not null default now()
);

-- ─── DOCUMENTS ────────────────────────────────────────────
create table if not exists documents (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  folder_path  text not null,
  file_name    text not null,
  storage_path text not null unique,
  file_size    int,
  status       text not null check (status in ('uploaded','processing','processed','signed','pending_sign')) default 'uploaded',
  signed_at    timestamptz,
  created_at   timestamptz not null default now()
);

-- ─── CLASSIFICATION RULES ─────────────────────────────────
create table if not exists classification_rules (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  active      boolean not null default true,
  priority    int not null default 99,
  match_count int not null default 0,
  conditions  jsonb not null default '[]',
  actions     jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ─── TASKS ────────────────────────────────────────────────
create table if not exists tasks (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid references clients(id) on delete cascade,
  title       text not null,
  due_date    date,
  priority    text check (priority in ('high','medium','low')) default 'medium',
  done        boolean not null default false,
  assignee    text,
  created_at  timestamptz not null default now()
);

-- ─── ROW LEVEL SECURITY ───────────────────────────────────
alter table clients         enable row level security;
alter table transactions    enable row level security;
alter table documents       enable row level security;
alter table classification_rules enable row level security;
alter table tasks           enable row level security;

-- Firm staff can see everything
create policy "firm_full_access_clients" on clients
  for all using (
    (auth.jwt() ->> 'user_metadata')::jsonb ->> 'role' = 'firm'
  );

create policy "firm_full_access_transactions" on transactions
  for all using (
    (auth.jwt() ->> 'user_metadata')::jsonb ->> 'role' = 'firm'
  );

create policy "firm_full_access_documents" on documents
  for all using (
    (auth.jwt() ->> 'user_metadata')::jsonb ->> 'role' = 'firm'
  );

create policy "firm_full_access_rules" on classification_rules
  for all using (
    (auth.jwt() ->> 'user_metadata')::jsonb ->> 'role' = 'firm'
  );

-- Clients can only see their own data
create policy "client_own_transactions" on transactions
  for all using (
    client_id in (
      select id from clients where user_id = auth.uid()
    )
  );

create policy "client_own_documents" on documents
  for all using (
    client_id in (
      select id from clients where user_id = auth.uid()
    )
  );

-- ─── INDEXES for performance ──────────────────────────────
create index if not exists idx_transactions_client   on transactions(client_id);
create index if not exists idx_transactions_date     on transactions(date);
create index if not exists idx_transactions_status   on transactions(status);
create index if not exists idx_documents_client      on documents(client_id);
create index if not exists idx_rules_active_priority on classification_rules(active, priority);

-- ─── SEED: Default classification rules ───────────────────
insert into classification_rules (name, active, priority, conditions, actions) values
  ('ADP Payroll',        true, 1,  '[{"type":"payee_contains","value":"ADP"}]',                   '{"category":"Payroll / Wages","account":"6000","apply_future":true}'),
  ('Eversource Utility', true, 2,  '[{"type":"payee_contains","value":"Eversource"}]',             '{"category":"Utilities","account":"6020","apply_future":true}'),
  ('AWS Cloud',          true, 3,  '[{"type":"payee_contains","value":"Amazon Web Services"}]',    '{"category":"Software & Subscriptions","account":"6030","apply_future":true}'),
  ('IRS Payments',       true, 4,  '[{"type":"payee_contains","value":"IRS"}]',                    '{"category":"Taxes & Licenses","account":"6110","apply_future":true}'),
  ('MA Dept Revenue',    true, 5,  '[{"type":"payee_contains","value":"Mass DOR"}]',               '{"category":"Taxes & Licenses","account":"6110","apply_future":true}'),
  ('Bank Service Fees',  true, 10, '[{"type":"memo_contains","value":"Service Fee"},{"type":"amount_less","value":"100"}]', '{"category":"Bank Charges","account":"6100","apply_future":true}')
on conflict do nothing;

-- Done!
select 'Schema created successfully ✓' as status;
