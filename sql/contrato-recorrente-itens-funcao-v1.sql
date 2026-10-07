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
