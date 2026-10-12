-- sql/rls-tabelas-expostas-v2.sql
-- Fechar as tabelas de dado do cliente para o navegador e tirar as policies
-- que o PROPRIO cliente consegue forjar.
--
-- O QUE A CONSULTA DE DIAGNOSTICO ACHOU EM PRODUCAO
-- 1) client_invitations tinha a policy `public_read_invite_by_token` com
--    `using (true)`: QUALQUER pessoa com a anon key (que esta no bundle do
--    navegador de todo mundo que abre o portal) lia a tabela inteira de
--    convites -- nome, e-mail e o TOKEN, que e o que cria a conta. Nao
--    precisava nem estar logado. Havia 6 tokens ainda validos.
-- 2) clients, transactions, documents, classification_rules,
--    client_invitations e invitation_logs tinham policy `firm_*` que decide
--    pelo papel lido de `user_metadata` no JWT
--    (`(auth.jwt() ->> 'user_metadata')::jsonb ->> 'role' = 'firm'`).
--    `user_metadata` e do PROPRIO dono do login: com a sessao dele e a anon
--    key, `auth.updateUser({ data: { role: 'firm' } })` reescreve esse campo.
--    O app ja nao decide por ai (o papel mora em app_metadata desde
--    sql/papel-no-app-metadata-v1.sql) -- mas a RLS do PostgREST decidia, e
--    essa e uma porta separada do app. Um cliente do portal forjava o campo
--    e lia/alterava o cadastro, as transacoes e os documentos de QUALQUER
--    cliente, direto pelo PostgREST. Reproduzido em Postgres 16.
-- 3) messages e staff_invitations tinham policy `firm_*` lendo
--    `auth.users` por subconsulta. No Postgres 16 isso da `permission denied
--    for table users` para quem nao e dono (anon/authenticated nao tem grant
--    em auth.users no Supabase), entao NAO escala -- mas e policy morta e
--    confunde. staff_invitations ainda por cima nao esta em NENHUM arquivo
--    .sql: nasceu no painel, e convite de equipe carrega token de acesso de
--    STAFF. "Schema que so existe no banco vira folclore."
--
-- POR QUE FECHAR E SEGURO
-- Nenhum componente do navegador nem a sessao do cliente le essas tabelas
-- direto: as 94 rotas de /api e as rotas do /portal usam a service role key,
-- que passa POR CIMA da RLS. O convite, inclusive, le por /api/invite/[token]
-- com a service role -- a policy `using (true)` nao servia a nada. Logo estas
-- policies nao sustentam nenhum caminho do app; sao so superficie de ataque.
--
-- O QUE ESTA MIGRACAO FAZ
-- O padrao da casa (sql/rls-tabelas-expostas-v1.sql, sql/whatsapp-*): quem
-- trabalha nestas tabelas e o servidor com a service role. Entao:
--   a) liga a RLS e `revoke all ... from anon, authenticated` em cada tabela
--      -- sem privilegio de tabela o PostgREST ja recusa, qualquer que seja a
--      policy. Esta e a trava primaria.
--   b) DERRUBA as policies perigosas pelo nome (as `firm_*` e a
--      `public_read_invite_by_token`). Com (a) elas ja ficam inalcancaveis,
--      mas uma linha de `revoke` desfeita por engano no painel reabriria o
--      buraco na hora se a policy continuasse la -- e justamente o cenario
--      que a consulta do fim da v1 alerta. Derrubar e o cinto alem do
--      suspensorio.
-- As policies `client_own_*` ficam: nao sao vazamento (comparam
-- `user_id = auth.uid()`) e nao custam nada.
--
-- storage.objects FICA DE FORA de proposito: esta no schema `storage`, que
-- tem modelo de grant proprio, e `revoke` ali pode quebrar o acesso a
-- arquivo. A policy de storage usa a forma por subconsulta (nao escala). Fica
-- anotada para decisao separada.
--
-- Idempotente. Roda de novo sem efeito.

-- a) Tranca de tabela: RLS + sem privilegio para o navegador ----------------
do $$
declare
  t text;
  tabelas text[] := array[
    'clients', 'transactions', 'documents', 'classification_rules',
    'client_invitations', 'invitation_logs', 'messages', 'staff_invitations'
  ];
