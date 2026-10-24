-- sql/equipe-unica-v1.sql
-- A EQUIPE NUM LUGAR SO: o nivel e o PIN de aprovacao passam de
-- staff_roles para team_members (decisao do socio: "juntar tudo como team
-- member e acrescentar as regras").
--
-- RODE ANTES DE O CODIGO SUBIR -- e faca o merge logo em seguida.
--
-- POR QUE
-- A firma tinha tres cadastros da mesma gente, cada um com a sua tela, e
-- eles discordavam:
--   team_members  o nome de responsavel no CRM (tela /team). Tinha uma
--                 coluna "role" que QUALQUER pessoa da equipe trocava --
--                 era rotulo, nao permissao, mas a tela dizia "Socio".
--   auth.users    o login e o papel da PORTA (app_metadata.role).
--   staff_roles   o NIVEL que decide o poder, trocado em Minha Conta sem
--                 senha, sem motivo e sem rastro.
-- A partir daqui a pessoa e UMA linha de team_members: nome, e-mail, login
-- (user_id), nivel (level) e PIN. O papel da porta continua em app_metadata
-- (lib/papeis.ts); o PODER e team_members.level.
--
-- O QUE FAZ, nesta ordem
--  1. Fecha team_members para o navegador (RLS + revoke). Ela passa a
--     guardar o NIVEL: aberta, um cliente logado gravaria "owner" na
--     propria linha com a anon key.
--  2. Acrescenta user_id (unico), level (owner | manager | junior) e
--     approval_pin_hash.
--  3. Cria a trilha team_member_audit (fechada, como toda tabela nova).
--  4. Liga cada login da FIRMA a uma linha da equipe: primeiro a linha do
--     CRM com o mesmo e-mail, depois a com o mesmo nome e sem e-mail, e so
--     entao insere. Sem isso o mesmo funcionario apareceria duas vezes -- o
--     CRM ja tinha o nome dele. O nivel vem de staff_roles; quem nao estava
--     la recebe o nivel que o papel do login ja lhe dava (era a reserva de
--     getStaffLevel). Ninguem ganha nem perde poder nesta migracao.
--  5. CONGELA staff_roles: tira da service role o direito de gravar. Ela
--     fica como rastro. Entre esta migracao e o deploy, o codigo antigo que
--     tentar mudar nivel ou PIN recebe ERRO -- e de proposito: sem isso a
--     mudanca iria para staff_roles e se perderia em silencio quando o
--     codigo novo passasse a ler team_members. Um rebaixamento desfeito
--     sozinho e o pior jeito de errar aqui.
--
-- DECIDE PELO ESTADO DE DESTINO. Linha que ja tem user_id nao e tocada:
-- depois do deploy o nivel muda em team_members, e rodar esta migracao de
-- novo nao pode trazer de volta o nivel velho de staff_roles. A segunda
-- rodada nao encontra nada para fazer (testado no PG 16).
--
-- Colunas de staff_roles sao lidas por to_jsonb(sr): a tabela nasceu no
-- painel e nao esta em nenhum .sql. Coluna que faltar vira nulo, em vez de
-- derrubar a migracao.
--
-- Idempotente. Cria tabela: liga a RLS aqui mesmo, nao atribui variavel
-- por consulta e nao define funcao -- as tres coisas que fazem o SQL
-- Editor do Supabase reescrever o arquivo.

-- == 0. As tabelas de partida ===============================================
-- No projeto da firma as duas ja existem (nasceram no painel). Num projeto
-- novo elas passam a existir aqui, vazias -- e fechadas, como toda tabela
-- criada em arquivo.
create table if not exists public.team_members (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  email      text,
  role       text,
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.staff_roles (
  user_id           uuid primary key,
  level             text,
  approval_pin_hash text,
  display_name      text,
  updated_at        timestamptz default now()
);

-- == 1. Fechadas para o navegador ==========================================
alter table public.team_members enable row level security;
revoke all on public.team_members from anon, authenticated;

alter table public.staff_roles enable row level security;
revoke all on public.staff_roles from anon, authenticated;

-- == 2. As colunas novas ===================================================
alter table public.team_members add column if not exists user_id uuid;
alter table public.team_members add column if not exists level text not null default 'junior';
alter table public.team_members add column if not exists approval_pin_hash text;

-- Indice SIMPLES, nao parcial: `on conflict (user_id)` nao infere indice
-- parcial (ja derrubou a conciliacao do caixa). Em UNIQUE cada NULL e
-- distinto, entao as linhas sem login continuam entrando.
create unique index if not exists team_members_user_id_key on public.team_members (user_id);

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'team_members_level_check'
                    and conrelid = 'public.team_members'::regclass) then
    alter table public.team_members
      add constraint team_members_level_check
      check (level in ('owner', 'manager', 'junior'));
  end if;

  -- Apagar o login nao apaga a pessoa da equipe: o nome dela continua nos
  -- clientes que atendeu. O vinculo e que deixa de existir.
  if not exists (select 1 from pg_constraint
                  where conname = 'team_members_user_id_fkey'
                    and conrelid = 'public.team_members'::regclass) then
    alter table public.team_members
      add constraint team_members_user_id_fkey
      foreign key (user_id) references auth.users (id) on delete set null;
  end if;
end $$;

comment on column public.team_members.level is
  'O NIVEL de acesso (owner | manager | junior). Fonte unica desde sql/equipe-unica-v1.sql. Muda so pela tela Equipe, com senha e motivo do socio, e a trilha fica em team_member_audit.';
comment on column public.team_members.role is
  'LEGADO: rotulo do CRM antigo, que qualquer pessoa da equipe trocava. Ninguem le. O nivel e a coluna level.';

-- == 3. A trilha ===========================================================
create table if not exists public.team_member_audit (
  id             uuid primary key default gen_random_uuid(),
  member_id      text,                          -- team_members.id (texto: o tipo nasceu no painel)
  user_id        uuid,                          -- o login da pessoa, quando ha
  action         text not null
                 check (action in ('migrado', 'criado', 'vinculado', 'editado',
                                   'nivel', 'pin_zerado', 'desativado', 'reativado')),
  performed_by   uuid,                          -- auth.users.id de quem fez (nulo: a migracao)
  reason         text,                          -- o motivo digitado
  previous_state jsonb,                         -- como estava
  new_state      jsonb,                         -- como ficou
  created_at     timestamptz not null default now()
);

alter table public.team_member_audit enable row level security;
revoke all on public.team_member_audit from anon, authenticated;

create index if not exists team_member_audit_por_membro
  on public.team_member_audit (member_id, created_at desc);

comment on table public.team_member_audit is
  'Trilha da equipe: nivel, PIN, entrada, saida. A mudanca de nivel e gravada ANTES da alteracao -- se falhar, a rota recusa.';

-- == 4. Cada login da firma vira (ou encontra) a sua linha =================
-- "pessoas" e a mesma consulta nos tres passos: os logins cuja PORTA e da
-- firma (a lista fechada de lib/papeis.ts), com o nivel de staff_roles ou,
-- na falta, o que o papel ja dava (nivelDoPapel).
--
-- A chave do nome e a de chaveDoNome (lib/import-clientes.ts): minusculas,
-- sem acento, sem . , ' " e com espacos simples.

-- 4a. A linha do CRM com o MESMO E-MAIL
with pessoas as (
  select u.id as user_id,
         lower(trim(u.email)) as email,
         case when to_jsonb(sr)->>'level' in ('owner', 'manager', 'junior') then to_jsonb(sr)->>'level'
              when sr.user_id is not null then 'junior'
              else case lower(trim(u.raw_app_meta_data->>'role'))
                     when 'firm' then 'owner' when 'owner' then 'owner' when 'admin' then 'owner'
                     when 'manager' then 'manager' else 'junior' end
         end as nivel,
         to_jsonb(sr)->>'approval_pin_hash' as pin,
         coalesce(u.banned_until > now(), false) as banido
    from auth.users u
    left join public.staff_roles sr on sr.user_id = u.id
   where lower(trim(u.raw_app_meta_data->>'role')) in ('firm', 'owner', 'admin', 'manager', 'staff')
),
livres as (
  select distinct on (lower(trim(tm.email))) tm.id, lower(trim(tm.email)) as email
    from public.team_members tm
   where tm.user_id is null and nullif(trim(tm.email), '') is not null
   order by lower(trim(tm.email)), coalesce(tm.active, false) desc, tm.id
)
update public.team_members tm
   set user_id = p.user_id, email = p.email, level = p.nivel,
       approval_pin_hash = p.pin, active = not p.banido, updated_at = now()
  from pessoas p
  join livres l on l.email = p.email
 where tm.id = l.id
   and not exists (select 1 from public.team_members j where j.user_id = p.user_id);

-- 4b. A linha do CRM com o MESMO NOME e sem e-mail. So quando um unico
--     login tem aquele nome: dois logins "Maria" e uma linha "Maria" nao
--     dizem qual das duas e a do CRM -- inserir e mais honesto que adivinhar.
with pessoas as (
  select u.id as user_id,
         lower(trim(u.email)) as email,
         coalesce(nullif(trim(to_jsonb(sr)->>'display_name'), ''),
                  nullif(trim(u.raw_user_meta_data->>'full_name'), ''),
                  split_part(lower(trim(u.email)), '@', 1)) as nome,
         case when to_jsonb(sr)->>'level' in ('owner', 'manager', 'junior') then to_jsonb(sr)->>'level'
              when sr.user_id is not null then 'junior'
              else case lower(trim(u.raw_app_meta_data->>'role'))
                     when 'firm' then 'owner' when 'owner' then 'owner' when 'admin' then 'owner'
                     when 'manager' then 'manager' else 'junior' end
         end as nivel,
         to_jsonb(sr)->>'approval_pin_hash' as pin,
         coalesce(u.banned_until > now(), false) as banido
    from auth.users u
    left join public.staff_roles sr on sr.user_id = u.id
   where lower(trim(u.raw_app_meta_data->>'role')) in ('firm', 'owner', 'admin', 'manager', 'staff')
     and not exists (select 1 from public.team_members j where j.user_id = u.id)
),
chaves as (
  select p.*,
         lower(trim(regexp_replace(regexp_replace(
           translate(p.nome, 'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
                             'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn'),
           '[.,''"]', '', 'g'), '\s+', ' ', 'g'))) as chave,
         count(*) over (partition by lower(trim(regexp_replace(regexp_replace(
           translate(p.nome, 'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
                             'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn'),
           '[.,''"]', '', 'g'), '\s+', ' ', 'g')))) as homonimos
    from pessoas p
),
livres as (
  select distinct on (chave) id, chave
    from (select tm.id, tm.active,
                 lower(trim(regexp_replace(regexp_replace(
                   translate(tm.name, 'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
                                      'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn'),
                   '[.,''"]', '', 'g'), '\s+', ' ', 'g'))) as chave
            from public.team_members tm
           where tm.user_id is null and nullif(trim(tm.email), '') is null) x
   order by chave, coalesce(active, false) desc, id
)
update public.team_members tm
   set user_id = c.user_id, email = c.email, level = c.nivel,
       approval_pin_hash = c.pin, active = not c.banido, updated_at = now()
  from chaves c
  join livres l on l.chave = c.chave
 where tm.id = l.id
   and c.homonimos = 1;

-- 4c. Quem sobrou ganha linha nova. Nome que ja existe na equipe (ou que
--     dois logins dividem) leva o e-mail entre parenteses: o CRM guarda o
--     responsavel pelo NOME, e dois "Maria" lado a lado no seletor sao uma
--     escolha no escuro.
--     O insert vem PRIMEIRO e as consultas depois (insert ... with ... select):
--     com a consulta antes do `into`, o detector do SQL Editor le o comando
--     como `select ... into <tabela>` e reescreve o arquivo.
insert into public.team_members (name, email, role, user_id, level, approval_pin_hash, active, updated_at)
with pessoas as (
  select u.id as user_id,
         lower(trim(u.email)) as email,
         coalesce(nullif(trim(to_jsonb(sr)->>'display_name'), ''),
                  nullif(trim(u.raw_user_meta_data->>'full_name'), ''),
                  split_part(lower(trim(u.email)), '@', 1),
                  u.id::text) as nome,
         case when to_jsonb(sr)->>'level' in ('owner', 'manager', 'junior') then to_jsonb(sr)->>'level'
              when sr.user_id is not null then 'junior'
              else case lower(trim(u.raw_app_meta_data->>'role'))
                     when 'firm' then 'owner' when 'owner' then 'owner' when 'admin' then 'owner'
                     when 'manager' then 'manager' else 'junior' end
         end as nivel,
         to_jsonb(sr)->>'approval_pin_hash' as pin,
         coalesce(u.banned_until > now(), false) as banido
    from auth.users u
    left join public.staff_roles sr on sr.user_id = u.id
   where lower(trim(u.raw_app_meta_data->>'role')) in ('firm', 'owner', 'admin', 'manager', 'staff')
     and not exists (select 1 from public.team_members j where j.user_id = u.id)
),
chaves as (
  select p.*,
         lower(trim(regexp_replace(regexp_replace(
           translate(p.nome, 'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
                             'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn'),
           '[.,''"]', '', 'g'), '\s+', ' ', 'g'))) as chave
    from pessoas p
),
novas as (
  select c.*, count(*) over (partition by c.chave) as homonimos
    from chaves c
)
select case
         when n.homonimos > 1
           or exists (select 1 from public.team_members o
                       where lower(trim(regexp_replace(regexp_replace(
                               translate(o.name, 'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
                                                 'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn'),
                               '[.,''"]', '', 'g'), '\s+', ' ', 'g'))) = n.chave)
         then n.nome || ' (' || coalesce(n.email, n.user_id::text) || ')'
         else n.nome
       end,
       n.email, n.nivel, n.user_id, n.nivel, n.pin, not n.banido, now()
  from novas n;

-- 4d. O rastro da copia, uma linha por pessoa. So para quem ainda nao tem
--     NENHUMA linha na trilha: depois do deploy, quem entra pelo convite ja
--     ganha a sua ('criado' ou 'vinculado'), e uma segunda rodada nao pode
--     carimbar "copiado de staff_roles" em quem nunca esteve la.
insert into public.team_member_audit (member_id, user_id, action, reason, new_state)
select tm.id::text, tm.user_id, 'migrado',
       'sql/equipe-unica-v1.sql: nivel e PIN copiados de staff_roles (ou do papel do login, para quem nao estava la)',
       jsonb_build_object('level', tm.level, 'pin', tm.approval_pin_hash is not null, 'active', tm.active)
  from public.team_members tm
 where tm.user_id is not null
   and not exists (select 1 from public.team_member_audit a where a.member_id = tm.id::text);

-- == 5. staff_roles congelada ==============================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke insert, update, delete, truncate on public.staff_roles from service_role';
  end if;
end $$;

comment on table public.staff_roles is
  'CONGELADA por sql/equipe-unica-v1.sql: o nivel e o PIN moram em team_members (level, approval_pin_hash). Fica como rastro; a service role nao grava mais aqui.';

-- == Conferencia ===========================================================
do $$
begin
  -- Fechadas para o navegador: RLS ligada e nenhum privilegio para anon e
  -- authenticated. team_members guarda o NIVEL agora.
  if not (select relrowsecurity from pg_class where oid = 'public.team_members'::regclass) then
    raise exception 'team_members sem RLS -- o nivel responderia ao navegador';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.team_member_audit'::regclass) then
    raise exception 'team_member_audit sem RLS';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name in ('team_members', 'team_member_audit', 'staff_roles')
       and grantee in ('anon', 'authenticated'))
  then
    raise exception 'team_members, team_member_audit ou staff_roles ainda tem privilegio para anon/authenticated';
  end if;

  -- O privilegio EFETIVO (has_table_privilege), nao so a concessao direta:
  -- privilegio herdado por PUBLIC ou por outro papel tambem abre a porta.
  if exists (select 1 from pg_roles where rolname = 'anon')
     and (has_table_privilege('anon', 'public.team_members', 'SELECT, INSERT, UPDATE, DELETE')
       or has_table_privilege('authenticated', 'public.team_members', 'SELECT, INSERT, UPDATE, DELETE')
       or has_table_privilege('anon', 'public.team_member_audit', 'SELECT, INSERT, UPDATE, DELETE')
       or has_table_privilege('authenticated', 'public.team_member_audit', 'SELECT, INSERT, UPDATE, DELETE'))
  then
    raise exception 'o navegador ainda alcanca team_members ou team_member_audit';
  end if;

  -- staff_roles congelada: a service role so le.
  if exists (select 1 from pg_roles where rolname = 'service_role')
     and has_table_privilege('service_role', 'public.staff_roles', 'INSERT, UPDATE, DELETE, TRUNCATE')
  then
    raise exception 'staff_roles nao congelou: a service role ainda grava nela';
  end if;

  -- O indice do vinculo existe e e SIMPLES.
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'team_members_user_id_key'
                    and indexdef ilike '%unique%' and indexdef not ilike '% where %')
  then
    raise exception 'falta o indice unico simples team_members_user_id_key';
  end if;

  if exists (select 1 from public.team_members
              where level is null or level not in ('owner', 'manager', 'junior')) then
    raise exception 'ha linha da equipe com nivel fora de owner | manager | junior';
  end if;

  -- TODO login da firma tem a sua linha. Sem ela, getStaffLevel cairia na
  -- reserva do papel -- e um gerente com papel 'firm' viraria socio.
  if exists (
    select 1 from auth.users u
     where lower(trim(u.raw_app_meta_data->>'role')) in ('firm', 'owner', 'admin', 'manager', 'staff')
       and not exists (select 1 from public.team_members tm where tm.user_id = u.id))
  then
    raise exception 'ha login da firma sem linha na equipe -- confira a lista abaixo';
  end if;

  -- Quem so tem o carimbo da copia tem o MESMO nivel de staff_roles. Depois
  -- do deploy, mudar o nivel grava 'nivel' na trilha e a pessoa sai desta
  -- conferencia -- a divergencia passa a ser legitima.
  if exists (
    select 1 from public.team_members tm
      join public.staff_roles sr on sr.user_id = tm.user_id
     where to_jsonb(sr)->>'level' in ('owner', 'manager', 'junior')
       and tm.level <> to_jsonb(sr)->>'level'
       and not exists (select 1 from public.team_member_audit a
                        where a.member_id = tm.id::text and a.action <> 'migrado'))
  then
    raise exception 'nivel copiado diferente do de staff_roles -- a copia errou';
  end if;

  -- O CHECK do nivel recusa o que nao e nivel. Conferido numa tabela
  -- TEMPORARIA com o predicado REAL: ler o texto do check nao prova nada, e
  -- inserir na tabela de verdade ja derrubou uma migracao aqui (colunas
  -- not-null que a conferencia nao conhecia).
  execute format(
    'create temp table _conferir_nivel (level text, constraint c %s)',
    (select pg_get_constraintdef(oid) from pg_constraint
      where conname = 'team_members_level_check'
        and conrelid = 'public.team_members'::regclass));
  insert into _conferir_nivel values ('owner'), ('manager'), ('junior');
  begin
    insert into _conferir_nivel values ('socio');
    raise exception 'o CHECK do nivel aceitou "socio"';
  exception when check_violation then
    null;
  end;
  drop table _conferir_nivel;

  raise notice 'equipe-unica-v1: conferencia ok';
