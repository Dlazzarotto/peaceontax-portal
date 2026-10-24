-- COLE ESTE ARQUIVO INTEIRO NO SQL EDITOR DO SUPABASE E APERTE RUN.
--
-- GERADO por scripts/juntar-para-colar.mjs -- nao edite a mao.
-- Junta, NA ORDEM, as migracoes abaixo e anota as 2 no livro
-- (public.schema_migrations) com o MESMO sha256 que scripts/migrar.mjs
-- calcula: depois disso `--pendentes` diz APLICADO e ninguem roda de novo.
--
-- Cada parte e idempotente: rodar duas vezes nao faz mal.
--
-- Origem: sql/contrato-unico-v1.sql, sql/contrato-unico-funcao-v1.sql

create table if not exists public.schema_migrations (
  arquivo     text primary key,
  sha256      text not null,
  aplicado_em timestamptz not null default now(),
  aplicado_por text
);
-- A RLS vai LIGADA pelo proprio arquivo, de proposito: o SQL Editor tem um
-- detector de "tabela criada sem RLS" que, quando acha uma, REESCREVE o
-- script e corta blocos no meio (o erro que sai e `unterminated
-- dollar-quoted string`, numa linha sem defeito). Sem o que acrescentar,
-- ele nao mexe. Quem trabalha nesta tabela e o servidor, com a service role.
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from anon, authenticated;


-- ===================================================================
-- sql/contrato-unico-v1.sql
-- ===================================================================

