-- sql/contrato-recorrente-auditoria-v1.sql
-- TRILHA dos contratos recorrentes (`recurring_plans`).
--
-- POR QUE EXISTE
-- O contrato recorrente diz quanto o cliente paga e quando. Ate agora o
-- PATCH da rota trocava valor, dia e cobranca automatica sem senha, sem
-- motivo e sem deixar rastro -- enquanto editar uma FATURA, que e um
-- documento unico, exige as tres coisas. O principio 2 ("nada se apaga sem
-- rastro") e o 3 ("acao sensivel pede senha e motivo") valem aqui com mais
-- forca, nao com menos: a fatura erra uma vez, o contrato erra todo mes.
--
-- COMO A ROTA USA
-- A trilha e gravada ANTES da alteracao. Se este insert falhar, a rota
-- RECUSA a edicao e diz que esta migracao falta -- mudanca sem rastro e
-- pior que mudanca nao feita. O preco e que uma linha de trilha pode
-- sobrar se o update seguinte falhar; esse lado e o barato.
--
-- Idempotente. Cria tabela: liga a RLS aqui mesmo, nao atribui variavel
-- por consulta e nao define funcao -- as tres coisas que fazem o SQL
-- Editor do Supabase reescrever o arquivo.

create table if not exists public.recurring_plan_audit (
  id             uuid primary key default gen_random_uuid(),
  plan_id        uuid not null,                 -- recurring_plans.id
  client_id      uuid,                          -- de quem e o contrato
  action         text not null
                 check (action in ('edited', 'paused', 'resumed', 'ended')),
  performed_by   uuid,                          -- auth.users.id de quem fez
  staff_level    text,                          -- owner | manager | junior
  reason         text,                          -- o motivo digitado
  previous_state jsonb,                         -- como estava
  new_state      jsonb,                         -- como ficou
  created_at     timestamptz not null default now()
);

-- Nasce FECHADA para o navegador. No Supabase, tabela criada em `public` ja
-- vem com privilegio para anon e authenticated -- a RLS e o revoke e que
-- seguram. Sem policy, de proposito: quem escreve aqui e o servidor, com a
-- service role key, que passa por cima da RLS.
alter table public.recurring_plan_audit enable row level security;
revoke all on public.recurring_plan_audit from anon, authenticated;

create index if not exists recurring_plan_audit_por_plano
  on public.recurring_plan_audit (plan_id, created_at desc);

comment on table public.recurring_plan_audit is
  'Trilha dos contratos recorrentes: quem mudou o que, quando e por que. Gravada ANTES da alteracao -- se falhar, a rota recusa a edicao.';

-- == Conferencia ===========================================================
do $$
begin
  if to_regclass('public.recurring_plan_audit') is null then
    raise exception 'recurring_plan_audit nao foi criada';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.recurring_plan_audit'::regclass) then
    raise exception 'recurring_plan_audit sem RLS -- responderia ao navegador com a anon key';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'recurring_plan_audit'
       and grantee in ('anon', 'authenticated'))
  then
    raise exception 'recurring_plan_audit ainda tem privilegio para anon/authenticated';
  end if;

  if (select count(*) from pg_indexes
       where schemaname = 'public' and indexname = 'recurring_plan_audit_por_plano') <> 1
  then
    raise exception 'falta o indice recurring_plan_audit_por_plano';
  end if;

  -- O CHECK da acao tem de recusar o que a rota nao escreve. Conferido numa
  -- tabela TEMPORARIA com o predicado REAL: ler o texto do check nao prova
  -- nada, e inserir na tabela de verdade ja derrubou uma migracao aqui
  -- (colunas not-null que a conferencia nao conhecia).
  execute format(
    'create temp table _conferir_acao (action text, constraint c %s)',
    (select pg_get_constraintdef(oid) from pg_constraint
      where conname = 'recurring_plan_audit_action_check'
        and conrelid = 'public.recurring_plan_audit'::regclass));

  insert into _conferir_acao (action) values ('edited'), ('paused'), ('resumed'), ('ended');

  begin
    insert into _conferir_acao (action) values ('apagado');
    raise exception 'o CHECK de action aceitou um valor que a rota nunca escreve';
  exception when check_violation then
    null;  -- esperado
  end;

  drop table _conferir_acao;

  raise notice 'recurring_plan_audit: tabela, indice, RLS, revoke e CHECK conferidos';
end $$;

select count(*) as linhas_de_trilha from public.recurring_plan_audit;
