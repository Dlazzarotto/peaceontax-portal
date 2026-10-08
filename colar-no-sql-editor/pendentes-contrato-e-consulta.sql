-- COLE ESTE ARQUIVO INTEIRO NO SQL EDITOR DO SUPABASE E APERTE RUN.
--
-- GERADO por scripts/juntar-para-colar.mjs -- nao edite a mao.
-- Junta, NA ORDEM, as migracoes abaixo e anota as 4 no livro
-- (public.schema_migrations) com o MESMO sha256 que scripts/migrar.mjs
-- calcula: depois disso `--pendentes` diz APLICADO e ninguem roda de novo.
--
-- Cada parte e idempotente: rodar duas vezes nao faz mal.
--
-- Origem: sql/contrato-recorrente-auditoria-v1.sql, sql/contrato-recorrente-itens-v1.sql, sql/contrato-recorrente-itens-funcao-v1.sql, sql/consulta-de-faturas-v1.sql

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
-- sql/contrato-recorrente-auditoria-v1.sql
-- ===================================================================

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


-- ===================================================================
-- sql/contrato-recorrente-itens-v1.sql
-- ===================================================================

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


-- ===================================================================
-- sql/contrato-recorrente-itens-funcao-v1.sql
-- ===================================================================

-- sql/contrato-recorrente-itens-funcao-v1.sql
-- Trocar as linhas de um contrato e UMA operacao, nao duas.
--
-- RODA DEPOIS de sql/contrato-recorrente-itens-v1.sql (que cria a tabela).
-- Em arquivo PROPRIO porque o detector de RLS do SQL Editor do Supabase
-- reescreve arquivo que cria tabela E define funcao no mesmo lugar.
--
-- POR QUE RPC
-- Pelo PostgREST, trocar os itens seria: apagar os antigos, inserir os
-- novos, atualizar o total no contrato. Tres idas. Se a segunda falhar, o
-- contrato fica SEM NENHUMA LINHA e com um total que nao corresponde a
-- nada -- o acordo com o cliente apagado por uma falha de rede. Aqui as
-- tres valem juntas ou nenhuma, que e o mesmo motivo de conciliar_deposito.
--
-- O TOTAL E RECALCULADO NO BANCO. A tela manda as linhas; o numero que
-- vale sai da soma delas aqui dentro. Numero vindo do navegador nao define
-- quanto o cliente paga -- mesma regra da conciliacao.
--
-- Idempotente (create or replace).