-- sql/contrato-unico-v1.sql
-- CONTRATO RECORRENTE NUM LUGAR SO (decisao do socio: "juntar os planos com
-- os contratos recorrentes e eliminar os planos").
--
-- Havia dois cadastros do mesmo acordo:
--   payment_plans    os PLANOS da ficha do cliente. Cobram de verdade:
--                    assinatura no Stripe, webhook, fatura do mes, baixa.
--                    Mas eram um valor so, mensal.
--   recurring_plans  os CONTRATOS RECORRENTES do Financeiro. Tinham a regra
--                    certa -- itens, desconto em dolar, prazo em dias,
--                    intervalo, edicao com senha e trilha -- e NUNCA
--                    cobraram nada: nenhuma rotina lia a tabela.
-- O motor fica (payment_plans: e nele que as assinaturas ATIVAS vivem e que o
-- webhook procura -- os planos ativos continuam cobrando, decisao do socio).
-- A regra dos contratos vem para ele.
--
-- O QUE FAZ, nesta ordem
--  1. payment_plan_items: as linhas do contrato (servico, qtd, preco).
--  2. payment_plans ganha discount, due_days, billing_interval
--     (monthly | quarterly | annual), collection_method (debito | fatura),
--     start_date, end_date e migrated_from (o contrato antigo de origem).
--  3. Os contratos antigos que nao terminaram viram planos em RASCUNHO, com
--     os itens deles. Rascunho de proposito: eles nunca cobraram, e ativar
--     sozinho cobraria em dobro quem a firma ja vem faturando a mao. Quem
--     ativa e o socio, um por um. Cobranca automatica marcada vira "debito"
--     (a equipe manda o link do cadastro); o resto vira "fatura" (a rotina
--     diaria emite).
--  4. Todo plano mensal que ja existe vira UMA linha (descricao e valor). O
--     valor cobrado nao muda; o modelo novo nao apaga o acordo antigo.
--  5. Uma fatura por contrato e por periodo: indice unico em
--     invoices (plan_id, competencia) -- o webhook e a rotina diaria
--     procuram por esse par antes de emitir. Se ja houver repetida no banco,
--     o indice NAO e criado e a lista final mostra quais.
--  6. CONGELA recurring_plans e recurring_plan_items: a service role nao
--     grava mais nelas. Ficam como rastro.
--
-- DECIDE PELO ESTADO DE DESTINO: contrato ja migrado (migrated_from) nao se
-- migra de novo, plano que ja tem linha nao ganha outra. Segunda rodada nao
-- faz nada (testado no PG 16).
--
-- O valor do plano (monthly_amount) continua sendo O VALOR DE CADA COBRANCA
-- -- num trimestral, o do trimestre. O nome ficou; a receita recorrente
-- MENSAL e dividida pelo intervalo no relatorio e no painel.
--
-- RODA DEPOIS de sql/equipe-unica-v1.sql (o socio de reserva sai de
-- team_members).
--
-- Idempotente. Cria tabela: liga a RLS aqui mesmo, nao atribui variavel por
-- consulta e nao define funcao -- as tres coisas que fazem o SQL Editor do
-- Supabase reescrever o arquivo. A funcao que troca as linhas esta em
-- sql/contrato-unico-funcao-v1.sql, que roda DEPOIS deste.

-- == 1. As linhas do contrato ===============================================
create table if not exists public.payment_plan_items (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null,                   -- payment_plans.id
  service_id  uuid,                            -- pricing_items.id (so informativo, como na fatura)
  description text not null,
  quantity    numeric(12,3) not null default 1 check (quantity > 0),
  unit_price  numeric(14,2) not null default 0 check (unit_price >= 0),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

alter table public.payment_plan_items enable row level security;
revoke all on public.payment_plan_items from anon, authenticated;

create index if not exists payment_plan_items_por_plano
  on public.payment_plan_items (plan_id, sort_order, created_at);

comment on table public.payment_plan_items is
  'Linhas do contrato recorrente. O valor de cada cobranca (payment_plans.monthly_amount) e a SOMA destas linhas menos o desconto -- derivado, nunca digitado a parte (salvar_itens_do_plano).';

-- == 2. O contrato no plano =================================================
alter table public.payment_plans add column if not exists discount numeric(14,2) not null default 0;
alter table public.payment_plans add column if not exists due_days integer not null default 0;
alter table public.payment_plans add column if not exists billing_interval text not null default 'monthly';
alter table public.payment_plans add column if not exists collection_method text not null default 'debito';
alter table public.payment_plans add column if not exists start_date date;
alter table public.payment_plans add column if not exists end_date date;
alter table public.payment_plans add column if not exists migrated_from uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_plans_discount_check'
                    and conrelid = 'public.payment_plans'::regclass) then
    alter table public.payment_plans add constraint payment_plans_discount_check check (discount >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_plans_due_days_check'
                    and conrelid = 'public.payment_plans'::regclass) then
    alter table public.payment_plans add constraint payment_plans_due_days_check
      check (due_days >= 0 and due_days <= 365);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_plans_billing_interval_check'
                    and conrelid = 'public.payment_plans'::regclass) then
    alter table public.payment_plans add constraint payment_plans_billing_interval_check
      check (billing_interval in ('monthly', 'quarterly', 'annual'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_plans_collection_method_check'
                    and conrelid = 'public.payment_plans'::regclass) then
    alter table public.payment_plans add constraint payment_plans_collection_method_check
      check (collection_method in ('debito', 'fatura'));
  end if;
end $$;

-- Indice SIMPLES: cada contrato antigo vira no maximo UM plano.
create unique index if not exists payment_plans_migrated_from_key on public.payment_plans (migrated_from);

comment on column public.payment_plans.monthly_amount is
  'O VALOR DE CADA COBRANCA (num trimestral, o do trimestre): soma dos itens menos o desconto, recalculada no banco (salvar_itens_do_plano). A receita mensal equivalente divide pelo intervalo.';
comment on column public.payment_plans.collection_method is
  'debito = assinatura no Stripe (o cliente cadastra o debito); fatura = a rotina diaria emite a fatura e o cliente paga pelo portal.';
comment on column public.payment_plans.migrated_from is
  'O contrato antigo (recurring_plans.id) de onde este plano veio, por sql/contrato-unico-v1.sql.';

-- == 3. Os contratos antigos viram planos em RASCUNHO ======================
-- O que ja terminou (end_date no passado, no dia do ESCRITORIO) fica so na
-- tabela antiga, como rastro.
do $$
begin
  if to_regclass('public.recurring_plans') is null then
    raise notice 'recurring_plans nao existe neste projeto: nada a trazer';
    return;
  end if;

  execute $q$
    insert into public.payment_plans
      (client_id, kind, status, description, monthly_amount, discount, due_days,
       billing_interval, collection_method, due_day, start_date, end_date, migrated_from, created_by)
    select r.client_id, 'monthly', 'draft',
           coalesce(nullif(btrim(to_jsonb(r)->>'description'), ''), 'Serviço'),
           coalesce((to_jsonb(r)->>'amount')::numeric, 0),
           greatest(coalesce((to_jsonb(r)->>'discount')::numeric, 0), 0),
           least(greatest(coalesce((to_jsonb(r)->>'due_days')::integer, 0), 0), 365),
           case when to_jsonb(r)->>'interval' in ('monthly', 'quarterly', 'annual')
                then to_jsonb(r)->>'interval' else 'monthly' end,
           case when coalesce((to_jsonb(r)->>'auto_charge')::boolean, false) then 'debito' else 'fatura' end,
           least(greatest(coalesce((to_jsonb(r)->>'day_of_month')::integer, 1), 1), 28),
           (to_jsonb(r)->>'start_date')::date,
           (to_jsonb(r)->>'end_date')::date,
           r.id,
           -- quem criou o contrato antigo; na falta, um socio (a coluna pode
           -- ser obrigatoria no banco do painel)
           coalesce((to_jsonb(r)->>'created_by')::uuid,
                    (select tm.user_id from public.team_members tm
                      where tm.level = 'owner' and tm.user_id is not null and tm.active
                      order by tm.name limit 1))
      from public.recurring_plans r
     where ((to_jsonb(r)->>'end_date') is null
            or (to_jsonb(r)->>'end_date')::date > (now() at time zone 'America/New_York')::date)
       and not exists (select 1 from public.payment_plans p where p.migrated_from = r.id)
  $q$;

  -- As linhas do contrato antigo, quando ele tinha.
  if to_regclass('public.recurring_plan_items') is not null then
    execute $q$
      insert into public.payment_plan_items (plan_id, description, quantity, unit_price, sort_order)
      select p.id, i.description, i.quantity, i.unit_price, i.sort_order
        from public.payment_plans p
        join public.recurring_plan_items i on i.plan_id = p.migrated_from
       where p.migrated_from is not null
         and not exists (select 1 from public.payment_plan_items x where x.plan_id = p.id)
    $q$;
  end if;
end $$;

-- == 4. Plano mensal sem linha ganha UMA (descricao e valor) ================
-- Vale para os planos de sempre e para o contrato antigo que nao tinha
-- linha. Sem isto todo plano abriria sem item nenhum -- o modelo novo
-- apagando o acordo em silencio.
insert into public.payment_plan_items (plan_id, description, quantity, unit_price, sort_order)
select p.id,
       coalesce(nullif(btrim(p.description), ''), 'Serviço'),
       1,
       greatest(coalesce(p.monthly_amount, 0), 0) + greatest(coalesce(p.discount, 0), 0),
       0
  from public.payment_plans p
 where p.kind in ('bookkeeping', 'monthly')
   and not exists (select 1 from public.payment_plan_items i where i.plan_id = p.id);

-- == 5. Uma fatura por contrato e por periodo ===============================
do $$
begin
  if to_regclass('public.invoices') is null then
    raise notice 'invoices nao existe neste projeto: indice do periodo fica para depois';
  elsif exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'invoices_plano_competencia_key') then
    null;
  elsif exists (select 1 from public.invoices
                 where plan_id is not null and competencia is not null
                 group by plan_id, competencia having count(*) > 1) then
    raise notice 'ha fatura repetida do mesmo contrato no mesmo periodo: indice NAO criado -- veja a lista no fim';
  else
    execute 'create unique index invoices_plano_competencia_key on public.invoices (plan_id, competencia)';
  end if;
