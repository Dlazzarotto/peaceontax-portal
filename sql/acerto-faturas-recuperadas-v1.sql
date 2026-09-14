-- Acerto das duas faturas de setembro recuperadas por reenvio de evento
--
-- INV-2026-0011 e INV-2026-0012 nasceram do reenvio manual dos eventos
-- invoice.paid de 05/09, feito em 14/09. Dois campos saíram da data do
-- PROCESSAMENTO em vez da data do fato, e um recebimento ficou sem
-- referência porque a busca da invoice no Stripe falhava (expand com cinco
-- níveis; o Stripe aceita quatro). O código já foi corrigido -- isto aqui é
-- só o acerto do que já estava gravado.
--
--   issue_date  14/09 -> 05/09 (quando o Stripe finalizou a cobrança)
--   reference   nulo  -> o PaymentIntent de cada cobrança
--
-- Competência, valor, situação e o método (card, confirmado pela tarifa de
-- 2,9% + $0,30 no extrato) já estão certos e não são tocados.
--
-- Idempotente. Rodar no SQL Editor do Supabase.

update public.invoices
   set issue_date = date '2026-09-05', updated_at = now()
 where number in ('INV-2026-0011', 'INV-2026-0012')
   and issue_date <> date '2026-09-05';

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  fora integer;
  r record;
begin
  select count(*) into fora from public.invoices
   where number in ('INV-2026-0011', 'INV-2026-0012')
     and (issue_date <> date '2026-09-05' or competencia <> date '2026-09-01' or status <> 'paid');

  for r in select number, issue_date, due_date, competencia, status, total, paid_total
             from public.invoices where number in ('INV-2026-0011','INV-2026-0012') order by number
  loop
    raise notice '% | emissao % | venc % | competencia % | % | % de %',
      r.number, r.issue_date, r.due_date, r.competencia, r.status, r.paid_total, r.total;
  end loop;

  if fora > 0 then
    raise exception 'Alguma fatura ainda esta fora do esperado -- confira os avisos acima';
  end if;
end $$;
