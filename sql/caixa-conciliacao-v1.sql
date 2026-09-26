-- sql/caixa-conciliacao-v1.sql
-- CONCILIACAO DE DEPOSITO: as colunas e as contas contabeis.
--
-- O DESENHO (decidido com o socio)
-- A contabilidade fiscal da firma e por REGIME DE CAIXA e a DESPESA vem
-- direto do extrato. A RECEITA nao vem: ela nasce no RECEBIMENTO da fatura
-- (cheque, Zelle, especie, cartao/ACH pelo Stripe) e fica numa conta de
-- passagem -- "Recebimentos a depositar", o Undeposited Funds do QuickBooks.
-- O deposito no banco apenas ESVAZIA essa conta.
--
-- POR QUE NAO LER A RECEITA DO EXTRATO
-- Na MESMA conta caem duas coisas diferentes: o deposito de cheque e Zelle
-- (um a um) e o REPASSE do Stripe, que junta varios pagamentos e chega
-- LIQUIDO da taxa. Lendo so o extrato, a receita bruta nunca fecha -- e e a
-- bruta que o Stripe informa ao IRS no 1099-K. Aqui o repasse de $970 vira
-- $1.000 de receita (que ja entrou no recebimento) e $30 de taxa, despesa
-- dedutivel.
--
-- A conta de passagem FECHA EM ZERO, e e isso que prova a conciliacao:
--   + recebimentos (bruto)  - taxa  - transferencia para o banco  =  0
--
-- AS DUAS COLUNAS
--   payment_id    -- o recebimento (invoice_payments) que originou a linha da
--                    conta de passagem. UNICO: a sincronizacao roda de novo a
--                    cada abertura da tela e nao pode duplicar receita.
--   deposit_tx_id -- qual deposito bancario levou esta linha embora. Nulo =
--                    ainda em transito (e o saldo da conta de passagem).
--
-- Idempotente. Nao cria tabela e nao define funcao (a funcao esta em
-- sql/caixa-conciliacao-funcao-v1.sql), entao o detector de RLS do SQL
-- Editor nao tem o que reescrever aqui.

alter table public.bank_transactions
  add column if not exists payment_id uuid;

alter table public.bank_transactions
  add column if not exists deposit_tx_id uuid;

comment on column public.bank_transactions.payment_id is
  'invoice_payments.id que originou esta linha da conta de passagem. Unico: a sincronizacao e idempotente.';
comment on column public.bank_transactions.deposit_tx_id is
  'bank_transactions.id do deposito bancario que levou esta linha. Nulo = ainda nao depositado.';

-- Um recebimento, uma linha. Sem isto, sincronizar duas vezes dobraria a
-- receita do ano -- e ninguem notaria ate o P&L.
create unique index if not exists bank_tx_um_por_recebimento
  on public.bank_transactions (payment_id) where payment_id is not null;

create index if not exists bank_tx_por_deposito
  on public.bank_transactions (deposit_tx_id) where deposit_tx_id is not null;

-- As tres contas contabeis do fluxo. O plano de contas e GLOBAL (nao tem
-- client_id), entao so entra o que serve a qualquer cliente -- e serve:
-- todo mundo que recebe por cartao paga taxa.
insert into public.bookkeeping_categories (name, kind)
select v.name, v.kind
  from (values
    ('Receita de serviços',      'income'),
    ('Taxas de processamento',   'expense'),
    ('Depósito de recebimentos', 'non_pnl')
  ) as v(name, kind)
 where not exists (
   select 1 from public.bookkeeping_categories c where c.name = v.name
 );

-- == Conferencia ===========================================================
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'bank_transactions'
         and column_name in ('payment_id', 'deposit_tx_id')) <> 2
  then
    raise exception 'faltam colunas em bank_transactions';
  end if;

  if (select count(*) from pg_indexes
       where schemaname = 'public' and indexname = 'bank_tx_um_por_recebimento') <> 1
  then
    raise exception 'falta o indice unico bank_tx_um_por_recebimento -- sincronizar duas vezes dobraria a receita';
  end if;

  if (select count(*) from public.bookkeeping_categories
       where name in ('Receita de serviços','Taxas de processamento','Depósito de recebimentos')) <> 3
  then
    raise exception 'faltam contas contabeis do fluxo de deposito';
  end if;

  raise notice 'conciliacao de deposito: colunas, indices e contas no lugar';
end $$;

-- O que o P&L vai fazer com cada uma das tres
select name, kind, active
  from public.bookkeeping_categories
 where name in ('Receita de serviços','Taxas de processamento','Depósito de recebimentos')
 order by kind;
