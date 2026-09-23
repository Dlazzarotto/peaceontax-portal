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

-- ── Conferencia ──────────────────────────────────────────
-- Este bloco foi reescrito DEPOIS de a migracao ja ter sido aplicada. Nada
-- do que ela FAZ mudou -- so a conferencia, que nao mexe em schema.
--
-- Motivo: o SQL Editor do Supabase le uma consulta que atribui a variavel de
-- plpgsql como o `SELECT ... INTO <tabela>` do SQL puro, conclui que a
-- migracao criou tabelas com o nome das variaveis e reescreve o script para
-- ligar RLS nelas -- cortando o bloco no meio. Como este arquivo cria tabela
-- E o guia manda roda-lo, a armadilha ficaria de pe para a proxima pessoa.
-- Subconsulta no lugar de variavel: nao ha atribuicao nenhuma.
do $$
begin
  if (select count(*) from information_schema.tables
       where table_schema = 'public' and table_name = 'staff_grants') = 0
  then
    raise exception 'staff_grants nao existe';
  end if;

  if (select count(*) from pg_constraint
       where conname in ('staff_grants_chave_ck', 'staff_grants_motivo_ck')) <> 2
  then
    raise exception 'faltam restricoes em staff_grants (esperado 2)';
  end if;

  if (select count(*) from pg_indexes
       where schemaname = 'public' and indexname = 'staff_grants_atual_idx') = 0
  then
    raise exception 'falta o indice staff_grants_atual_idx';
  end if;

  if (select count(*) from information_schema.views
       where table_schema = 'public' and table_name = 'staff_grants_atual') = 0
  then
    raise exception 'falta a view staff_grants_atual';
  end if;

  raise notice 'staff_grants: tabela, 2 restricoes, indice e view conferidos';
end $$;
