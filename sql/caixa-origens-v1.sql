-- sql/caixa-origens-v1.sql
-- A ORIGEM do lancamento: deixar o caixa da firma caber no CHECK.
--
-- O QUE QUEBROU
--   new row for relation "bank_transactions" violates check constraint
--   "bank_transactions_source_check"
--
-- `bank_transactions.source` tem um CHECK com lista fechada de origens, e o
-- caixa da firma trouxe tres que nao existiam: `recebimento` (o recebimento
-- de fatura entrando na conta de passagem), `deposito` (a transferencia que
-- esvazia essa conta) e `taxa` (a retida no repasse do Stripe). A funcao
-- `desconciliar_deposito` DEPENDE dessas duas ultimas: ela apaga
-- `where source in ('deposito','taxa')` para nao tocar no que veio do banco.
--
-- POR QUE NINGUEM VIU ANTES
-- O CHECK nao esta em arquivo nenhum: nasceu no painel do Supabase. E o caso
-- que o CLAUDE.md ja descreve -- "schema que so existe no banco vira
-- folclore". Esta migracao traz a regra para o repositorio.
--
-- COMO ELA NAO QUEBRA O QUE JA EXISTE
-- A lista nova e a UNIAO de (a) tudo o que ja esta gravado na tabela e (b) o
-- que o codigo grava hoje. Montada assim, nenhuma linha existente pode ficar
-- de fora -- inclusive origens que alguem criou e que nao estao no codigo.
-- Dropar e recriar com uma lista "que eu acho que e a certa" poderia recusar
-- uma origem antiga e travar a importacao sem aviso.
--
-- Idempotente. Nao cria tabela e nao atribui variavel por consulta (a
-- subconsulta vai dentro do `format`), entao o SQL Editor nao reescreve.

alter table public.bank_transactions
  drop constraint if exists bank_transactions_source_check;

do $$
begin
  execute format(
    'alter table public.bank_transactions add constraint bank_transactions_source_check '
    || 'check (source is null or source = any (%L::text[]))',
    (
      -- o que ja existe na tabela...
      select array(select distinct source
                     from public.bank_transactions
                    where source is not null)
      -- ...mais o que o codigo grava hoje (o caixa trouxe os tres ultimos)
          || array['plaid', 'csv', 'pdf', 'quickbooks', 'manual', 'historico',
                   'regra', 'recebimento', 'deposito', 'taxa']
    )
  );
end $$;

-- == Conferencia ===========================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'bank_transactions_source_check'
       and conrelid = 'public.bank_transactions'::regclass)
  then
    raise exception 'o CHECK de source nao foi recriado';
  end if;

  -- As tres do caixa precisam caber. Testa de verdade, numa transacao que
  -- volta atras: conferir o texto do CHECK nao prova nada.
  begin
    insert into public.bank_transactions (client_id, tx_date, amount, source)
    values (gen_random_uuid(), current_date, 1, 'recebimento'),
           (gen_random_uuid(), current_date, 1, 'deposito'),
           (gen_random_uuid(), current_date, 1, 'taxa');
    raise exception 'conferencia_ok';   -- desfaz o insert de propósito
  exception
    when check_violation then
      raise exception 'o CHECK ainda recusa recebimento/deposito/taxa';
    when others then
      if sqlerrm <> 'conferencia_ok' then raise; end if;
  end;

  raise notice 'bank_transactions.source: recebimento, deposito e taxa cabem no CHECK';
end $$;

-- As origens que a tabela conhece hoje
select source, count(*) as lancamentos
  from public.bank_transactions
 group by source
 order by count(*) desc;
