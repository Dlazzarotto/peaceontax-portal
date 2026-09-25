-- sql/recebimento-seguro-v1.sql
-- Duas travas de dinheiro que estavam no CODIGO e por isso nao valiam sob
-- concorrencia. Ambas viram regra do BANCO.
--
-- RODE DEPOIS de sql/status-da-fatura-v2.sql (usa recalcular_status_da_fatura).
--
-- 1) ESTORNO ATOMICO, E SEM PERDER O RASTRO
--    O estorno manual (/api/billing/payments) gravava payment_reversals com
--    `.then(() => null, () => null)` -- erro descartado -- e DEPOIS apagava o
--    recebimento. Se o rastro falhasse, o dinheiro sumia sem registro, que e
--    o oposto do principio 2 e o oposto do que o irmao dele
--    (lib/estorno-stripe.ts) ja fazia certo: la o rastro e conferido e o
--    recebimento e PRESERVADO quando ele falha.
--    Alem disso era conferir-e-apagar em dois passos: dois estornos
--    simultaneos do mesmo recebimento gravavam DOIS rastros.
--    Aqui os dois passos viram um: o DELETE ... RETURNING trava a linha (o
--    segundo pedido nao acha nada e recebe 'ja_estornado'), e se o INSERT do
--    rastro falhar a transacao inteira volta atras -- o recebimento fica.
--
-- 2) RECEBIMENTO ACIMA DO SALDO
--    A rota confere `valor > saldo` antes de gravar. Conferir antes e gravar
--    depois deixa a janela aberta: o Zelle digitado no balcao e o webhook do
--    Stripe chegando juntos leem o mesmo saldo e os dois passam. A fatura
--    fica com paid_total maior que o total, e ninguem percebe.
--    O gatilho passa a recusar. So em INSERT/UPDATE: em DELETE, nao --
--    senao uma fatura que JA esteja com sobra nao poderia nem ser estornada.
--
-- Idempotente. Nao cria tabela e nao atribui variavel por consulta fora de
-- funcao (ver CLAUDE.md sobre o SQL Editor do Supabase).

do $$
begin
  if to_regprocedure('public.recalcular_status_da_fatura(uuid)') is null then
    raise exception 'Rode sql/status-da-fatura-v2.sql antes desta migracao';
  end if;
end $$;

-- ── 1. Estorno atomico ───────────────────────────────────────────────────
create or replace function public.estornar_recebimento(
  p_payment_id   uuid,
  p_reason       text,
  p_performed_by uuid,
  p_staff_level  text
)
returns table (ok boolean, motivo text, valor numeric, fatura uuid)
language plpgsql
as $function$
declare
  pg record;
begin
  -- Um passo so: apaga E devolve o que apagou. O segundo pedido simultaneo
  -- espera a trava, nao encontra linha e sai com 'ja_estornado'.
  delete from public.invoice_payments where id = p_payment_id returning * into pg;

  if pg.id is null then
    return query select false, 'ja_estornado'::text, null::numeric, null::uuid;
    return;
  end if;

  -- Se este insert falhar, a excecao desfaz o delete acima: o recebimento
  -- FICA. "Nada se apaga sem rastro" deixa de depender de quem escreveu a rota.
  insert into public.payment_reversals
    (invoice_id, amount, method, reference, stripe_object, reason, performed_by, staff_level)
  values
    (pg.invoice_id, pg.amount, pg.method, pg.reference, pg.stripe_object,
     coalesce(nullif(btrim(p_reason), ''), 'estorno'), p_performed_by, p_staff_level);

  return query select true, 'ok'::text, pg.amount, pg.invoice_id;
end $function$;

-- ── 2. Recebimento acima do saldo ────────────────────────────────────────
create or replace function public.atualiza_saldo_da_fatura()
returns trigger
language plpgsql
as $function$
declare
  fid uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  perform public.recalcular_status_da_fatura(fid);

  -- So quando ENTRA dinheiro. Em DELETE (estorno) nunca: uma fatura que ja
  -- esteja com sobra tem de poder ser corrigida.
  if tg_op <> 'DELETE' then
    if (select paid_total - total from public.invoices where id = fid) > 0.005 then
      raise exception
        'Recebimento acima do saldo desta fatura. Outro lancamento entrou ao mesmo tempo -- confira os recebimentos antes de repetir.'
        using errcode = 'check_violation';
    end if;
  end if;

  return null;
end $function$;

-- == Conferencia ===========================================================
do $$
begin
  if to_regprocedure('public.estornar_recebimento(uuid,text,uuid,text)') is null then
    raise exception 'estornar_recebimento nao ficou criada';
  end if;
  if to_regprocedure('public.atualiza_saldo_da_fatura()') is null then
    raise exception 'atualiza_saldo_da_fatura nao ficou criada';
  end if;
  if (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where p.proname = 'atualiza_saldo_da_fatura' and not t.tgisinternal) = 0 then
    raise exception 'Nenhum gatilho usa atualiza_saldo_da_fatura -- o saldo nao seria recalculado';
  end if;
  raise notice 'estorno atomico e trava de recebimento acima do saldo: instalados';
end $$;

-- Faturas que JA estao com recebimento acima do total (se houver, sao de
-- antes desta trava e precisam de decisao humana).
select i.number, i.total, i.paid_total, round(i.paid_total - i.total, 2) as sobra
  from public.invoices i
 where i.paid_total - i.total > 0.005
 order by (i.paid_total - i.total) desc;
