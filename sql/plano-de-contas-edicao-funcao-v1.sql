-- sql/plano-de-contas-edicao-funcao-v1.sql
-- Editar, desativar e apagar uma conta do plano: cada uma e UMA transacao.
--
-- RODA DEPOIS de sql/plano-de-contas-edicao-v1.sql (a trilha) e de
-- sql/plano-de-contas-1099-v1.sql (a coluna form_1099). Em arquivo PROPRIO
-- porque o detector de RLS do SQL Editor do Supabase reescreve arquivo que
-- cria tabela E define funcao no mesmo lugar.
--
-- O QUE ACONTECIA
-- A rota renomeava a conta e DEPOIS, em idas separadas, os lancamentos, as
-- regras e as sub-contas, sem olhar o erro de nenhuma. O lancamento guarda o
-- NOME da conta, e o P&L trata conta que nao esta no plano como DESPESA: um
-- renomear pela metade mandava a receita da conta antiga para as despesas de
-- todos os clientes, e a tela dizia "conta atualizada". Apagar tinha o mesmo
-- desenho: os lancamentos que nao mudassem de conta ficavam com o nome de uma
-- conta que deixou de existir. E as sub-contas eram achadas por LIKE, que le
-- "_" e "%" do nome como curinga.
--
-- AGORA
--   editar_conta_do_plano       nome, grupo, mae e 1099, com lancamentos,
--                                regras, contas a pagar e sub-contas juntos
--   situacao_da_conta_do_plano  desativar (so sem lancamento e sem regra) e
--                                reativar
--   apagar_conta_do_plano       move tudo para o destino e apaga
-- Cada uma trava a linha, confere se a conta mudou desde que a rota a leu
-- (`mudou_no_meio`), grava a trilha e a mudanca na MESMA transacao -- ou
-- nenhuma das duas. As regras de negocio (o que pode, o que exige motivo e
-- senha, as contas do sistema) sao de lib/plano-de-contas.ts; aqui fica o
-- que depende do estado no instante da gravacao.
--
-- Idempotente (create or replace).

