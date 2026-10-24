-- sql/plano-de-contas-edicao-v1.sql
-- A TRILHA DO PLANO DE CONTAS. O plano e um so para a carteira inteira, e o
-- lancamento guarda o NOME da conta: renomear, mudar de grupo ou de mae,
-- desativar e apagar mudam o livro de todos os clientes -- inclusive de anos
-- ja declarados. Ate aqui nada disso deixava rastro (principio 2).
--
-- O QUE FAZ
--   1) cria bookkeeping_category_audit: quem, quando, o motivo, como estava
--      e como ficou, e quantos lancamentos, regras e contas a pagar a
--      mudanca alcancou. Fechada para o navegador, como toda tabela nova.
--
-- A gravacao e das funcoes de sql/plano-de-contas-edicao-funcao-v1.sql, que
-- RODA DEPOIS deste arquivo: a trilha e a mudanca entram na mesma transacao.
--
-- Idempotente. Cria tabela: liga a RLS aqui mesmo, nao atribui variavel por
-- consulta e nao define funcao -- as tres coisas que fazem o SQL Editor do
-- Supabase reescrever o arquivo.

create table if not exists public.bookkeeping_category_audit (
  id             uuid primary key default gen_random_uuid(),
  category_id    text,                          -- bookkeeping_categories.id (texto: a tabela nasceu no painel)
  action         text not null
                 check (action in ('editada', 'desativada', 'reativada', 'apagada')),
  performed_by   uuid,                          -- auth.users.id de quem fez
  reason         text,                          -- o motivo digitado
  previous_state jsonb,                         -- a conta como estava
  new_state      jsonb,                         -- como ficou, e o que a mudanca alcancou
  created_at     timestamptz not null default now()
);

alter table public.bookkeeping_category_audit enable row level security;
revoke all on public.bookkeeping_category_audit from anon, authenticated;

create index if not exists bookkeeping_category_audit_por_conta
  on public.bookkeeping_category_audit (category_id, created_at desc);

comment on table public.bookkeeping_category_audit is
  'Trilha do plano de contas: edicao (nome, grupo, mae, 1099), desativacao, reativacao e remocao. Gravada na MESMA transacao da mudanca (editar_conta_do_plano, situacao_da_conta_do_plano, apagar_conta_do_plano).';

-- == Conferencia ============================================================
do $$
begin
  if to_regclass('public.bookkeeping_category_audit') is null then
    raise exception 'bookkeeping_category_audit nao foi criada';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.bookkeeping_category_audit'::regclass) then
    raise exception 'bookkeeping_category_audit sem RLS -- responderia ao navegador';
  end if;
  if exists (select 1 from information_schema.role_table_grants
              where table_schema = 'public' and table_name = 'bookkeeping_category_audit'
                and grantee in ('anon', 'authenticated')) then
    raise exception 'bookkeeping_category_audit ainda tem privilegio para anon/authenticated';
  end if;
  raise notice 'plano-de-contas-edicao-v1: conferencia ok';
end $$;