create or replace function public.salvar_itens_do_contrato(
  p_plan_id  uuid,
  p_itens    jsonb,
  p_discount numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bruto   numeric(14,2);
  v_total   numeric(14,2);
  v_resumo  text;
  v_linhas  integer;
begin
  if p_plan_id is null then
    return jsonb_build_object('ok', false, 'erro', 'plan_id obrigatorio');
  end if;
  if not exists (select 1 from recurring_plans where id = p_plan_id) then
    return jsonb_build_object('ok', false, 'erro', 'contrato_inexistente');
  end if;

  -- Trava a linha do contrato: duas edicoes simultaneas da mesma carteira
  -- deixariam itens de uma com o total da outra.
  perform 1 from recurring_plans where id = p_plan_id for update;

  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    return jsonb_build_object('ok', false, 'erro', 'sem_itens');
  end if;

  delete from recurring_plan_items where plan_id = p_plan_id;

  insert into recurring_plan_items (plan_id, description, quantity, unit_price, sort_order)
  select p_plan_id,
         btrim(x.description),
         x.quantity,
         x.unit_price,
         x.ord
    from jsonb_to_recordset(p_itens)
         as x(description text, quantity numeric, unit_price numeric, ord integer);

  -- O NUMERO QUE VALE SAI DAQUI, da soma das linhas gravadas.
  select coalesce(sum(quantity * unit_price), 0), count(*)
    into v_bruto, v_linhas
    from recurring_plan_items where plan_id = p_plan_id;

  v_total := round(v_bruto - greatest(coalesce(p_discount, 0), 0), 2);
  if v_total <= 0 then
    -- Volta tudo: contrato que nao cobra nada nao e contrato, e um total
    -- negativo seria a firma pagando o cliente todo mes.
    raise exception 'desconto_maior_que_itens';
  end if;

  select string_agg(description, ' + ' order by sort_order, created_at)
    into v_resumo
    from (select description, sort_order, created_at from recurring_plan_items
           where plan_id = p_plan_id order by sort_order, created_at limit 3) t;

  if v_linhas > 3 then
    v_resumo := v_resumo || ' +' || (v_linhas - 3);
  end if;

  update recurring_plans
     set amount      = v_total,
         discount    = greatest(coalesce(p_discount, 0), 0),
         description = coalesce(nullif(v_resumo, ''), 'Serviço')
   where id = p_plan_id;

  return jsonb_build_object('ok', true, 'linhas', v_linhas, 'bruto', v_bruto, 'total', v_total);
end $$;

revoke all on function public.salvar_itens_do_contrato(uuid, jsonb, numeric) from public, anon, authenticated;

comment on function public.salvar_itens_do_contrato(uuid, jsonb, numeric) is
  'Troca as linhas de um contrato recorrente e recalcula total e resumo NO BANCO. As tres escritas valem juntas ou nenhuma.';

-- == Conferencia ============================================================
do $$
begin
  if to_regprocedure('public.salvar_itens_do_contrato(uuid, jsonb, numeric)') is null then
    raise exception 'salvar_itens_do_contrato nao foi criada';
  end if;

  if (select count(*) from information_schema.role_routine_grants
       where routine_schema = 'public' and routine_name = 'salvar_itens_do_contrato'
         and grantee in ('anon', 'authenticated')) > 0
  then
    raise exception 'salvar_itens_do_contrato ainda pode ser chamada pelo navegador';
  end if;

  raise notice 'salvar_itens_do_contrato: criada e fechada para anon/authenticated';
end $$;


-- ===================================================================
-- sql/consulta-de-faturas-v1.sql
-- ===================================================================

-- sql/consulta-de-faturas-v1.sql
-- AUTORIZACAO E TRILHA da consulta ampliada de faturas.
--
-- A REGRA: a lista de faturamento e do DIA e de QUEM EMITIU. Olhar dia
-- anterior ou fatura de outra pessoa e um ATO -- pede senha e motivo de um
-- gerente ou socio. So o SOCIO tem acesso ilimitado.
--
-- POR QUE A TABELA E UMA SO
-- Ela e a TRILHA (quem olhou o que, quando e por que) e a JANELA (ate
-- quando aquela liberacao vale) no mesmo lugar. Duas tabelas -- uma para
-- registrar e outra para valer -- poderiam discordar, e discordando a
-- pergunta "quem viu a carteira em setembro" deixa de ter resposta. E a
-- mesma razao pela qual `staff_grants` e append-only com uma view de
-- estado: o historico e o estado nao podem ser fontes diferentes.
--
-- Quem LIBERA nao e quem CONSULTA: `authorized_by` guarda o gerente ou
-- socio, `performed_by` guarda quem vai olhar. Sem os dois, "autorizado por
-- X" nao diz quem de fato leu a carteira.
--
-- `via` existe porque senha e codigo respondem perguntas diferentes: a
-- senha so prova que quem aprova estava NAQUELE teclado; o codigo prova que
-- um gerente, no proprio login, liberou a distancia. E a mesma distincao ja
-- gravada em `aprovadoVia` no recebimento.
--
-- Idempotente. Cria tabela: liga a RLS aqui mesmo, nao atribui variavel por
-- consulta e nao define funcao -- as tres coisas que fazem o SQL Editor do
-- Supabase reescrever o arquivo.

create table if not exists public.invoice_query_audit (
  id            uuid primary key default gen_random_uuid(),
  performed_by  uuid not null,                 -- quem vai consultar
  authorized_by uuid,                          -- o gerente/socio que liberou
  staff_level   text,                          -- nivel de quem consulta
  via           text not null default 'senha'
                check (via in ('senha', 'codigo', 'proprio')),
  reason        text not null,
  pedido        jsonb,                          -- periodo, situacao, emissor
  expira_em     timestamptz not null,
  created_at    timestamptz not null default now()
);

-- Nasce FECHADA para o navegador. No Supabase, tabela criada em `public` ja
-- vem com privilegio para anon e authenticated -- a RLS e o revoke e que
-- seguram. Sem policy, de proposito: quem le e escreve aqui e o servidor,
-- com a service role key, que passa por cima da RLS.
--
-- Aqui fechar importa DUAS vezes: a tabela diz quem olhou a carteira e
-- ate quando pode olhar. Aberta, bastaria uma linha inserida de fora para
-- alguem se autorizar sozinho -- a mesma escalada que `staff_grants` tinha.
alter table public.invoice_query_audit enable row level security;
revoke all on public.invoice_query_audit from anon, authenticated;

-- A consulta quente e "esta pessoa tem janela viva agora?".
create index if not exists invoice_query_audit_janela
  on public.invoice_query_audit (performed_by, expira_em desc);

comment on table public.invoice_query_audit is
  'Consulta ampliada de faturas: quem olhou alem do proprio dia, quem liberou, por que e ate quando. E a trilha E a janela -- duas tabelas poderiam discordar.';

-- == Conferencia ============================================================
do $$
begin
  if to_regclass('public.invoice_query_audit') is null then
    raise exception 'invoice_query_audit nao foi criada';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.invoice_query_audit'::regclass) then
    raise exception 'invoice_query_audit sem RLS -- quem tivesse a anon key se autorizaria sozinho';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'invoice_query_audit'
       and grantee in ('anon', 'authenticated'))
  then
    raise exception 'invoice_query_audit ainda tem privilegio para anon/authenticated';
  end if;

  if (select count(*) from pg_indexes
       where schemaname = 'public' and indexname = 'invoice_query_audit_janela') <> 1
  then
    raise exception 'falta o indice invoice_query_audit_janela';
  end if;

  -- MOTIVO E OBRIGATORIO. Uma consulta liberada sem motivo e uma linha que
  -- nao responde nada depois -- o oposto do que a tabela existe para fazer.
  execute 'create temp table _conferir_motivo (reason text not null)';
  begin
    insert into _conferir_motivo (reason) values (null);
    raise exception 'motivo deveria ser obrigatorio';
  exception when not_null_violation then
    null;  -- esperado
  end;
  drop table _conferir_motivo;

  -- O CHECK de `via` testado DE VERDADE, numa tabela TEMPORARIA com o
  -- predicado real: ler o texto do check nao prova nada, e inserir na tabela
  -- de verdade ja derrubou uma migracao aqui.
  execute format(
    'create temp table _conferir_via (via text, constraint c %s)',
    (select pg_get_constraintdef(oid) from pg_constraint
      where conname = 'invoice_query_audit_via_check'
        and conrelid = 'public.invoice_query_audit'::regclass));
  insert into _conferir_via (via) values ('senha'), ('codigo'), ('proprio');
  begin
    insert into _conferir_via (via) values ('nenhuma');
    raise exception 'o CHECK de via aceitou um valor que a rota nunca escreve';
  exception when check_violation then
    null;  -- esperado
  end;
  drop table _conferir_via;

  raise notice 'invoice_query_audit: tabela, indice, RLS, revoke, motivo obrigatorio e CHECK conferidos';
