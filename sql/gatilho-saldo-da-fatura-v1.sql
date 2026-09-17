-- sql/gatilho-saldo-da-fatura-v1.sql
-- O gatilho que mantem paid_total e status da fatura.
--
-- POR QUE ESTE ARQUIVO EXISTE
-- Este gatilho estava SO no banco, aplicado a mao antes da disciplina da
-- pasta sql/. Consequencia real: um comentario errado em
-- app/api/billing/payments/route.ts dizia "o banco recusa valor parcial" e
-- ninguem tinha como conferir. A afirmacao era falsa — o gatilho nao valida
-- nada, so recalcula — e com base nela se concluiu que uma entrada de $250
-- numa fatura de $1.000 seria recusada. Schema invisivel vira folclore.
--
-- O CORPO ABAIXO E EXATAMENTE O QUE JA ESTA EM PRODUCAO. Rodar isto nao muda
-- comportamento nenhum: e `create or replace` do mesmo codigo, para que a
-- regra passe a existir no repositorio.
--
-- O QUE ELE FAZ
--   paid_total = soma de invoice_payments da fatura (recalculado, nunca
--                incrementado — evento fora de ordem nao acumula errado)
--   status     = void continua void
--                soma >= total          -> paid
--                soma > 0               -> partial
--                vencida e sem pagamento-> overdue
--                saiu de paid/partial   -> sent
--
-- ELE NAO IMPEDE PAGAMENTO PARCIAL, em nenhuma forma de pagamento. Entrada
-- de $250 em $1.000 entra e a fatura fica `partial` com saldo de $750.
--
-- DUAS COISAS A DECIDIR (nao mexidas aqui, para nao mudar semantica de
-- status que listas, relatorios e cobranca leem):
--   1. Fatura vencida COM pagamento parcial aparece como `partial`, nunca
--      como `overdue` — a ordem do CASE poe `partial` antes. Um cliente que
--      pagou $10 de $1.000 e esta tres meses atrasado nao entra na lista de
--      vencidas.
--   2. `current_date` e a data do SERVIDOR (UTC). O vencimento vira
--      `overdue` as 20h de Malden, nao a meia-noite. Mesma classe do
--      problema que lib/dia-da-firma.ts resolveu no lado do codigo.
--
-- Idempotente.

create or replace function public.atualiza_saldo_da_fatura()
returns trigger
language plpgsql
as $function$
declare
  fid uuid := coalesce(new.invoice_id, old.invoice_id);
  soma numeric(12,2);
  f record;
begin
  select coalesce(sum(amount), 0) into soma from invoice_payments where invoice_id = fid;
  select total, due_date, status into f from invoices where id = fid;

  update invoices set
    paid_total = soma,
    status = case
      when status = 'void' then 'void'
      when soma >= total and total > 0 then 'paid'
      when soma > 0 then 'partial'
      when due_date is not null and due_date < current_date then 'overdue'
      when status in ('paid','partial') then 'sent'
      else status
    end,
    updated_at = now()
  where id = fid;

  return null;
end $function$;

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  fn integer; tg integer;
begin
  select count(*) into fn from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'atualiza_saldo_da_fatura';
  -- O gatilho em si (o CREATE TRIGGER) ja existe em producao e nao e
  -- recriado aqui: mexer nele exigiria saber os eventos exatos, e o que
  -- faltava era a FUNCAO estar versionada.
  select count(*) into tg from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
   where p.proname = 'atualiza_saldo_da_fatura' and not t.tgisinternal;
  raise notice 'funcao atualiza_saldo_da_fatura: %', fn;
  raise notice 'gatilhos que a usam: %', tg;
  if fn <> 1 then
    raise exception 'A funcao nao ficou criada';
  end if;
end $$;
