-- sql/caixa-conciliacao-v2.sql
-- O indice de "um lancamento por recebimento" tem de ser SIMPLES, nao parcial.
--
-- O QUE QUEBROU
-- A sincronizacao dos recebimentos falhou na firma com:
--   Nao foi possivel lancar os recebimentos: there is no unique or exclusion
--   constraint matching the ON CONFLICT specification
--
-- A v1 criou o indice como PARCIAL (`where payment_id is not null`). Para o
-- Postgres INFERIR um indice parcial num `on conflict (payment_id)`, o
-- comando precisaria repetir o predicado (`on conflict (payment_id) where
-- payment_id is not null`) -- e o PostgREST, que e por onde o servidor fala
-- com o banco, nao tem como mandar esse `where`. Resultado: o upsert nunca
-- encontrava o indice e a tela nao lancava recebimento nenhum.
--
-- POR QUE O SIMPLES RESOLVE E NAO AFROUXA NADA
-- Em UNIQUE, o Postgres trata cada NULL como distinto: as dezenas de
-- milhares de linhas do extrato (todas com payment_id nulo) continuam
-- entrando sem conflito. O que o indice impede e o que a gente quer impedir
-- -- dois lancamentos para o MESMO recebimento, que dobraria a receita do
-- ano. Conferido no PostgreSQL 16, nos dois sentidos.
--
-- Roda DEPOIS de sql/caixa-conciliacao-v1.sql. Idempotente: so troca o
-- indice quando ele ainda e o parcial.

do $$
begin
  if exists (
    select 1 from pg_index i
      join pg_class c on c.oid = i.indexrelid
     where c.relname = 'bank_tx_um_por_recebimento'
       and i.indpred is not null)          -- indpred preenchido = indice PARCIAL
  then
    execute 'drop index public.bank_tx_um_por_recebimento';
  end if;
end $$;

create unique index if not exists bank_tx_um_por_recebimento
  on public.bank_transactions (payment_id);

-- == Conferencia ===========================================================
do $$
begin
  if (select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname = 'bank_tx_um_por_recebimento') <> 1
  then
    raise exception 'o indice bank_tx_um_por_recebimento sumiu';
  end if;

  if (select i.indpred is not null from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname = 'bank_tx_um_por_recebimento')
  then
    raise exception 'o indice continua PARCIAL -- o on conflict nao vai enxerga-lo';
  end if;

  if not (select i.indisunique from pg_index i join pg_class c on c.oid = i.indexrelid
           where c.relname = 'bank_tx_um_por_recebimento')
  then
    raise exception 'o indice deixou de ser UNICO -- sincronizar duas vezes dobraria a receita';
  end if;

  raise notice 'bank_tx_um_por_recebimento: unico e simples, o on conflict enxerga';
end $$;

select count(*) filter (where payment_id is not null) as lancamentos_de_recebimento,
       count(*)                                        as lancamentos_no_total
  from public.bank_transactions;
