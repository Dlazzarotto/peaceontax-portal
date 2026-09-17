-- E-mail e contato, nao identidade. Quem identifica o login e o user_id.
--
-- A tabela clients afirmava duas coisas que a carteira real desmente:
--
--   email NOT NULL   -> 46 dos 970 clientes do QuickBooks NAO TEM e-mail.
--                       Cliente de balcao que so aparece na temporada muitas
--                       vezes nao tem, e isso nao o impede de ser cliente.
--
--   UNIQUE (email)   -> 55 e-mails servem a MAIS DE UM cadastro: o dono e a
--                       empresa dele no mesmo endereco ("Bruno Parreira" e
--                       "ABM Capital Group Inc"). Sao clientes diferentes, com
--                       declaracoes diferentes e faturas diferentes.
--
-- Juntas, as duas barravam a importacao inteira: com 46 sem e-mail espalhados
-- em 970 linhas, todo bloco de insert tinha pelo menos um.
--
-- O que de fato precisa ser unico e o LOGIN. Dois cadastros apontando para o
-- mesmo usuario do Auth e que quebra o portal - as rotas do cliente buscam por
-- user_id esperando um so. Entao a unicidade muda de coluna: sai do e-mail,
-- entra no user_id.
--
-- Idempotente. Rodar com:
--   npm run migrar -- sql/cliente-email-nao-e-identidade-v1.sql
-- (ou no SQL Editor do Supabase)

-- 1. E-mail deixa de ser obrigatorio
alter table public.clients alter column email drop not null;

-- 2. E-mail deixa de ser unico, mas continua indexado: a busca por e-mail e
--    usada no aceite do convite e no cadastro manual
alter table public.clients drop constraint if exists clients_email_key;
create index if not exists clients_email_idx
  on public.clients (email) where email is not null;

-- 3. O LOGIN passa a ser unico. Antes de criar, confere se ja ha duplicata -
--    criar o indice com duplicata existente falharia e derrubaria a migracao
--    inteira, sem dizer o motivo.
do $$
declare
  dups integer;
begin
  select count(*) into dups from (
    select user_id from public.clients
     where user_id is not null
     group by user_id having count(*) > 1
  ) d;
  if dups > 0 then
    raise exception 'Ha % usuario(s) do Auth ligados a mais de um cadastro. '
      'Resolva antes: select user_id, count(*) from public.clients '
      'where user_id is not null group by user_id having count(*) > 1;', dups;
  end if;
end $$;

create unique index if not exists clients_user_id_uk
  on public.clients (user_id) where user_id is not null;

comment on column public.clients.email is
  'Contato. Pode ser nulo (cliente sem e-mail) e pode repetir (dono e empresa dele). Quem identifica o login e user_id.';

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  obrig text; unico integer; idxEmail integer; idxUser integer;
begin
  select is_nullable into obrig from information_schema.columns
   where table_schema = 'public' and table_name = 'clients' and column_name = 'email';
  select count(*) into unico from pg_constraint
   where conrelid = 'public.clients'::regclass and conname = 'clients_email_key';
  select count(*) into idxEmail from pg_indexes
   where schemaname = 'public' and indexname = 'clients_email_idx';
  select count(*) into idxUser from pg_indexes
   where schemaname = 'public' and indexname = 'clients_user_id_uk';
  raise notice 'email aceita nulo (esperado YES): %', obrig;
  raise notice 'restricao de e-mail unico (esperado 0): %', unico;
  raise notice 'indice de busca por e-mail: %', idxEmail;
  raise notice 'indice unico de user_id: %', idxUser;
  if obrig <> 'YES' or unico <> 0 or idxEmail = 0 or idxUser = 0 then
    raise exception 'Migracao incompleta -- confira os avisos acima';
  end if;
end $$;
