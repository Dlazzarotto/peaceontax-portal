-- sql/caixa-saldo-da-conta-v1.sql
-- O SALDO da conta bancaria, vindo do banco.
--
-- POR QUE
-- O fluxo de caixa projetado parte do saldo de hoje. Ate aqui o unico saldo
-- que o sistema guardava era `bank_transactions.balance` -- o saldo CORRIDO
-- que alguns extratos em CSV trazem por linha. A sincronizacao do Plaid
-- nunca gravou isso, e nao tem como: o `/transactions/sync` traz a
-- transacao, nao o saldo depois dela.
--
-- Resultado: para quem conectou o banco (que e o caminho recomendado), o
-- saldo era SEMPRE desconhecido, e a projecao nascia sem o numero de que
-- depende. O `/accounts/get` que a sincronizacao JA chama traz
-- `balances.current` -- so faltava onde guardar.
--
-- SAO DUAS PERGUNTAS DIFERENTES, E E POR ISSO QUE SAO DUAS COLUNAS
--   · `bank_accounts.current_balance` -> "quanto tem na conta HOJE"
--     (o banco diz; e o que o fluxo projetado usa)
--   · `bank_transactions.balance`     -> "quanto tinha em 31/12"
--     (o saldo corrido do extrato; e o que o balanco usa)
-- Nao e duplicacao: um saldo historico nao responde pelo de hoje, e o de
-- hoje nao responde por 31 de dezembro do ano passado.
--
-- Cartao de credito tambem recebe saldo, mas ali ele e DIVIDA -- quem soma
-- caixa (lib/fluxo-de-caixa.ts) deixa cartao de fora de proposito.
--
-- Idempotente. Nao cria tabela, nao define funcao e nao atribui variavel
-- por consulta -- o detector de RLS do SQL Editor nao tem o que reescrever.

alter table public.bank_accounts
  add column if not exists current_balance numeric(14,2);

alter table public.bank_accounts
  add column if not exists available_balance numeric(14,2);

alter table public.bank_accounts
  add column if not exists balance_as_of timestamptz;

comment on column public.bank_accounts.current_balance is
  'Saldo informado pelo banco (Plaid /accounts/get). Em cartao de credito e divida.';
comment on column public.bank_accounts.balance_as_of is
  'Quando o saldo foi lido. Saldo sem data nao se mostra como "hoje".';

-- == Conferencia ===========================================================
-- Confere o SCHEMA, sem escrever nada. A conferencia de
-- sql/caixa-origens-v1.sql inseriu numa tabela real para testar um CHECK,
-- bateu numa coluna NOT NULL que ela nao conhecia e derrubou a migracao
-- inteira (o SQL Editor roda tudo numa transacao). Conferencia nao toca em
-- dado de producao.
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'bank_accounts'
         and column_name in ('current_balance', 'available_balance', 'balance_as_of')) <> 3
  then
    raise exception 'faltam colunas de saldo em bank_accounts';
  end if;
  raise notice 'bank_accounts: current_balance, available_balance e balance_as_of prontos';
end $$;

select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'bank_accounts'
   and column_name in ('current_balance', 'available_balance', 'balance_as_of')
 order by column_name;