end $$;

-- == 6. Os contratos antigos congelados =====================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    if to_regclass('public.recurring_plans') is not null then
      execute 'revoke insert, update, delete, truncate on public.recurring_plans from service_role';
      execute 'comment on table public.recurring_plans is ''CONGELADA por sql/contrato-unico-v1.sql: os contratos moram em payment_plans (migrated_from aponta para ca). Fica como rastro.''';
    end if;
    if to_regclass('public.recurring_plan_items') is not null then
      execute 'revoke insert, update, delete, truncate on public.recurring_plan_items from service_role';
    end if;
  end if;
end $$;

-- == Conferencia ============================================================
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.payment_plan_items'::regclass) then
    raise exception 'payment_plan_items sem RLS -- responderia ao navegador';
  end if;
  if exists (select 1 from information_schema.role_table_grants
              where table_schema = 'public' and table_name = 'payment_plan_items'
                and grantee in ('anon', 'authenticated')) then
    raise exception 'payment_plan_items ainda tem privilegio para anon/authenticated';
  end if;

  -- Todo plano mensal tem linha.
  if exists (select 1 from public.payment_plans p
              where p.kind in ('bookkeeping', 'monthly')
                and not exists (select 1 from public.payment_plan_items i where i.plan_id = p.id)) then
    raise exception 'ha plano mensal sem nenhuma linha';
  end if;

  -- Todo contrato antigo que nao terminou virou plano.
  if to_regclass('public.recurring_plans') is not null and exists (
       select 1 from public.recurring_plans r
        where ((to_jsonb(r)->>'end_date') is null
               or (to_jsonb(r)->>'end_date')::date > (now() at time zone 'America/New_York')::date)
          and not exists (select 1 from public.payment_plans p where p.migrated_from = r.id)) then
    raise exception 'ha contrato antigo vivo que nao virou plano';
  end if;

  -- Contrato trazido nasce RASCUNHO: ninguem passa a ser cobrado por esta
  -- migracao. Fora de rascunho so com um ato registrado (a ativacao).
  if to_regclass('public.plan_audit') is not null and exists (
       select 1 from public.payment_plans
        where migrated_from is not null and status <> 'draft'
          and not exists (select 1 from public.plan_audit a where a.plan_id = payment_plans.id)) then
    raise exception 'contrato trazido fora de rascunho sem nenhum ato registrado';
  end if;

  -- Os antigos estao congelados.
  if exists (select 1 from pg_roles where rolname = 'service_role')
     and to_regclass('public.recurring_plans') is not null
     and has_table_privilege('service_role', 'public.recurring_plans', 'INSERT, UPDATE, DELETE') then
    raise exception 'recurring_plans nao congelou';
  end if;

  raise notice 'contrato-unico-v1: conferencia ok';
