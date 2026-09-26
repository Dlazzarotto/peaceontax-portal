-- sql/caixa-conciliacao-funcao-v1.sql
-- Conciliar um deposito com os recebimentos que o compoem -- num passo so.
--
-- POR QUE NO BANCO, E NAO NA ROTA
-- Sao cinco escritas que valem juntas ou nenhuma: a transferencia que esvazia
-- a conta de passagem, a taxa do Stripe, a marca em cada recebimento e a
-- classificacao do deposito. Metade gravada e livro sem conserto -- receita
-- lancada duas vezes ou taxa que nao existe. Conferir-e-gravar em dois passos
-- ja custou caro aqui (ver sql/recebimento-seguro-v1.sql).
--
-- O VALOR E RECALCULADO AQUI. A tela manda IDS; quanto isso soma e quanto
-- sobra de taxa quem decide e o banco. Numero vindo do navegador nao lanca
-- despesa.
--
-- A conta de passagem fecha em ZERO:
--   + recebimentos (bruto)  - taxa  - transferencia para o banco  =  0
--
-- Roda DEPOIS de sql/caixa-conciliacao-v1.sql. Idempotente (create or replace).
-- Nao cria tabela e nao atribui variavel por `select ... into` -- o detector
-- de RLS do SQL Editor le isso como criacao de tabela e reescreve o arquivo.

create or replace function public.conciliar_deposito(
  p_deposito     uuid,
  p_recebimentos uuid[],
  p_conta_taxa   text default 'Taxas de processamento'
) returns table (ok boolean, motivo text, bruto numeric, taxa numeric, transferencia uuid)
language plpgsql
as $function$
declare
  v_cliente uuid;
  v_conta   uuid;
  v_valor   numeric;
  v_data    date;
  v_bruto   numeric;
  v_dif     numeric;
  v_qtd     int;
  v_pedidos int;
  v_transf  uuid;
begin
  v_pedidos := coalesce(array_length(p_recebimentos, 1), 0);
  if v_pedidos = 0 then
    return query select false, 'sem_recebimentos'::text, 0::numeric, 0::numeric, null::uuid;
    return;
  end if;

  -- Trava as duas pontas ANTES de contar: dois depositos nao podem levar o
  -- mesmo recebimento, e o mesmo deposito nao pode ser conciliado duas vezes.
  perform 1 from public.bank_transactions where id = p_deposito for update;
  perform 1 from public.bank_transactions where id = any(p_recebimentos) for update;

  if not exists (select 1 from public.bank_transactions where id = p_deposito) then
    return query select false, 'deposito_nao_encontrado'::text, 0::numeric, 0::numeric, null::uuid;
    return;
  end if;

  v_cliente := (select client_id from public.bank_transactions where id = p_deposito);
  v_valor   := (select amount    from public.bank_transactions where id = p_deposito);
  v_data    := (select tx_date   from public.bank_transactions where id = p_deposito);

  if v_valor <= 0 then
    return query select false, 'nao_e_deposito'::text, 0::numeric, 0::numeric, null::uuid;
    return;
  end if;

  if exists (select 1 from public.bank_transactions where deposit_tx_id = p_deposito) then
    return query select false, 'ja_conciliado'::text, 0::numeric, 0::numeric, null::uuid;
    return;
  end if;

  -- Cada recebimento tem de ser do MESMO cliente, vir de um recebimento de
  -- fatura (payment_id) e ainda nao ter sido depositado.
  v_qtd := (select count(*) from public.bank_transactions
             where id = any(p_recebimentos)
               and client_id = v_cliente
               and payment_id is not null
               and deposit_tx_id is null);
  if v_qtd <> v_pedidos then
    return query select false, 'recebimento_invalido'::text, 0::numeric, 0::numeric, null::uuid;
    return;
  end if;

  v_bruto := (select round(coalesce(sum(amount), 0), 2) from public.bank_transactions
               where id = any(p_recebimentos));
  v_conta := (select account_id from public.bank_transactions
               where id = any(p_recebimentos) order by tx_date, id limit 1);
  v_dif   := round(v_bruto - v_valor, 2);

  -- Deposito MAIOR que os recebimentos e dinheiro sem recebimento lancado.
  -- Nao e taxa negativa: e fatura recebida que ninguem baixou.
  if v_dif < -0.005 then
    return query select false, 'falta_recebimento'::text, v_bruto, v_dif, null::uuid;
    return;
  end if;

  -- 1) A transferencia que esvazia a conta de passagem. Nao e despesa.
  insert into public.bank_transactions
    (client_id, account_id, source, tx_date, fiscal_year, description, amount,
     category, status, deposit_tx_id)
  values
    (v_cliente, v_conta, 'deposito', v_data, extract(year from v_data)::int,
     'Depósito no banco — ' || v_pedidos || ' recebimento(s)', round(-v_valor, 2),
     'Depósito de recebimentos', 'approved', p_deposito)
  returning id into v_transf;

  -- 2) A taxa retida (Stripe). Despesa dedutivel; sem ela a receita bruta
  --    nunca fecha com o banco e o 1099-K nao casa.
  if v_dif > 0.005 then
    insert into public.bank_transactions
      (client_id, account_id, source, tx_date, fiscal_year, description, amount,
       category, status, deposit_tx_id)
    values
      (v_cliente, v_conta, 'taxa', v_data, extract(year from v_data)::int,
       'Taxa retida no repasse', round(-v_dif, 2),
       p_conta_taxa, 'approved', p_deposito);
  end if;

  -- 3) Os recebimentos saem do saldo em transito.
  update public.bank_transactions
     set deposit_tx_id = p_deposito
   where id = any(p_recebimentos);

  -- 4) O deposito no extrato: nao e receita, e a outra ponta da transferencia.
  update public.bank_transactions
     set category = 'Depósito de recebimentos',
         status   = 'approved',
         transfer_match_id = v_transf
   where id = p_deposito;

  update public.bank_transactions
     set transfer_match_id = p_deposito
   where id = v_transf;

  return query select true, 'ok'::text, v_bruto, greatest(v_dif, 0), v_transf;
end
$function$;

-- Desfazer. O socio vai errar a selecao, e sem isto a unica saida seria SQL
-- na mao. Apaga SO o que a conciliacao criou (transferencia e taxa), solta os
-- recebimentos e devolve o deposito ao estado de nao classificado.
create or replace function public.desconciliar_deposito(
  p_deposito uuid
) returns table (ok boolean, motivo text, soltos int)
language plpgsql
as $function$
declare
  v_soltos int;
begin
  perform 1 from public.bank_transactions where id = p_deposito for update;

  if not exists (select 1 from public.bank_transactions where deposit_tx_id = p_deposito) then
    return query select false, 'nao_estava_conciliado'::text, 0;
    return;
  end if;

  -- As linhas criadas pela conciliacao (nunca as que vieram de recebimento)
  delete from public.bank_transactions
   where deposit_tx_id = p_deposito
     and payment_id is null
     and source in ('deposito', 'taxa');

  update public.bank_transactions
     set deposit_tx_id = null
   where deposit_tx_id = p_deposito
     and payment_id is not null;
  get diagnostics v_soltos = row_count;

  update public.bank_transactions
     set category = null, status = 'pending', transfer_match_id = null
   where id = p_deposito;

  return query select true, 'ok'::text, v_soltos;
end
$function$;