begin
  foreach t in array tabelas loop
    -- staff_invitations (e outras) podem nao existir neste projeto: condicional.
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

-- b) Derrubar as policies perigosas pelo nome -------------------------------
--    So as `firm_*` (decidem por papel que o cliente forja ou por subconsulta
--    morta) e a `public_read_invite_by_token` (`using (true)`). As
--    `client_own_*` NAO entram aqui.
do $$
declare
  r record;
  alvos text[] := array[
    -- client_invitations / invitation_logs
    'client_invitations|public_read_invite_by_token',
    'client_invitations|firm_manage_invitations',
    'invitation_logs|firm_manage_inv_logs',
    -- forma JWT/user_metadata (forjavel)
    'clients|firm_full_access_clients',
    'documents|firm_full_access_documents',
    'transactions|firm_full_access_transactions',
    'classification_rules|firm_full_access_rules',
    -- forma por subconsulta em auth.users (morta, mas folclore)
    'clients|firm_all_clients',
    'documents|firm_all_documents',
    'messages|firm_all_messages',
    'staff_invitations|firm_all_staff_invitations'
  ];
  par text;
  tab text;
  pol text;
begin
  foreach par in array alvos loop
    tab := split_part(par, '|', 1);
    pol := split_part(par, '|', 2);
    if to_regclass('public.' || tab) is not null then
      -- drop policy nao aceita "if exists" por nome de forma portavel entre
      -- versoes antigas? aceita desde o 9.5. Mas confirmamos a existencia da
      -- tabela acima; a policy ausente e no-op com if exists.
      execute format('drop policy if exists %I on public.%I', pol, tab);
    end if;
  end loop;
end $$;

-- == Conferencia ===========================================================
-- Para cada tabela que existe: RLS ligada, zero privilegio anon/authenticated,
-- nenhuma policy sobrando que leia user_metadata/auth.jwt->role ou seja `true`.
do $$
declare
  t text;
  tabelas text[] := array[
    'clients', 'transactions', 'documents', 'classification_rules',
    'client_invitations', 'invitation_logs', 'messages', 'staff_invitations'
  ];
  rls boolean;
  grants integer;
  forjaveis integer;
  checadas integer := 0;
begin
  foreach t in array tabelas loop
    if to_regclass('public.' || t) is null then
      raise notice 'tabela ausente neste projeto (ok): %', t;
      continue;
    end if;
    checadas := checadas + 1;

    select c.relrowsecurity into rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = t;

    select count(*) into grants
      from information_schema.role_table_grants
     where table_schema = 'public' and table_name = t
       and grantee in ('anon', 'authenticated');

    -- Policy que ainda decide por papel forjavel (user_metadata / auth.jwt)
    -- ou que libera geral (`true`). client_own_* usa auth.uid() = user_id:
    -- nao casa aqui.
    select count(*) into forjaveis
      from pg_policies
     where schemaname = 'public' and tablename = t
       and (coalesce(qual, '')       ilike '%user_metadata%'
         or coalesce(with_check, '') ilike '%user_metadata%'
         or coalesce(qual, '')       = 'true');

    raise notice '% -> RLS:% | grants anon/auth:% | policies forjaveis:%',
      t, rls, grants, forjaveis;

    if rls is not true or grants <> 0 or forjaveis <> 0 then
      raise exception 'Tabela % nao ficou fechada -- confira os avisos acima', t;
    end if;
  end loop;

  if checadas = 0 then
    raise exception 'Nenhuma das tabelas-alvo existe -- migracao aplicada no projeto errado?';
  end if;
  raise notice 'OK: % tabelas fechadas', checadas;
end $$;

-- == O que AINDA responde ao navegador ====================================
-- Nao muda nada: lista tabela em public sem RLS (alcancavel pelo PostgREST
-- com a anon key). O storage.objects fica de fora desta migracao de proposito
-- (ver cabecalho) -- se aparecer aqui, e decisao separada.
select c.relname as tabela_sem_rls,
       coalesce(string_agg(distinct g.grantee, ', '), 'sem privilegio direto') as quem_alcanca
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join information_schema.role_table_grants g
         on g.table_schema = 'public' and g.table_name = c.relname
        and g.grantee in ('anon', 'authenticated')
 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
 group by c.relname
 order by c.relname;
