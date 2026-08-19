-- ============================================================
-- CONFERÊNCIA PÓS-MIGRAÇÃO — só leitura, não altera nada
--
-- O editor do Supabase não mostra NOTICE, então aqui tudo vem
-- como resultado de consulta.
-- ============================================================

-- ── 1. Qual coluna de clients a função está usando ──────────
select
  (select column_name
     from information_schema.columns
    where table_schema = 'public' and table_name = 'clients'
      and column_name in ('phone','telefone','phone_number','celular','mobile','whatsapp')
    order by array_position(
      array['phone','telefone','phone_number','celular','mobile','whatsapp'], column_name)
    limit 1) as coluna_de_telefone_encontrada;

-- ── 2. PROVA: a função acha os seus clientes de verdade? ────
-- Pega 8 clientes com telefone e pergunta: partindo do número
-- como o WhatsApp entrega (+1...), a função volta para o mesmo
-- cliente? Todas as linhas devem vir com casou = true.
with col as (
  select column_name as c
    from information_schema.columns
   where table_schema = 'public' and table_name = 'clients'
     and column_name in ('phone','telefone','phone_number','celular','mobile','whatsapp')
   order by array_position(
     array['phone','telefone','phone_number','celular','mobile','whatsapp'], column_name)
   limit 1
),
amostra as (
  select c.id,
         to_jsonb(c) ->> (select col.c from col) as fone_cadastro
    from clients c
   where length(regexp_replace(coalesce(to_jsonb(c) ->> (select col.c from col), ''), '[^0-9]', '', 'g')) >= 10
   limit 8
)
select
  a.fone_cadastro                                                   as no_cadastro,
  '+1' || right(regexp_replace(a.fone_cadastro, '[^0-9]', '', 'g'), 10) as como_chega_do_whatsapp,
  wa_client_por_telefone('+1' || right(regexp_replace(a.fone_cadastro, '[^0-9]', '', 'g'), 10)) = a.id as casou
from amostra a;

-- ── 3. Quantos clientes ficariam SEM casamento ──────────────
-- Telefone em branco ou com menos de 10 dígitos: a conversa
-- chega como "não cadastrado" e a equipe vincula na mão.
with col as (
  select column_name as c
    from information_schema.columns
   where table_schema = 'public' and table_name = 'clients'
     and column_name in ('phone','telefone','phone_number','celular','mobile','whatsapp')
   order by array_position(
     array['phone','telefone','phone_number','celular','mobile','whatsapp'], column_name)
   limit 1
)
select
  count(*) as total_clientes,
  count(*) filter (
    where length(regexp_replace(coalesce(to_jsonb(c) ->> (select col.c from col), ''), '[^0-9]', '', 'g')) >= 10
  ) as com_telefone_utilizavel,
  count(*) filter (
    where length(regexp_replace(coalesce(to_jsonb(c) ->> (select col.c from col), ''), '[^0-9]', '', 'g')) < 10
  ) as sem_telefone_utilizavel
from clients c;

-- ── 4. Índices: o antigo saiu, o novo entrou? ───────────────
select indexname,
       case indexname
         when 'idx_wa_fone'       then 'ANTIGO — nao deveria existir mais'
         when 'idx_wa_fone_canal' then 'CORRETO — telefone + canal'
         else 'ok'
       end as leitura
  from pg_indexes
 where tablename = 'wa_conversations'
 order by indexname;

-- ── 5. RLS ligada nas três tabelas ──────────────────────────
select relname as tabela, relrowsecurity as rls_ligada
  from pg_class
 where relname in ('wa_conversations','wa_messages','wa_templates')
 order by relname;

-- ── 6. Bucket dos anexos ────────────────────────────────────
select id, public as publico_deve_ser_false
  from storage.buckets where id = 'whatsapp-media';
