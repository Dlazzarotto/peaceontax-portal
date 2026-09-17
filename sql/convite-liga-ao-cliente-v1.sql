-- Convite aponta para o cadastro que ja existe
--
-- O aceite do convite (POST /api/invite/[token]) INSERIA um cliente novo. Para
-- quem nunca foi cadastrado isso esta certo. Mas convidar alguem que JA esta na
-- carteira - como os 968 trazidos do QuickBooks - criava um SEGUNDO cadastro da
-- mesma pessoa: um sem login e outro com, com o historico partido ao meio.
--
-- Com esta coluna o convite lembra de quem ele e, e o aceite completa aquele
-- cadastro em vez de criar outro.
--
-- Idempotente. Rodar com: npm run migrar -- sql/convite-liga-ao-cliente-v1.sql
-- (ou no SQL Editor do Supabase)

alter table public.client_invitations
  add column if not exists client_id uuid references public.clients(id) on delete set null;

comment on column public.client_invitations.client_id is
  'Cadastro que este convite completa. Nulo = convidado que ainda nao existe na carteira.';

create index if not exists client_invitations_client_id_idx
  on public.client_invitations (client_id) where client_id is not null;

-- Buscar convite pendente pelo e-mail e o que a tela de clientes faz para saber
-- quem ja foi convidado
create index if not exists client_invitations_email_status_idx
  on public.client_invitations (client_email, status);

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  c integer; i1 integer; i2 integer;
begin
  select count(*) into c from information_schema.columns
   where table_schema = 'public' and table_name = 'client_invitations' and column_name = 'client_id';
  select count(*) into i1 from pg_indexes
   where schemaname = 'public' and indexname = 'client_invitations_client_id_idx';
  select count(*) into i2 from pg_indexes
   where schemaname = 'public' and indexname = 'client_invitations_email_status_idx';
  raise notice 'coluna client_id: %', c;
  raise notice 'indice client_invitations_client_id_idx: %', i1;
  raise notice 'indice client_invitations_email_status_idx: %', i2;
  if c = 0 or i1 = 0 or i2 = 0 then
    raise exception 'Migracao incompleta -- confira os avisos acima';
  end if;
end $$;
