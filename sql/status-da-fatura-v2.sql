-- sql/status-da-fatura-v2.sql
-- O status da fatura passa a ser calculado por UMA funcao, e vencida com
-- pagamento parcial volta a contar como vencida.
--
-- DOIS DEFEITOS CORRIGIDOS
--
-- 1. VENCIDA COM ENTRADA SUMIA DA LISTA DE VENCIDAS.
--    A ordem do CASE punha `partial` antes de `overdue`: quem pagou $10 de
--    $1.000 e estava tres meses atrasado aparecia como "parcial", nunca como
--    "vencida". E exatamente o cliente que deu entrada e parou de pagar —
--    inadimplencia saindo do radar. Agora vencimento vence: `overdue` e
--    conferido antes de `partial`, e quanto entrou continua legivel em
--    `paid_total`. Quem lia status lia sempre os tres juntos
--    (`sent`/`partial`/`overdue`) como "em aberto", entao nenhuma tela muda
--    de comportamento; o relatorio de aging ja calculava pelo due_date.
--
-- 2. O VENCIMENTO VIRAVA AS 20H DE MALDEN.
--    `current_date` e a data do SERVIDOR, em UTC. A fatura passava a vencida
--    quando ainda era o dia anterior no escritorio. Agora a data e a do fuso
--    da firma, como lib/dia-da-firma.ts faz no lado do codigo.
--
-- UMA DEFINICAO SO
--    O calculo vivia no gatilho E em lib/estorno-stripe.ts, que escrevia
--    'partial'/'sent' na mao depois de desfazer um recebimento — sem olhar o
--    vencimento, ou seja, com o mesmo defeito 1. Agora existe
--    `recalcular_status_da_fatura(uuid)`: o gatilho chama, e o estorno chama
--    por RPC. Dois lugares calculando status divergem, e divergiram.
--
-- Idempotente. Nao altera dados por si: recalcula quando um pagamento muda.
-- Para acertar o historico de uma vez, o bloco final faz isso.

-- ── O fuso da firma, num lugar so ────────────────────────────────────────
create or replace function public.data_da_firma()
returns date
language sql
stable
as $$
  select (now() at time zone 'America/New_York')::date
$$;

-- ── A definicao do status ────────────────────────────────────────────────
create or replace function public.recalcular_status_da_fatura(fid uuid)
returns void
language plpgsql
as $function$
declare
  soma numeric(12,2);
begin
  select coalesce(sum(amount), 0) into soma
    from invoice_payments where invoice_id = fid;

  update invoices set
    paid_total = soma,
    status = case
      -- Cancelada nao muda por pagamento nenhum
      when status = 'void' then 'void'
      -- Quitada e quitada
      when soma >= total and total > 0 then 'paid'
      -- VENCIMENTO VENCE: entrada nao esconde atraso
      when due_date is not null and due_date < public.data_da_firma() then 'overdue'
      -- Em aberto e dentro do prazo, com algo recebido
      when soma > 0 then 'partial'
      -- Saiu de paid/partial/overdue e nao ha o que marcar: volta a enviada
      when status in ('paid', 'partial', 'overdue') then 'sent'
      else status
    end,
    updated_at = now()
  where id = fid;
end $function$;

-- ── O gatilho passa a so chamar a funcao ─────────────────────────────────
create or replace function public.atualiza_saldo_da_fatura()
returns trigger
language plpgsql
as $function$
begin
  perform public.recalcular_status_da_fatura(coalesce(new.invoice_id, old.invoice_id));
  return null;
end $function$;

-- ── Acerta o historico ───────────────────────────────────────────────────
-- Faturas que hoje estao como `partial` mas ja venceram: passam a `overdue`.
-- Nada de dinheiro se move; e so a leitura ficando honesta.
do $$
declare
  corrigidas integer;
begin
  with alvo as (
    select id from invoices
     where status = 'partial'
       and due_date is not null
       and due_date < public.data_da_firma()
  ), feito as (
    update invoices set status = 'overdue', updated_at = now()
     where id in (select id from alvo) returning 1
  )
  select count(*) into corrigidas from feito;
  raise notice 'faturas vencidas que estavam como parcial: %', corrigidas;
end $$;

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  f1 integer; f2 integer; f3 integer; restou integer;
begin
  select count(*) into f1 from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'data_da_firma';
  select count(*) into f2 from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'recalcular_status_da_fatura';
  select count(*) into f3 from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'atualiza_saldo_da_fatura';
  select count(*) into restou from invoices
   where status = 'partial' and due_date is not null and due_date < public.data_da_firma();

  raise notice 'data_da_firma: % | recalcular_status_da_fatura: % | atualiza_saldo_da_fatura: %', f1, f2, f3;
  raise notice 'vencidas ainda marcadas como parcial (esperado 0): %', restou;
  if f1 <> 1 or f2 <> 1 or f3 <> 1 then
    raise exception 'Alguma funcao nao ficou criada';
  end if;
  if restou <> 0 then
    raise exception 'Sobraram % faturas vencidas como parcial', restou;
  end if;
end $$;
