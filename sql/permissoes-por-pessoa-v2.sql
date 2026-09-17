-- sql/permissoes-por-pessoa-v2.sql
-- Duas chaves novas de autorizacao:
--   verTodasFaturas — sem ela, a pessoa ve apenas as faturas que ela mesma
--                     emitiu HOJE. A lista zera no dia seguinte.
--   editarCliente   — nome, e-mail, telefone, endereco, EIN. Pede senha e
--                     motivo, e grava em client_audit.
--
-- A lista tem de bater com CHAVES de lib/permissoes.ts; a auditoria do
-- projeto falha se as duas divergirem.
--
-- Depende de sql/permissoes-por-pessoa-v1.sql. Idempotente.

do $$
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'staff_grants'
  ) then
    raise exception 'Rode sql/permissoes-por-pessoa-v1.sql primeiro.';
  end if;
end $$;

-- O CHECK nao se "estende": troca-se inteiro.
alter table public.staff_grants drop constraint if exists staff_grants_chave_ck;
alter table public.staff_grants add constraint staff_grants_chave_ck
  check (chave in (
    'criar','verTodasFaturas','receber','duplicar','editar','estornar',
    'cancelar','apagar','darDesconto','editarCliente','verRelatorios','verTotais'
  ));

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  novas integer;
begin
  -- Se o CHECK novo estiver valendo, estas duas passam; se nao, estouram.
  begin
    insert into public.staff_grants (user_id, chave, concedido, concedido_por, motivo)
    values ('00000000-0000-0000-0000-000000000000','verTodasFaturas',true,
            '00000000-0000-0000-0000-000000000000','conferencia da migracao'),
           ('00000000-0000-0000-0000-000000000000','editarCliente',true,
            '00000000-0000-0000-0000-000000000000','conferencia da migracao');
  exception when check_violation then
    raise exception 'O CHECK nao aceitou as chaves novas -- migracao incompleta';
  end;

  -- A conferencia nao deixa lixo: o user zerado nao existe em auth.users.
  delete from public.staff_grants
   where user_id = '00000000-0000-0000-0000-000000000000';
  get diagnostics novas = row_count;

  raise notice 'chaves novas aceitas e linhas de teste removidas: %', novas;
  if novas <> 2 then
    raise exception 'Conferencia inconsistente -- esperado 2, veio %', novas;
  end if;
end $$;
