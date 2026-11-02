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
