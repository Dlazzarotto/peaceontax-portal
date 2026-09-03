-- ============================================================
--  SMS: consentimento pelo portal + webhook STOP/START — v1
--  Rodar no SQL Editor do Supabase. Idempotente: pode rodar de novo.
--
--  Complementa as tabelas que já existem (sms_messages, sms_consent_log,
--  sms_sent_marker e as colunas sms_* em clients), usadas por lib/sms.ts.
-- ============================================================

-- ── 1. Mensagem recebida de número desconhecido também fica registrada ──
-- O webhook grava toda mensagem que chega, mesmo sem cliente casado.
alter table sms_messages alter column client_id drop not null;

-- ── 2. Deduplicação: a Twilio reenvia quando não recebe 200 ──
create unique index if not exists sms_messages_twilio_sid_uidx
  on sms_messages (twilio_sid) where twilio_sid is not null;
create index if not exists sms_messages_phone_idx on sms_messages (phone);
create index if not exists sms_consent_log_client_idx on sms_consent_log (client_id, created_at desc);

-- ── 3. Cliente pelo telefone que mandou o SMS ──
-- Primeiro o celular de SMS (gravado em E.164 por lib/sms.ts), depois o
-- telefone do cadastro, comparando os 10 últimos dígitos (DDD + número).
create or replace function sms_client_por_telefone(p text) returns uuid
language sql stable as $fn$
  with alvo as (
    select right(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), 10) as d
  ),
  candidatos as (
    select c.id, 1 as prioridade
      from clients c, alvo
     where length(regexp_replace(coalesce(c.sms_phone, ''), '[^0-9]', '', 'g')) >= 10
       and right(regexp_replace(coalesce(c.sms_phone, ''), '[^0-9]', '', 'g'), 10) = alvo.d
    union all
    select c.id, 2 as prioridade
      from clients c, alvo
     where length(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')) >= 10
       and right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = alvo.d
  )
  select id from candidatos
   where length((select d from alvo)) = 10
   order by prioridade
   limit 1
$fn$;

-- ── Conferência: tudo tem de vir com contagem ≥ 1 ──
select 'funcao sms_client_por_telefone' as item, count(*) from pg_proc where proname = 'sms_client_por_telefone'
union all
select 'indice sms_messages_twilio_sid_uidx', count(*) from pg_indexes where indexname = 'sms_messages_twilio_sid_uidx'
union all
select 'sms_messages.client_id aceita nulo', count(*) from information_schema.columns
 where table_name = 'sms_messages' and column_name = 'client_id' and is_nullable = 'YES'
union all
select 'clients.sms_phone existe', count(*) from information_schema.columns
 where table_name = 'clients' and column_name = 'sms_phone';
