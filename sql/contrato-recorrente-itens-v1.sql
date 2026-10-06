-- sql/contrato-recorrente-itens-v1.sql
-- O contrato recorrente vira o MOLDE DE UMA FATURA que se repete.
--
-- ANTES: uma descricao e um valor. Nao dava para dizer "Bookkeeping 350 +
-- Payroll 120, menos 50 de desconto, vence 15 dias depois de emitida" --
-- que e exatamente o acordo real com os clientes de carteira.
--
-- O QUE MUDA
--   · recurring_plan_items  -- as linhas do acordo (servico, qtd, preco)
--   · recurring_plans.discount  -- desconto em DOLAR, nunca em porcentagem
--   · recurring_plans.due_days  -- prazo: vence N dias depois de emitida
--
-- DESCONTO EM DOLAR, E ISSO E DECISAO. Este projeto ja pagou caro pelo
-- contrario: a entrada do parcelamento pedia porcentagem, e para uma entrada
-- de $250 em $1.000 era preciso digitar 25 -- digitar 250 era recusado com
-- "a entrada vai de 0% a 90%". Ninguem liga uma coisa a outra. Desconto
-- quebrado e pior ainda ($37 em $470 e 7,87%).
--
-- PRAZO EM DIAS, NAO EM DIA DO MES. "Emite no dia 1 e vence no dia 10"
-- desmonta quando a emissao e no dia 25: o vencimento cairia ANTES da
-- emissao. "Vence em N dias" atravessa a virada do mes sozinho e e como o
-- mundo contabil ja escreve (Net 15, Net 30).
--
-- amount E description PASSAM A SER DERIVADOS da lista de itens -- o
-- servidor recalcula os dois a cada gravacao. Manter um total digitado a
-- parte deixaria o cabecalho discordar das linhas, que e o defeito que a
-- impressao de fatura ja teve aqui.
--
-- Idempotente. Cria tabela: liga a RLS aqui mesmo, nao atribui variavel por
-- consulta e nao define funcao -- as tres coisas que fazem o SQL Editor do
-- Supabase reescrever o arquivo.

-- == 1. As linhas do acordo =================================================
create table if not exists public.recurring_plan_items (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null,                   -- recurring_plans.id
  description text not null,
  quantity    numeric(12,3) not null default 1 check (quantity > 0),
  unit_price  numeric(14,2) not null default 0 check (unit_price >= 0),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

-- Nasce FECHADA para o navegador. No Supabase, tabela criada em `public` ja
-- vem com privilegio para anon e authenticated -- a RLS e o revoke e que
-- seguram. Sem policy, de proposito: quem escreve aqui e o servidor, com a
-- service role key, que passa por cima da RLS.
alter table public.recurring_plan_items enable row level security;
revoke all on public.recurring_plan_items from anon, authenticated;

create index if not exists recurring_plan_items_por_plano
  on public.recurring_plan_items (plan_id, sort_order, created_at);

comment on table public.recurring_plan_items is
  'Linhas do contrato recorrente. O total do contrato (recurring_plans.amount) e a SOMA destas linhas menos o desconto -- derivado, nunca digitado a parte.';

-- == 2. Desconto e prazo no contrato ========================================
alter table public.recurring_plans
  add column if not exists discount numeric(14,2) not null default 0;
alter table public.recurring_plans
  add column if not exists due_days integer not null default 0;

-- Os CHECKs vao a parte: `add column if not exists` nao recria a constraint
-- se a coluna ja existir, e um contrato com desconto negativo seria um
-- acrescimo disfarcado.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'recurring_plans_discount_check'
                    and conrelid = 'public.recurring_plans'::regclass) then
    alter table public.recurring_plans
      add constraint recurring_plans_discount_check check (discount >= 0);
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'recurring_plans_due_days_check'
                    and conrelid = 'public.recurring_plans'::regclass) then
    alter table public.recurring_plans
      add constraint recurring_plans_due_days_check check (due_days >= 0 and due_days <= 365);
  end if;
end $$;

comment on column public.recurring_plans.discount is
  'Desconto em DOLAR (nunca porcentagem). O total cobrado e a soma dos itens menos este valor.';
comment on column public.recurring_plans.due_days is
  'Prazo: a cobranca vence N dias depois de emitida (Net 15, Net 30). 0 = vence no dia da emissao.';

-- == 3. Os contratos que ja existem viram UMA linha =========================
-- Sem isto, todo contrato antigo abriria sem item nenhum e com total zero --
-- o modelo novo apagando o acordo antigo em silencio. Insere so onde ainda
-- nao ha linha, entao rodar de novo nao duplica.
insert into public.recurring_plan_items (plan_id, description, quantity, unit_price, sort_order)
select p.id, coalesce(nullif(btrim(p.description), ''), 'Serviço'), 1, coalesce(p.amount, 0), 0
  from public.recurring_plans p
 where not exists (select 1 from public.recurring_plan_items i where i.plan_id = p.id);

-- == Conferencia ============================================================
do $$
begin
  if to_regclass('public.recurring_plan_items') is null then
    raise exception 'recurring_plan_items nao foi criada';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.recurring_plan_items'::regclass) then
    raise exception 'recurring_plan_items sem RLS -- responderia ao navegador com a anon key';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'recurring_plan_items'
       and grantee in ('anon', 'authenticated'))
  then
    raise exception 'recurring_plan_items ainda tem privilegio para anon/authenticated';
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'recurring_plans'
                    and column_name = 'discount') then
    raise exception 'recurring_plans.discount nao foi criada';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'recurring_plans'
                    and column_name = 'due_days') then
    raise exception 'recurring_plans.due_days nao foi criada';
  end if;

  -- TODO contrato tem pelo menos uma linha. Um sem linha teria total zero na
  -- proxima gravacao -- o acordo antigo apagado sem ninguem ver.
  if exists (select 1 from public.recurring_plans p
              where not exists (select 1 from public.recurring_plan_items i where i.plan_id = p.id)) then
    raise exception 'ha contrato sem nenhuma linha -- a copia dos antigos nao pegou todos';
  end if;

  -- Os CHECKs testados DE VERDADE, numa tabela TEMPORARIA com o predicado
  -- real. Ler o texto do check nao prova nada, e inserir na tabela de
  -- verdade ja derrubou uma migracao aqui (colunas not-null que a
  -- conferencia nao conhecia).
  execute format(
    'create temp table _conferir_desconto (discount numeric(14,2), constraint c %s)',
    (select pg_get_constraintdef(oid) from pg_constraint
      where conname = 'recurring_plans_discount_check'
        and conrelid = 'public.recurring_plans'::regclass));
  insert into _conferir_desconto (discount) values (0), (50.25);
  begin
    insert into _conferir_desconto (discount) values (-1);
    raise exception 'o CHECK do desconto aceitou valor negativo -- acrescimo disfarcado de desconto';
  exception when check_violation then
    null;  -- esperado
  end;
  drop table _conferir_desconto;

  raise notice 'contrato recorrente: itens, desconto, prazo, RLS, revoke, copia dos antigos e CHECK conferidos';
end $$;

select
  (select count(*) from public.recurring_plans)      as contratos,
  (select count(*) from public.recurring_plan_items) as linhas;
