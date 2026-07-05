-- ============================================================
-- MÓDULO AGENDAMENTO — Peace on Tax OS
-- Tipos de reunião, disponibilidade da equipe, agendamentos, bloqueios.
-- Todos os horários em timestamptz (UTC); exibição convertida no front.
-- ============================================================

create table if not exists meeting_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,                          -- ex.: 'Consulta Inicial', 'Revisão de Imposto'
  description text,
  duration_min int not null default 30 check (duration_min between 10 and 240),
  mode text not null default 'video' check (mode in ('video','phone','in_person')),
  buffer_min int not null default 10,          -- respiro entre reuniões
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists staff_availability (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null,                      -- AUDITAR: FK para usuário staff do portal
  weekday int not null check (weekday between 0 and 6),   -- 0=domingo
  start_time time not null,                    -- na timezone abaixo
  end_time time not null,
  timezone text not null default 'America/New_York',
  check (end_time > start_time)
);

create index if not exists staff_availability_idx on staff_availability (staff_id, weekday);

create table if not exists staff_time_blocks (   -- férias, almoço, compromissos
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  check (ends_at > starts_at)
);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid,                              -- null = prospect (ainda não é cliente)
  guest_name text not null,
  guest_email text not null,
  guest_phone text,
  meeting_type_id uuid not null references meeting_types(id),
  staff_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  guest_timezone text not null default 'America/New_York',
  status text not null default 'booked' check (status in ('booked','cancelled','completed','no_show')),
  notes text,                                  -- motivo informado pelo cliente
  booked_via text not null default 'portal' check (booked_via in ('portal','staff','ai')),  -- 'ai' = Fase 3
  cancel_token uuid not null default gen_random_uuid(),  -- link de cancelamento sem login
  created_at timestamptz not null default now()
);

create index if not exists bookings_staff_time_idx on bookings (staff_id, starts_at) where status = 'booked';
create index if not exists bookings_client_idx on bookings (client_id);

-- Impede duplo agendamento no banco (última linha de defesa, além da checagem na API)
create extension if not exists btree_gist;
alter table bookings add constraint bookings_no_overlap
  exclude using gist (
    staff_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status = 'booked');

-- ---------- RLS ----------
alter table meeting_types enable row level security;
alter table staff_availability enable row level security;
alter table staff_time_blocks enable row level security;
alter table bookings enable row level security;

-- AUDITAR: mesmos pressupostos da Fase 1 — profiles(user_id, role) e client_users.
create policy "public_read_meeting_types" on meeting_types
  for select using (active = true);

create policy "staff_manage_meeting_types" on meeting_types
  for all using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.role in ('owner','admin')));

create policy "staff_own_availability" on staff_availability
  for all using (
    staff_id = auth.uid()
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.role in ('owner','admin'))
  );

create policy "staff_own_blocks" on staff_time_blocks
  for all using (
    staff_id = auth.uid()
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.role in ('owner','admin'))
  );

create policy "staff_all_bookings" on bookings
  for all using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.role in ('owner','admin','staff')));

create policy "client_own_bookings" on bookings
  for select using (exists (
    select 1 from client_users cu where cu.client_id = bookings.client_id and cu.user_id = auth.uid()
  ));

-- ---------- Seed inicial ----------
insert into meeting_types (name, description, duration_min, mode) values
  ('Consulta Inicial',      'Primeira conversa para novos clientes',           30, 'video'),
  ('Revisão de Imposto',    'Revisão da declaração com o contador',            45, 'video'),
  ('Reunião de Bookkeeping','Fechamento mensal e dúvidas contábeis',           30, 'video'),
  ('Atendimento Presencial','No escritório: 75 Pleasant St Suite 119, Malden', 45, 'in_person')
on conflict do nothing;

-- ROLLBACK:
-- drop table if exists bookings; drop table if exists staff_time_blocks;
-- drop table if exists staff_availability; drop table if exists meeting_types;