create or replace function public.editar_conta_do_plano(
  p_id         text,
  p_nome_atual text,
  p_nome       text,
  p_kind       text,
  p_form_1099  text,
  p_ator       uuid,
  p_motivo     text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id          text;
  v_nome        text;
  v_kind        text;
  v_form        text;
  v_mae         text;
  v_base        text;
  v_mae_atual   text;
  v_mae_kind    text;
  v_mae_ativa   boolean;
  v_prefixo     text;
  v_novo        text;
  v_despesa     boolean;
  v_motivo      text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_alcance     integer := 0;
  v_lanc        integer := 0;
  v_regras      integer := 0;
  v_contas      integer := 0;
  v_filhas      integer := 0;
  v_n           integer;
  r             record;
begin
  if p_id is null or coalesce(btrim(p_nome), '') = '' then
    return jsonb_build_object('ok', false, 'erro', 'pedido_incompleto');
  end if;
  if p_kind is null or p_kind not in ('income', 'cogs', 'expense', 'other_income',
                                      'other_expense', 'liability', 'asset', 'non_pnl') then
    return jsonb_build_object('ok', false, 'erro', 'grupo_invalido');
  end if;
  v_despesa := p_kind in ('expense', 'cogs', 'other_expense');
  if p_form_1099 is not null and (p_form_1099 not in ('NEC', 'MISC') or not v_despesa) then
    return jsonb_build_object('ok', false, 'erro', 'formulario_invalido');
  end if;

  -- Trava a conta: duas edicoes ao mesmo tempo deixariam os lancamentos com
  -- o nome de uma e a conta com o da outra.
  select id::text, name, kind, form_1099
    into v_id, v_nome, v_kind, v_form
    from bookkeeping_categories
   where id::text = p_id
     for update;
  if v_id is null then
    return jsonb_build_object('ok', false, 'erro', 'conta_inexistente');
  end if;
  if v_nome is distinct from p_nome_atual then
    return jsonb_build_object('ok', false, 'erro', 'mudou_no_meio', 'nome', v_nome);
  end if;

  v_prefixo := v_nome || ': ';
  if position(':' in v_nome) > 0 then
    v_mae_atual := btrim(split_part(v_nome, ':', 1));
  end if;

  -- O nome novo: "Conta" ou "Mae: Filha", um nivel so
  if position(':' in p_nome) > 0 then
    v_mae  := btrim(split_part(p_nome, ':', 1));
    v_base := btrim(substr(p_nome, position(':' in p_nome) + 1));
    if v_mae = '' or v_base = '' or position(':' in v_base) > 0
       or p_nome <> (v_mae || ': ' || v_base) then
      return jsonb_build_object('ok', false, 'erro', 'nome_malformado');
    end if;
  end if;

  if v_mae is not null then
    if v_mae = v_nome then
      return jsonb_build_object('ok', false, 'erro', 'mae_e_a_propria');
    end if;
    -- A mae fica travada ate o fim: renomeada no meio, a filha nasceria com
    -- o prefixo velho.
    select kind, active into v_mae_kind, v_mae_ativa
      from bookkeeping_categories
     where name = v_mae and position(':' in name) = 0
       for share;
    if v_mae_kind is null then
      return jsonb_build_object('ok', false, 'erro', 'mae_inexistente', 'mae', v_mae);
    end if;
    if not coalesce(v_mae_ativa, false) then
      return jsonb_build_object('ok', false, 'erro', 'mae_inativa', 'mae', v_mae);
    end if;
    if v_mae_kind <> p_kind then
      return jsonb_build_object('ok', false, 'erro', 'grupo_diferente_da_mae', 'mae', v_mae);
    end if;
    if v_mae is distinct from v_mae_atual and exists (
         select 1 from bookkeeping_categories
          where id::text <> v_id and left(name, char_length(v_prefixo)) = v_prefixo) then
      return jsonb_build_object('ok', false, 'erro', 'tem_subcontas');
    end if;
  end if;

  -- Nome tomado por outra conta (sem diferenca de caixa). As filhas, que se
  -- movem junto, nao contam.
  if p_nome <> v_nome then
    if exists (select 1 from bookkeeping_categories c
                where c.id::text <> v_id
                  and left(c.name, char_length(v_prefixo)) <> v_prefixo
                  and lower(btrim(c.name)) = lower(btrim(p_nome))) then
      return jsonb_build_object('ok', false, 'erro', 'nome_repetido');
    end if;
    if exists (select 1 from bookkeeping_categories f
                where f.id::text <> v_id
                  and left(f.name, char_length(v_prefixo)) = v_prefixo
                  and exists (select 1 from bookkeeping_categories o
                               where o.id::text <> v_id
                                 and left(o.name, char_length(v_prefixo)) <> v_prefixo
                                 and lower(btrim(o.name)) =
                                     lower(p_nome || ': ' || btrim(substr(f.name, char_length(v_prefixo) + 1))))) then
      return jsonb_build_object('ok', false, 'erro', 'nome_repetido_na_filha');
    end if;
  end if;

  -- O que a mudanca alcanca no livro: os lancamentos da conta e das filhas
  select count(*) into v_alcance
    from bank_transactions t
   where t.category = v_nome
      or t.category in (select f.name from bookkeeping_categories f
                         where f.id::text <> v_id and left(f.name, char_length(v_prefixo)) = v_prefixo);

  -- Conta em uso mudando de nome ou de grupo muda o livro de todos os
  -- clientes: o motivo fica na trilha, sempre. (A rota ja pede; aqui e a
  -- garantia de que nenhuma trilha dessas nasce sem ele.)
  if (p_nome <> v_nome or p_kind is distinct from v_kind) and v_alcance > 0 and v_motivo is null then
    return jsonb_build_object('ok', false, 'erro', 'motivo_obrigatorio', 'lancamentos', v_alcance);
  end if;

  update bookkeeping_categories
     set name = p_nome, kind = p_kind, form_1099 = p_form_1099
   where id::text = v_id;

  if p_nome <> v_nome then
    update bank_transactions set category = p_nome, updated_at = now() where category = v_nome;
    get diagnostics v_n = row_count;  v_lanc := v_lanc + v_n;
    update bookkeeping_rules set category = p_nome where category = v_nome;
    get diagnostics v_n = row_count;  v_regras := v_regras + v_n;
    if to_regclass('public.firm_bills') is not null then
      execute 'update public.firm_bills set category = $1 where category = $2' using p_nome, v_nome;
      get diagnostics v_n = row_count;  v_contas := v_contas + v_n;
    end if;
  end if;

  -- As filhas seguem a mae: o nome (o P&L agrupa pelo prefixo) e o grupo.
  if p_nome <> v_nome or p_kind is distinct from v_kind then
    for r in select f.id::text as fid, f.name as fnome
               from bookkeeping_categories f
              where f.id::text <> v_id and left(f.name, char_length(v_prefixo)) = v_prefixo
              order by f.name
                for update
    loop
      v_novo := case when p_nome <> v_nome
                     then p_nome || ': ' || btrim(substr(r.fnome, char_length(v_prefixo) + 1))
                     else r.fnome end;
      update bookkeeping_categories
         set name      = v_novo,
             kind      = case when p_kind is distinct from v_kind then p_kind else kind end,
             form_1099 = case when p_kind is distinct from v_kind and not v_despesa then null else form_1099 end
       where id::text = r.fid;
      if v_novo <> r.fnome then
        update bank_transactions set category = v_novo, updated_at = now() where category = r.fnome;
        get diagnostics v_n = row_count;  v_lanc := v_lanc + v_n;
        update bookkeeping_rules set category = v_novo where category = r.fnome;
        get diagnostics v_n = row_count;  v_regras := v_regras + v_n;
        if to_regclass('public.firm_bills') is not null then
          execute 'update public.firm_bills set category = $1 where category = $2' using v_novo, r.fnome;
          get diagnostics v_n = row_count;  v_contas := v_contas + v_n;
        end if;
      end if;
      v_filhas := v_filhas + 1;
    end loop;
  end if;

  -- A trilha, na mesma transacao: se qualquer passo acima falhar, nem a
  -- mudanca nem ela ficam. Vai no fim porque leva o que foi alcancado.
  insert into bookkeeping_category_audit (category_id, action, performed_by, reason, previous_state, new_state)
  values (v_id, 'editada', p_ator, v_motivo,
          jsonb_build_object('name', v_nome, 'kind', v_kind, 'form_1099', v_form),
          jsonb_build_object('name', p_nome, 'kind', p_kind, 'form_1099', p_form_1099,
                             'lancamentos_renomeados', v_lanc, 'lancamentos_alcancados', v_alcance,
                             'regras', v_regras, 'contas_a_pagar', v_contas, 'subcontas', v_filhas));

  return jsonb_build_object('ok', true, 'nome', p_nome, 'lancamentos', v_lanc, 'alcance', v_alcance,
                            'regras', v_regras, 'contas_a_pagar', v_contas, 'subcontas', v_filhas);
end $$;

create or replace function public.situacao_da_conta_do_plano(
  p_id         text,
  p_nome_atual text,
  p_ativa      boolean,
  p_ator       uuid,
  p_motivo     text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     text;
  v_nome   text;
  v_ativa  boolean;
  v_lanc   integer;
  v_regras integer;
begin
  if p_id is null or p_ativa is null then
    return jsonb_build_object('ok', false, 'erro', 'pedido_incompleto');
  end if;
  select id::text, name, active into v_id, v_nome, v_ativa
    from bookkeeping_categories where id::text = p_id for update;
  if v_id is null then
    return jsonb_build_object('ok', false, 'erro', 'conta_inexistente');
  end if;
  if v_nome is distinct from p_nome_atual then
    return jsonb_build_object('ok', false, 'erro', 'mudou_no_meio', 'nome', v_nome);
  end if;
  if coalesce(v_ativa, true) = p_ativa then
    return jsonb_build_object('ok', false, 'erro', 'sem_mudanca');
  end if;

  -- Desativar: ninguem pode estar usando. A regra conta: a que aponta para a
  -- conta inativa segue lancando nela a cada importacao.
  if not p_ativa then
    select count(*) into v_lanc from bank_transactions where category = v_nome;
    select count(*) into v_regras from bookkeeping_rules where category = v_nome;
    if v_lanc + v_regras > 0 then
      return jsonb_build_object('ok', false, 'erro', 'em_uso', 'lancamentos', v_lanc, 'regras', v_regras);
    end if;
  end if;

  update bookkeeping_categories set active = p_ativa where id::text = v_id;

  insert into bookkeeping_category_audit (category_id, action, performed_by, reason, previous_state, new_state)
  values (v_id, case when p_ativa then 'reativada' else 'desativada' end, p_ator,
          nullif(btrim(coalesce(p_motivo, '')), ''),
          jsonb_build_object('name', v_nome, 'active', v_ativa),
          jsonb_build_object('name', v_nome, 'active', p_ativa));

  return jsonb_build_object('ok', true, 'nome', v_nome, 'ativa', p_ativa);
end $$;

create or replace function public.apagar_conta_do_plano(
  p_id         text,
  p_nome_atual text,
  p_destino    text,
  p_ator       uuid,
  p_motivo     text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id           text;
  v_nome         text;
  v_kind         text;
  v_ativa        boolean;
  v_form         text;
  v_prefixo      text;
  v_destino      text := nullif(btrim(coalesce(p_destino, '')), '');
  v_motivo       text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_dest_kind    text;
  v_dest_ativa   boolean;
  v_lanc         integer;
  v_regras       integer;
  v_movidos      integer := 0;
  v_regras_mov   integer := 0;
  v_contas       integer := 0;
begin
  if p_id is null then
    return jsonb_build_object('ok', false, 'erro', 'pedido_incompleto');
  end if;
  select id::text, name, kind, active, form_1099 into v_id, v_nome, v_kind, v_ativa, v_form
    from bookkeeping_categories where id::text = p_id for update;
  if v_id is null then
    return jsonb_build_object('ok', false, 'erro', 'conta_inexistente');
  end if;
  if v_nome is distinct from p_nome_atual then
    return jsonb_build_object('ok', false, 'erro', 'mudou_no_meio', 'nome', v_nome);
  end if;

  v_prefixo := v_nome || ': ';
  if exists (select 1 from bookkeeping_categories
              where id::text <> v_id and left(name, char_length(v_prefixo)) = v_prefixo) then
    return jsonb_build_object('ok', false, 'erro', 'tem_subcontas');
  end if;

  select count(*) into v_lanc from bank_transactions where category = v_nome;
  select count(*) into v_regras from bookkeeping_rules where category = v_nome;
  if v_lanc + v_regras > 0 and v_destino is null then
    return jsonb_build_object('ok', false, 'erro', 'em_uso', 'lancamentos', v_lanc, 'regras', v_regras);
  end if;

  if v_destino is not null then
    if v_destino = v_nome then
      return jsonb_build_object('ok', false, 'erro', 'destino_e_a_propria');
    end if;
    select kind, active into v_dest_kind, v_dest_ativa
      from bookkeeping_categories where name = v_destino for share;
    if v_dest_kind is null then
      return jsonb_build_object('ok', false, 'erro', 'destino_inexistente');
    end if;
    if v_dest_kind <> v_kind then
      return jsonb_build_object('ok', false, 'erro', 'destino_de_outro_grupo');
    end if;
    if not coalesce(v_dest_ativa, false) then
      return jsonb_build_object('ok', false, 'erro', 'destino_inativo');
    end if;
  end if;

  if v_lanc > 0 and v_motivo is null then
    return jsonb_build_object('ok', false, 'erro', 'motivo_obrigatorio', 'lancamentos', v_lanc);
  end if;

  if v_destino is not null then
    update bank_transactions set category = v_destino, updated_at = now() where category = v_nome;
    get diagnostics v_movidos = row_count;
    update bookkeeping_rules set category = v_destino where category = v_nome;
    get diagnostics v_regras_mov = row_count;
  end if;
  -- Conta a pagar: a conta contabil e so uma sugestao, entao sem destino
  -- ela fica sem sugestao (nulo), em vez de apontar para conta que sumiu.
  if to_regclass('public.firm_bills') is not null then
    execute 'update public.firm_bills set category = $1 where category = $2' using v_destino, v_nome;
    get diagnostics v_contas = row_count;
  end if;

  insert into bookkeeping_category_audit (category_id, action, performed_by, reason, previous_state, new_state)
  values (v_id, 'apagada', p_ator, v_motivo,
          jsonb_build_object('name', v_nome, 'kind', v_kind, 'active', v_ativa, 'form_1099', v_form),
          jsonb_build_object('destino', v_destino, 'lancamentos', v_movidos,
                             'regras', v_regras_mov, 'contas_a_pagar', v_contas));

  delete from bookkeeping_categories where id::text = v_id;

  return jsonb_build_object('ok', true, 'nome', v_nome, 'destino', v_destino,
                            'lancamentos', v_movidos, 'regras', v_regras_mov, 'contas_a_pagar', v_contas);
end $$;

-- Fechadas para o navegador, abertas so para quem trabalha nelas (a rota,
-- com a service role key). Explicito: sem depender do privilegio padrao do
-- schema, que muda de projeto para projeto.
revoke all on function public.editar_conta_do_plano(text, text, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.situacao_da_conta_do_plano(text, text, boolean, uuid, text) from public, anon, authenticated;
revoke all on function public.apagar_conta_do_plano(text, text, text, uuid, text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.editar_conta_do_plano(text, text, text, text, text, uuid, text) to service_role';
    execute 'grant execute on function public.situacao_da_conta_do_plano(text, text, boolean, uuid, text) to service_role';
    execute 'grant execute on function public.apagar_conta_do_plano(text, text, text, uuid, text) to service_role';
  end if;
end $$;

comment on function public.editar_conta_do_plano(text, text, text, text, text, uuid, text) is
  'Nome, grupo, mae e 1099 de uma conta do plano, com lancamentos, regras, contas a pagar, sub-contas e trilha numa transacao so.';
comment on function public.situacao_da_conta_do_plano(text, text, boolean, uuid, text) is
  'Desativa (so sem lancamento e sem regra) ou reativa uma conta do plano, com trilha.';
comment on function public.apagar_conta_do_plano(text, text, text, uuid, text) is
  'Move lancamentos, regras e contas a pagar para o destino e apaga a conta, com trilha, numa transacao so.';

-- == Conferencia ============================================================
do $$
declare
  f text;
begin
  if to_regclass('public.bookkeeping_category_audit') is null then
    raise exception 'falta a trilha: rode antes sql/plano-de-contas-edicao-v1.sql';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'bookkeeping_categories'
                    and column_name = 'form_1099') then
    raise exception 'falta bookkeeping_categories.form_1099: rode antes sql/plano-de-contas-1099-v1.sql';
  end if;
  foreach f in array array[
    'public.editar_conta_do_plano(text, text, text, text, text, uuid, text)',
    'public.situacao_da_conta_do_plano(text, text, boolean, uuid, text)',
    'public.apagar_conta_do_plano(text, text, text, uuid, text)'
  ] loop
    if to_regprocedure(f) is null then
      raise exception '% nao foi criada', f;
    end if;
    if (exists (select 1 from pg_roles where rolname = 'anon') and has_function_privilege('anon', f, 'EXECUTE'))
       or (exists (select 1 from pg_roles where rolname = 'authenticated') and has_function_privilege('authenticated', f, 'EXECUTE')) then
      raise exception '% ainda pode ser chamada pelo navegador', f;
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role')
       and not has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception '% fechada tambem para o servidor (service_role)', f;
    end if;
  end loop;
  raise notice 'plano-de-contas-edicao-funcao-v1: tres funcoes criadas e fechadas para anon/authenticated';
end $$;