end $$;

select count(*) as consultas_ampliadas from public.invoice_query_audit;


-- ===================================================================
-- Anotar no livro de migracoes
-- ===================================================================

insert into public.schema_migrations (arquivo, sha256, aplicado_por)
values
  ('sql/contrato-recorrente-auditoria-v1.sql', 'c0ee56a411d4588cc7d79d45826f56991a4521daecd3c84fcf0727040b44913b', 'sql-editor'),
  ('sql/contrato-recorrente-itens-v1.sql', '6d3f4120ab8859540ab7822e74aa08dee0853bd256f343aae0635e3eaabecf48', 'sql-editor'),
  ('sql/contrato-recorrente-itens-funcao-v1.sql', 'a0cd02754545579d6e3fd9f2bd2b7c94ba70e5712514ea27e971470536125240', 'sql-editor'),
  ('sql/consulta-de-faturas-v1.sql', 'ee4a91bcc957c4b4662f65bdf00d78a562cbc977713711954ae3af35ce66f8b8', 'sql-editor')
on conflict (arquivo) do update
  set sha256 = excluded.sha256, aplicado_em = now(), aplicado_por = excluded.aplicado_por;

select arquivo, left(sha256, 12) as sha, aplicado_em
  from public.schema_migrations
 where arquivo in ('sql/contrato-recorrente-auditoria-v1.sql', 'sql/contrato-recorrente-itens-v1.sql', 'sql/contrato-recorrente-itens-funcao-v1.sql', 'sql/consulta-de-faturas-v1.sql')
 order by arquivo;