end $$;

-- == O que ficou (uma consulta so: o SQL Editor mostra apenas a ultima) =====
-- EQUIPE   a equipe como ficou. TEM de bater com quem trabalha na firma.
-- REVISAR  tinha nivel em staff_roles, mas o login e de CLIENTE: a porta
--          (app_metadata.role) nao deixa entrar. Nao entrou na equipe. Se
--          for gente de casa, promova o papel e reconvide; se nao for, era
--          lixo de staff_roles.
-- REVISAR  nivel desconhecido em staff_roles: entrou como junior, que e
--          como o sistema ja o tratava (padraoDoNivel nao conhece outro).
select lista, nome, email, nivel, tem_login, ativo, tem_pin
  from (
    select 'EQUIPE' as lista, 1 as ordem, tm.name as nome, tm.email, tm.level as nivel,
           (tm.user_id is not null) as tem_login, tm.active as ativo,
           (tm.approval_pin_hash is not null) as tem_pin
      from public.team_members tm
    union all
    select 'REVISAR: nivel sem porta da firma', 2, null, u.email, to_jsonb(sr)->>'level',
           true, null, null
      from public.staff_roles sr
      join auth.users u on u.id = sr.user_id
     where coalesce(lower(trim(u.raw_app_meta_data->>'role')), '')
           not in ('firm', 'owner', 'admin', 'manager', 'staff')
    union all
    select 'REVISAR: nivel desconhecido em staff_roles', 3, null, u.email, to_jsonb(sr)->>'level',
           true, null, null
      from public.staff_roles sr
      join auth.users u on u.id = sr.user_id
     where coalesce(to_jsonb(sr)->>'level', '') not in ('owner', 'manager', 'junior')
  ) x
 order by ordem, ativo desc nulls last, tem_login desc, nome;
