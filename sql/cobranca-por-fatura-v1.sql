-- Cobranca por fatura: a fatura nasce ANTES do debito e guarda a invoice do Stripe
--
-- Regra do socio: primeiro emite a fatura, depois cobra. Se o debito falhar
-- (NSF), a fatura fica em aberto: pode-se cobrar de novo, ou o cliente paga
-- por Zelle/dinheiro e a baixa manual tira a fatura da linha de cobranca do
-- Stripe (invoice paga "fora do Stripe"). Para isso o sistema precisa saber
-- qual invoice do Stripe corresponde a cada fatura e a cada parcela.
--
-- Idempotente. Rodar no SQL Editor do Supabase.

alter table public.invoices add column if not exists stripe_invoice text;
create unique index if not exists invoices_stripe_invoice_uk
  on public.invoices (stripe_invoice) where stripe_invoice is not null;

alter table public.invoice_installments add column if not exists stripe_invoice text;
create index if not exists invoice_installments_stripe_invoice_idx
  on public.invoice_installments (stripe_invoice) where stripe_invoice is not null;

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  c1 integer; c2 integer; i1 integer;
begin
  select count(*) into c1 from information_schema.columns
   where table_schema = 'public' and table_name = 'invoices' and column_name = 'stripe_invoice';
  select count(*) into c2 from information_schema.columns
   where table_schema = 'public' and table_name = 'invoice_installments' and column_name = 'stripe_invoice';
  select count(*) into i1 from pg_indexes
   where schemaname = 'public' and indexname = 'invoices_stripe_invoice_uk';
  raise notice 'invoices.stripe_invoice: %', c1;
  raise notice 'invoice_installments.stripe_invoice: %', c2;
  raise notice 'indice unico invoices_stripe_invoice_uk: %', i1;
  if c1 = 0 or c2 = 0 or i1 = 0 then
    raise exception 'Migracao incompleta -- confira os avisos acima';
  end if;
end $$;