end $$;

-- == O que ficou (uma consulta so: o SQL Editor mostra apenas a ultima) =====
-- CONTRATOS        cada plano mensal com o valor das linhas ao lado do gravado
-- REVISAR: valor   o valor gravado nao bate com a soma das linhas menos o
--                  desconto. A cobranca continua pelo gravado; salvar o
--                  contrato pela tela acerta (o banco recalcula).
-- REVISAR: duplo   contrato trazido em rascunho para um cliente que ja tem
--                  plano ativo com o mesmo valor: e provavel que seja o
--                  mesmo acordo. Nao ative os dois.
-- REVISAR: fatura  o mesmo contrato com mais de uma fatura no mesmo periodo
--                  (o indice unico nao foi criado por causa delas).
select lista, cliente, descricao, valor, linhas, intervalo, forma, situacao
  from (
    select 'CONTRATOS' as lista, 1 as ordem, p.client_id::text as cliente, p.description as descricao,
           p.monthly_amount as valor,
           round((select coalesce(sum(i.quantity * i.unit_price), 0) from public.payment_plan_items i
                   where i.plan_id = p.id) - p.discount, 2) as linhas,
           p.billing_interval as intervalo, p.collection_method as forma,
           p.status || case when p.migrated_from is not null then ' (trazido)' else '' end as situacao
      from public.payment_plans p
     where p.kind in ('bookkeeping', 'monthly')
    union all
    select 'REVISAR: valor', 2, p.client_id::text, p.description, p.monthly_amount,
           round((select coalesce(sum(i.quantity * i.unit_price), 0) from public.payment_plan_items i
                   where i.plan_id = p.id) - p.discount, 2),
           p.billing_interval, p.collection_method, p.status
      from public.payment_plans p
     where p.kind in ('bookkeeping', 'monthly')
       and round((select coalesce(sum(i.quantity * i.unit_price), 0) from public.payment_plan_items i
                   where i.plan_id = p.id) - p.discount, 2) <> round(coalesce(p.monthly_amount, 0), 2)
    union all
    select 'REVISAR: duplo', 3, m.client_id::text, m.description, m.monthly_amount, null,
           m.billing_interval, m.collection_method, 'rascunho trazido; ja ha plano ' || a.status
      from public.payment_plans m
      join public.payment_plans a
        on a.client_id = m.client_id and a.id <> m.id and a.migrated_from is null
       and a.kind in ('bookkeeping', 'monthly')
       and a.status in ('active', 'awaiting_setup', 'paused', 'payment_failed')
       and round(coalesce(a.monthly_amount, 0), 2) = round(coalesce(m.monthly_amount, 0), 2)
     where m.migrated_from is not null and m.status = 'draft'
  ) x
 order by ordem, cliente, descricao;


