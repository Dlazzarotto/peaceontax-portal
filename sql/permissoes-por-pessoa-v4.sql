-- sql/permissoes-por-pessoa-v4.sql
-- Duas chaves novas, decididas pelo socio:
--   verEmpresas    — sem ela, a pessoa ve e atende apenas PESSOA FISICA.
--                    Empresa e a carteira do ano todo (bookkeeping, payroll,
--                    EIN); pessoa fisica e a temporada e o balcao.
--   baixarArquivo  — abrir/salvar declaracao, W-2, extrato. VER A LISTA
--                    continua liberado: baixar nao e ver, e o arquivo e o que
--                    sai do predio.
--
-- Com isto o TIPO do cliente passa a ser fronteira de acesso — por isso
-- troca-lo na ficha pede senha e motivo e sai na trilha como type_changed.
--
-- Substitui o CHECK da v3 (que por sua vez continha a v2). Rodar so esta
-- basta, desde que a v1 (a tabela) ja tenha rodado. Idempotente.

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
    'cancelar','apagar','darDesconto',
    'verEmpresas','editarCliente','baixarArquivo',
    'verRelatorios','verTotais'
  ));

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  limpas integer;
begin
  begin
    insert into public.staff_grants (user_id, chave, concedido, concedido_por, motivo)
    values ('00000000-0000-0000-0000-000000000000','verEmpresas',true,
            '00000000-0000-0000-0000-000000000000','conferencia da migracao'),
           ('00000000-0000-0000-0000-000000000000','baixarArquivo',true,
            '00000000-0000-0000-0000-000000000000','conferencia da migracao');
  exception when check_violation then
    raise exception 'O CHECK nao aceitou as chaves novas -- migracao incompleta';
  end;

  delete from public.staff_grants
   where user_id = '00000000-0000-0000-0000-000000000000';
  get diagnostics limpas = row_count;

  raise notice 'chaves novas aceitas; linhas de teste removidas: %', limpas;
  if limpas <> 2 then
    raise exception 'Conferencia inconsistente -- esperado 2, veio %', limpas;
  end if;
end $$;
