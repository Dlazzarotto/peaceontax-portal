-- sql/plano-de-contas-1099-v1.sql
-- Cada conta de despesa do plano de contas diz se vai para o 1099, e em qual
-- formulário (NEC ou MISC). Decisão do sócio: um botão em cada conta de
-- despesa, e TODA despesa paga numa conta marcada entra na lista do 1099.
--
-- O QUE ACONTECIA
-- O relatório de 1099 usava uma lista fixa no código (Contract Labor e
-- Subcontractors (COGS)). Despesa com advogado, aluguel ou qualquer conta
-- nova nunca entrava, e ninguém fora do código conseguia mudar isso.
--
-- O QUE ESTA MIGRAÇÃO FAZ
--   1) a coluna `form_1099` (nula = fora do 1099), com CHECK de valores;
--   2) na primeira vez, marca como NEC as duas contas da lista antiga, para o
--      relatório continuar igual no dia seguinte ao deploy. Se alguma conta já
--      estiver marcada, não mexe: a escolha do sócio vale mais que a lista
--      antiga.
--
-- A tabela bookkeeping_categories nasceu no painel e não está em nenhum .sql.
-- Este arquivo não a cria; só acrescenta a coluna. O plano de contas é um só
-- para a carteira, então a marca vale para todos os clientes.
--
-- Idempotente. Não atribui variável por consulta (o SQL Editor do Supabase
-- lê isso como criação de tabela).

-- 1) A coluna
alter table public.bookkeeping_categories
  add column if not exists form_1099 text;

-- 2) O CHECK: só NEC, MISC ou nulo
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'bookkeeping_categories_form_1099_check'
       and conrelid = 'public.bookkeeping_categories'::regclass
  ) then
    alter table public.bookkeeping_categories
      add constraint bookkeeping_categories_form_1099_check
      check (form_1099 is null or form_1099 in ('NEC', 'MISC'));
  end if;
end $$;

-- 3) A lista antiga vira marca, só se ninguém marcou nada ainda
do $$
begin
  if not exists (select 1 from public.bookkeeping_categories where form_1099 is not null) then
    update public.bookkeeping_categories
       set form_1099 = 'NEC'
     where name in ('Contract Labor', 'Subcontractors (COGS)')
       and kind in ('expense', 'cogs', 'other_expense');
  end if;
end $$;

-- == Conferência ===========================================================
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'bookkeeping_categories'
         and column_name = 'form_1099') <> 1
  then
    raise exception 'bookkeeping_categories.form_1099 não existe';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'bookkeeping_categories_form_1099_check'
       and conrelid = 'public.bookkeeping_categories'::regclass
  ) then
    raise exception 'CHECK de form_1099 ausente: qualquer texto entraria e o relatório ignoraria a conta';
  end if;

  if exists (select 1 from public.bookkeeping_categories
              where form_1099 is not null and kind not in ('expense', 'cogs', 'other_expense'))
  then
    raise exception 'há conta que não é de despesa marcada para o 1099';
  end if;

  raise notice 'form_1099: coluna, CHECK e só contas de despesa marcadas';
end $$;

-- As contas que vão para o 1099 agora
select name, kind, form_1099
  from public.bookkeeping_categories
 where form_1099 is not null
 order by form_1099, name;
