-- ============================================================
-- CONFERÊNCIA PÓS-MIGRAÇÃO — consulta ÚNICA
--
-- O editor do Supabase exibe apenas o resultado do último
-- comando. Por isso aqui é tudo uma consulta só.
-- Só leitura: não altera nada.
-- ============================================================

with col as (
  select column_name as c
    from information_schema.columns
   where table_schema = 'public' and table_name = 'clients'
     and column_name in ('phone','telefone','phone_number','celular','mobile','whatsapp')
   order by array_position(
     array['phone','telefone','phone_number','celular','mobile','whatsapp'], column_name)
   limit 1
),
fones as (
  select c.id, to_jsonb(c) ->> (select col.c from col) as fone
    from clients c
),
validos as (
  select id, fone,
         '+1' || right(regexp_replace(fone, '[^0-9]', '', 'g'), 10) as e164
    from fones
   where length(regexp_replace(coalesce(fone, ''), '[^0-9]', '', 'g')) >= 10
)
select bloco, detalhe, resultado from (

  -- 1. Qual coluna de clients a função está usando
  select 1 as ord, '1. coluna de telefone' as bloco,
         coalesce((select c from col), 'NENHUMA ENCONTRADA') as detalhe,
         '' as resultado

  -- 2. Prova: partindo do número como o WhatsApp entrega,
  --    a função volta para o mesmo cliente?
  union all
  select 2, '2. prova de casamento',
         v.fone || '   ->   ' || v.e164,
         case when wa_client_por_telefone(v.e164) = v.id
              then 'CASOU' else 'NAO CASOU' end
    from (select * from validos limit 8) v

  -- 3. Cobertura do cadastro
  union all
  select 3, '3. cobertura', 'clientes no total',
         (select count(*)::text from fones)
  union all
  select 3, '3. cobertura', 'com telefone utilizavel',
         (select count(*)::text from validos)
  union all
  select 3, '3. cobertura', 'SEM telefone (chegam como nao cadastrado)',
         (select (count(*) - (select count(*) from validos))::text from fones)
  union all
  select 3, '3. cobertura', 'telefones repetidos entre clientes',
         (select coalesce(sum(q - 1), 0)::text from (
            select count(*) as q from validos group by e164 having count(*) > 1) d)

  -- 4. Índices
  union all
  select 4, '4. indices', indexname,
         case indexname
           when 'idx_wa_fone'       then 'ANTIGO — deveria ter saido'
           when 'idx_wa_fone_canal' then 'CORRETO — telefone + canal'
           else 'ok' end
    from pg_indexes where tablename = 'wa_conversations'

  -- 5. RLS
  union all
  select 5, '5. RLS ligada', relname,
         case when relrowsecurity then 'sim' else 'NAO — problema' end
    from pg_class
   where relname in ('wa_conversations','wa_messages','wa_templates')

  -- 6. Bucket dos anexos
  union all
  select 6, '6. bucket de anexos', id,
         case when public then 'PUBLICO — problema' else 'privado — ok' end
    from storage.buckets where id = 'whatsapp-media'

) t order by ord, detalhe;
