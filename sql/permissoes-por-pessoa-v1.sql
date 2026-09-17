-- sql/permissoes-por-pessoa-v1.sql
-- Autorizacoes por pessoa, em cima do nivel (owner/manager/junior).
--
-- POR QUE
-- O nivel e um degrau inteiro: para autorizar uma assistente a RECEBER no
-- balcao era preciso promove-la a gerente, e gerente traz junto cancelar,
-- apagar e estornar. Agora o socio autoriza a chave exata e retira quando
-- quiser, sem mexer no nivel.
--
-- FORMATO: a tabela e APPEND-ONLY. Cada clique grava uma linha nova; o
-- estado atual e a ultima linha de cada (user_id, chave), pela view
-- staff_grants_atual. Estado e historico nunca podem discordar porque sao
-- a mesma coisa -- principio 2 da especificacao ("nada se apaga sem rastro").
--
-- Idempotente: pode rodar de novo sem estragar nada.

create table if not exists public.staff_grants (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  chave         text not null,
  concedido     boolean not null,
  concedido_por uuid not null,              -- quem autorizou (sempre um socio)
  motivo        text not null,              -- obrigatorio: acao sensivel pede motivo
  conflito      text,                       -- separacao de funcoes quebrada, se houve
  created_at    timestamptz not null default now()
);

-- A chave tem de existir em lib/permissoes.ts. A lista vive nos dois lados:
-- o banco recusa lixo, o codigo recusa antes de chegar aqui.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'staff_grants_chave_ck'
  ) then
    alter table public.staff_grants add constraint staff_grants_chave_ck
      check (chave in (
        'criar','receber','duplicar','editar','estornar',
        'cancelar','apagar','darDesconto','verRelatorios','verTotais'
      ));
  end if;
end $$;

-- Motivo em branco nao e motivo
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'staff_grants_motivo_ck'
  ) then
    alter table public.staff_grants add constraint staff_grants_motivo_ck
      check (length(btrim(motivo)) >= 3);
  end if;
end $$;

-- A leitura do estado atual passa por aqui a cada verificacao de permissao
create index if not exists staff_grants_atual_idx
  on public.staff_grants (user_id, chave, created_at desc);

-- Estado atual: a ultima decisao de cada chave, por pessoa
create or replace view public.staff_grants_atual as
  select distinct on (user_id, chave)
    user_id, chave, concedido, concedido_por, motivo, conflito, created_at
  from public.staff_grants
  order by user_id, chave, created_at desc;

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  t integer; c integer; i integer; v integer;
begin
  select count(*) into t from information_schema.tables
   where table_schema = 'public' and table_name = 'staff_grants';
  select count(*) into c from pg_constraint
   where conname in ('staff_grants_chave_ck', 'staff_grants_motivo_ck');
  select count(*) into i from pg_indexes
   where schemaname = 'public' and indexname = 'staff_grants_atual_idx';
  select count(*) into v from information_schema.views
   where table_schema = 'public' and table_name = 'staff_grants_atual';
  raise notice 'tabela staff_grants: %', t;
  raise notice 'restricoes (esperado 2): %', c;
  raise notice 'indice staff_grants_atual_idx: %', i;
  raise notice 'view staff_grants_atual: %', v;
  if t = 0 or c <> 2 or i = 0 or v = 0 then
    raise exception 'Migracao incompleta -- confira os avisos acima';
  end if;
end $$;