-- ===================================================================
-- sql/contrato-unico-funcao-v1.sql
-- ===================================================================

-- sql/contrato-unico-funcao-v1.sql
-- Trocar as linhas de um CONTRATO (payment_plans) e UMA operacao, nao duas.
--
-- RODA DEPOIS de sql/contrato-unico-v1.sql (que cria payment_plan_items).
-- Em arquivo PROPRIO porque o detector de RLS do SQL Editor do Supabase
-- reescreve arquivo que cria tabela E define funcao no mesmo lugar.
--
-- E a irma de salvar_itens_do_contrato (a dos contratos antigos, que ficaram
-- congelados): apagar e inserir em duas idas deixaria o contrato SEM NENHUMA
-- LINHA se a segunda falhasse -- o acordo apagado por uma falha de rede. E o
-- VALOR E RECALCULADO AQUI DENTRO: a tela manda as linhas; quanto o cliente
-- paga sai da soma delas, nunca de um numero vindo do navegador.
--
-- So para contrato (bookkeeping / monthly). Parcelamento tem cronograma
-- proprio e nao passa por aqui.
--
-- Idempotente (create or replace).

create or replace function public.salvar_itens_do_plano(
  p_plan_id  uuid,
  p_itens    jsonb,
  p_discount numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind    text;
  v_bruto   numeric(14,2);
  v_total   numeric(14,2);
  v_resumo  text;
  v_linhas  integer;
begin
  if p_plan_id is null then
    return jsonb_build_object('ok', false, 'erro', 'plan_id obrigatorio');
  end if;

  -- Trava a linha do contrato: duas edicoes simultaneas deixariam as linhas
  -- de uma com o valor da outra.
  select kind into v_kind from payment_plans where id = p_plan_id for update;
  if v_kind is null then
    return jsonb_build_object('ok', false, 'erro', 'contrato_inexistente');
  end if;
  if v_kind not in ('bookkeeping', 'monthly') then
    return jsonb_build_object('ok', false, 'erro', 'nao_e_contrato');
  end if;

  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    return jsonb_build_object('ok', false, 'erro', 'sem_itens');
  end if;

  delete from payment_plan_items where plan_id = p_plan_id;

  insert into payment_plan_items (plan_id, service_id, description, quantity, unit_price, sort_order)
  select p_plan_id, x.service_id, btrim(x.description), x.quantity, x.unit_price, x.ord
    from jsonb_to_recordset(p_itens)
         as x(service_id uuid, description text, quantity numeric, unit_price numeric, ord integer);

  -- O NUMERO QUE VALE SAI DAQUI, da soma das linhas gravadas.
  select coalesce(sum(quantity * unit_price), 0), count(*)
    into v_bruto, v_linhas
    from payment_plan_items where plan_id = p_plan_id;

  v_total := round(v_bruto - greatest(coalesce(p_discount, 0), 0), 2);
  if v_total <= 0 then
    -- Volta tudo: contrato que nao cobra nada nao e contrato, e valor
    -- negativo seria a firma pagando o cliente a cada periodo.
    raise exception 'desconto_maior_que_itens';
  end if;

  select string_agg(description, ' + ' order by sort_order, created_at)
    into v_resumo
    from (select description, sort_order, created_at from payment_plan_items
           where plan_id = p_plan_id order by sort_order, created_at limit 3) t;
  if v_linhas > 3 then
    v_resumo := v_resumo || ' +' || (v_linhas - 3);
  end if;

  update payment_plans
     set monthly_amount = v_total,
         discount       = greatest(coalesce(p_discount, 0), 0),
         description    = coalesce(nullif(v_resumo, ''), 'Serviço'),
         updated_at     = now()
   where id = p_plan_id;

  return jsonb_build_object('ok', true, 'linhas', v_linhas, 'bruto', v_bruto, 'total', v_total);
end $$;

revoke all on function public.salvar_itens_do_plano(uuid, jsonb, numeric) from public, anon, authenticated;
-- Explicito: security definer fechado para o navegador, aberto so para quem
-- trabalha nela (a rota, com a service role key). Sem depender do privilegio
-- padrao do schema, que muda de projeto para projeto.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.salvar_itens_do_plano(uuid, jsonb, numeric) to service_role';
  end if;
end $$;

comment on function public.salvar_itens_do_plano(uuid, jsonb, numeric) is
  'Troca as linhas de um contrato (payment_plans) e recalcula valor e resumo NO BANCO. As tres escritas valem juntas ou nenhuma.';

-- == Conferencia ============================================================
do $$
begin
  if to_regprocedure('public.salvar_itens_do_plano(uuid, jsonb, numeric)') is null then
    raise exception 'salvar_itens_do_plano nao foi criada';
  end if;
  if (select count(*) from information_schema.role_routine_grants
       where routine_schema = 'public' and routine_name = 'salvar_itens_do_plano'
         and grantee in ('anon', 'authenticated')) > 0 then
    raise exception 'salvar_itens_do_plano ainda pode ser chamada pelo navegador';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role')
     and not has_function_privilege('service_role', 'public.salvar_itens_do_plano(uuid, jsonb, numeric)', 'EXECUTE') then
    raise exception 'salvar_itens_do_plano fechada tambem para o servidor (service_role)';
  end if;
  raise notice 'salvar_itens_do_plano: criada e fechada para anon/authenticated';
end $$;


-- ===================================================================
-- Anotar no livro de migracoes
-- ===================================================================

insert into public.schema_migrations (arquivo, sha256, aplicado_por)
values
  ('sql/contrato-unico-v1.sql', '9eee7566348da8ba9e8a79356f5641fe4168730a42eb9fea1ab225708bacb3c9', 'sql-editor'),
  ('sql/contrato-unico-funcao-v1.sql', '70c206c99723f23b57bfbce08fbf6d19c195e437fa05b992cf5dd59974387267', 'sql-editor')
on conflict (arquivo) do update
  set sha256 = excluded.sha256, aplicado_em = now(), aplicado_por = excluded.aplicado_por;

select arquivo, left(sha256, 12) as sha, aplicado_em
  from public.schema_migrations
 where arquivo in ('sql/contrato-unico-v1.sql', 'sql/contrato-unico-funcao-v1.sql')
 order by arquivo;
