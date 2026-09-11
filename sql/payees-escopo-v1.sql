-- Fornecedor/cliente geral: cadastro que vale para todos os clientes
--
-- Contexto: a tela Listas -> Fornecedores passou a permitir mover um nome
-- entre "geral" (todos os clientes) e "so deste cliente". Geral e client_id
-- nulo, e o unique (client_id, name) nao cobre nulos no Postgres -- por isso
-- o indice parcial abaixo.
--
-- Idempotente. Rodar no SQL Editor do Supabase antes de usar a tela.

alter table public.payees alter column client_id drop not null;

-- Nome unico tambem dentro da lista geral
create unique index if not exists payees_geral_nome_uk
  on public.payees (lower(name)) where client_id is null;

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  aceita_nulo boolean;
  tem_indice  boolean;
  gerais      integer;
begin
  select is_nullable = 'YES' into aceita_nulo
    from information_schema.columns
   where table_schema = 'public' and table_name = 'payees' and column_name = 'client_id';

  select exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'payees_geral_nome_uk'
  ) into tem_indice;

  select count(*) into gerais from public.payees where client_id is null;

  raise notice 'payees.client_id aceita nulo: %', aceita_nulo;
  raise notice 'indice payees_geral_nome_uk criado: %', tem_indice;
  raise notice 'fornecedores gerais hoje: %', gerais;

  if not aceita_nulo or not tem_indice then
    raise exception 'Migracao incompleta -- confira os avisos acima';
  end if;
end $$;
