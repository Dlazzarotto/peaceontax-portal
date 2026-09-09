-- Painel da equipe: fila do bookkeeping por cliente
--
-- O painel precisa separar duas coisas que antes eram um numero so:
--   sem_classificacao     status 'pending' -- ninguem classificou ainda
--   aguardando_aprovacao  status 'auto'    -- regra/IA classificou, falta aprovar
-- Agrupar por cliente e trabalho de banco: sem esta visao a pagina teria de
-- trazer dezenas de milhares de linhas so para contar.
--
-- A visao NAO e exposta ao portal: quem le e o servidor, com a service role.
-- Idempotente. Rodar no SQL Editor do Supabase.

create or replace view public.v_painel_lancamentos as
select
  t.client_id,
  count(*) filter (where t.status = 'pending') as sem_classificacao,
  count(*) filter (where t.status = 'auto')    as aguardando_aprovacao
from public.bank_transactions t
where t.status in ('pending', 'auto')
group by t.client_id;

revoke all on public.v_painel_lancamentos from anon, authenticated;

-- PostgreSQL 15+: a visao respeita as politicas de quem consulta.
do $$
begin
  execute 'alter view public.v_painel_lancamentos set (security_invoker = on)';
exception when others then
  raise notice 'security_invoker indisponivel nesta versao -- seguindo sem ele';
end $$;

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  existe   boolean;
  clientes integer;
  fila     bigint;
begin
  select exists (
    select 1 from information_schema.views
     where table_schema = 'public' and table_name = 'v_painel_lancamentos'
  ) into existe;

  if not existe then
    raise exception 'Migracao incompleta -- a visao nao foi criada';
  end if;

  select count(*), coalesce(sum(sem_classificacao + aguardando_aprovacao), 0)
    into clientes, fila
    from public.v_painel_lancamentos;

  raise notice 'clientes com fila: %', clientes;
  raise notice 'lancamentos aguardando trabalho: %', fila;
end $$;
