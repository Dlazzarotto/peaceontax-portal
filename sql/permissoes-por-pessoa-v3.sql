-- sql/permissoes-por-pessoa-v3.sql
-- Chave nova: `enviar` — tirar a fatura do rascunho e mandar ao cliente.
--
-- POR QUE
-- Enviar estava preso a `perms.cancelar` no codigo. Dava no mesmo enquanto
-- tudo era decidido por nivel; com autorizacao individual, soltar cancelar
-- para alguem soltaria o envio junto, calado, e retirar cancelar tiraria o
-- envio sem ninguem entender por que. Sao duas decisoes diferentes.
--
-- Depende da v1 (tabela) e substitui o CHECK da v2. Idempotente.

do $$
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'staff_grants'
  ) then
    raise exception 'Rode sql/permissoes-por-pessoa-v1.sql primeiro.';
  end if;
end $$;

alter table public.staff_grants drop constraint if exists staff_grants_chave_ck;
alter table public.staff_grants add constraint staff_grants_chave_ck
  check (chave in (
    'criar','enviar','verTodasFaturas','receber','duplicar','editar','estornar',
    'cancelar','apagar','darDesconto','editarCliente','verRelatorios','verTotais'
  ));

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  limpas integer;
begin
  begin
    insert into public.staff_grants (user_id, chave, concedido, concedido_por, motivo)
    values ('00000000-0000-0000-0000-000000000000','enviar',true,
            '00000000-0000-0000-0000-000000000000','conferencia da migracao');
  exception when check_violation then
    raise exception 'O CHECK nao aceitou a chave `enviar` -- migracao incompleta';
  end;

  delete from public.staff_grants
   where user_id = '00000000-0000-0000-0000-000000000000';
  get diagnostics limpas = row_count;

  raise notice 'chave `enviar` aceita; linhas de teste removidas: %', limpas;
  if limpas <> 1 then
    raise exception 'Conferencia inconsistente -- esperado 1, veio %', limpas;
  end if;
end $$;
