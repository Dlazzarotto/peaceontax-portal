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
      -- A UNIAO, sem repetir e em ordem fixa: `union` ja elimina a duplicata
      -- (um `||` cru deixava `plaid` duas vezes no texto do CHECK) e o
      -- `order by` faz a regra sair igual em toda rodada -- sem isso,
      -- comparar o CHECK de dois bancos acusa diferenca que nao existe.
      select array(
        select distinct origem from (
          -- o que ja esta gravado na tabela...
          select source as origem
            from public.bank_transactions
           where source is not null
          union
          -- ...mais o que o codigo grava hoje (o caixa trouxe os tres ultimos)
          select unnest(array['plaid', 'csv', 'pdf', 'quickbooks', 'manual',
                              'historico', 'regra', 'recebimento', 'deposito',
                              'taxa'])
        ) u
        order by origem
      )
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

  -- As tres do caixa precisam caber. Conferir o TEXTO do CHECK nao prova
  -- nada, mas inserir na tabela de verdade tambem nao serve: a primeira
  -- versao desta conferencia fez `insert into bank_transactions` com tres
  -- colunas e bateu em
  --   null value in column "description" violates not-null constraint
  -- derrubando a migracao INTEIRA (o SQL Editor roda tudo numa transacao,
  -- entao o CHECK novo voltou atras junto). Conferencia nao pode depender
  -- de colunas que ela nao conhece.
  --
  -- Entao: copia-se o CHECK real para uma tabela TEMPORARIA de uma coluna e
  -- testa-se nela. Mesmo predicado, nenhuma dependencia do resto do schema,
  -- e nada tocado em bank_transactions.
  execute format('create temp table _conferir_origem (source text, constraint c %s)',
    (select pg_get_constraintdef(oid) from pg_constraint
      where conname = 'bank_transactions_source_check'
        and conrelid = 'public.bank_transactions'::regclass));
  insert into _conferir_origem (source) values ('recebimento'), ('deposito'), ('taxa');
  drop table _conferir_origem;

  raise notice 'bank_transactions.source: recebimento, deposito e taxa cabem no CHECK';
end $$;

-- As origens que a tabela conhece hoje
select source, count(*) as lancamentos
  from public.bank_transactions
 group by source
 order by count(*) desc;
