-- Debito em conta (ACH) em transito: a fatura passa a saber que ha dinheiro a caminho
--
-- O ACH leva dias. O Stripe manda checkout.session.completed assim que o
-- cliente conclui, mas o dinheiro so chega depois (async_payment_succeeded) -
-- ou nao chega (async_payment_failed). Entre um e outro a fatura ficava
-- IDENTICA a uma fatura nao paga: entrava no contas a receber, recebia
-- lembrete de cobranca e aceitava baixa manual. Quem registrasse o Zelle nesse
-- meio tempo criava recebimento em dobro quando o ACH caisse.
--
-- Estas colunas dao estado a esse intervalo. Nada de dinheiro entra aqui: o
-- recebimento continua nascendo so quando o banco confirma.
--
-- Idempotente. Rodar com: npm run migrar -- sql/ach-em-transito-v1.sql

alter table public.invoices add column if not exists ach_desde timestamptz;
alter table public.invoices add column if not exists ach_sessao text;
alter table public.invoices add column if not exists ach_valor numeric(12,2);

comment on column public.invoices.ach_desde is
  'Quando o cliente concluiu um debito em conta cujo dinheiro ainda nao chegou. Nulo = nada em transito.';
comment on column public.invoices.ach_sessao is
  'Sessao do Stripe do debito em transito, para casar a confirmacao ou a devolucao.';
comment on column public.invoices.ach_valor is
  'Valor do debito em transito, para a equipe saber quanto esperar sem abrir o Stripe.';

-- Quem esta esperando dinheiro: a consulta da rotina diaria e da tela
create index if not exists invoices_ach_desde_idx
  on public.invoices (ach_desde) where ach_desde is not null;

-- Uma sessao do Stripe nao pode estar em transito em duas faturas
create unique index if not exists invoices_ach_sessao_uk
  on public.invoices (ach_sessao) where ach_sessao is not null;

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  c integer; i1 integer; i2 integer;
begin
  select count(*) into c from information_schema.columns
   where table_schema = 'public' and table_name = 'invoices'
     and column_name in ('ach_desde', 'ach_sessao', 'ach_valor');
  select count(*) into i1 from pg_indexes
   where schemaname = 'public' and indexname = 'invoices_ach_desde_idx';
  select count(*) into i2 from pg_indexes
   where schemaname = 'public' and indexname = 'invoices_ach_sessao_uk';
  raise notice 'colunas de ACH em transito (esperado 3): %', c;
  raise notice 'indice invoices_ach_desde_idx: %', i1;
  raise notice 'indice invoices_ach_sessao_uk: %', i2;
  if c <> 3 or i1 = 0 or i2 = 0 then
    raise exception 'Migracao incompleta -- confira os avisos acima';
  end if;
end $$;
