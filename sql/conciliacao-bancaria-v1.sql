-- sql/conciliacao-bancaria-v1.sql
-- A conciliacao bancaria passa a ter o schema no repositorio.
--
-- POR QUE
-- `bank_reconciliations` nasceu no PAINEL do Supabase, nao num .sql -- o
-- repositorio so a citava na lista de tabelas fechadas para o navegador
-- (sql/rls-tabelas-expostas-v3.sql). O codigo pedia e gravava colunas por
-- nome (`completed_at`, `cleared_count`, `difference`, `created_by`...) sem
-- ninguem saber se o painel as tinha criado.
--
-- Isso ficou invisivel enquanto a rota IGNORAVA o erro do historico. Quando
-- ela passou a conferi-lo, uma coluna que faltasse derrubava a tela inteira
-- antes de ler os lancamentos: "nao carrega os lancamentos". A rota agora le o
-- historico com `select('*')` e grava sem a coluna opcional que faltar,
-- avisando -- e o aviso manda rodar ESTE arquivo.
--
-- O QUE FAZ
--   · cria `bank_reconciliations` se nao existir (ambiente novo);
--   · acrescenta, se faltar, cada coluna que o codigo le ou grava, nela e em
--     `bank_transactions` (`reconciliation_id`, `reconciled_at`);
--   · liga a RLS e fecha a tabela para o navegador (quem trabalha nela e o
--     servidor, com a service role key, que passa por cima da RLS).
-- Nao muda o TIPO de coluna que ja existe, nao cria restricao em tabela que ja
-- tem dados e nao apaga nada.
--
-- Idempotente. Liga a RLS ele mesmo, nao define funcao e nao atribui variavel
-- por consulta -- o detector de RLS do SQL Editor nao tem o que reescrever.

create table if not exists public.bank_reconciliations (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references public.clients(id) on delete cascade,
  account_id        uuid not null,
  statement_date    date not null,
  beginning_balance numeric(14,2) not null default 0,
  ending_balance    numeric(14,2) not null default 0,
  cleared_total     numeric(14,2),
  cleared_count     integer,
  difference        numeric(14,2),
  status            text not null default 'in_progress'
                    check (status in ('in_progress', 'completed')),
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid
);

-- A tabela do painel pode existir sem alguma delas. Nullable de proposito:
-- coluna nova numa tabela com linhas nao pode exigir valor que elas nao tem.
alter table public.bank_reconciliations add column if not exists cleared_total numeric(14,2);
alter table public.bank_reconciliations add column if not exists cleared_count integer;
alter table public.bank_reconciliations add column if not exists difference numeric(14,2);
alter table public.bank_reconciliations add column if not exists completed_at timestamptz;
alter table public.bank_reconciliations add column if not exists created_at timestamptz default now();
alter table public.bank_reconciliations add column if not exists updated_at timestamptz default now();
alter table public.bank_reconciliations add column if not exists created_by uuid;

-- A marca do lancamento: a qual conciliacao ele pertence, e quando fechou.
alter table public.bank_transactions add column if not exists reconciliation_id uuid;
alter table public.bank_transactions add column if not exists reconciled_at timestamptz;

comment on column public.bank_reconciliations.cleared_total is
  'Soma dos lancamentos marcados, apurada no servidor (lib/conciliacao-bancaria.ts), nunca a que o navegador mandou.';
comment on column public.bank_transactions.reconciliation_id is
  'Conciliacao bancaria a que o lancamento pertence. Nulo = livre para conciliar.';

-- Fechada para o navegador, como toda tabela da casa.
alter table public.bank_reconciliations enable row level security;
revoke all on public.bank_reconciliations from anon, authenticated;

-- == Conferencia ===========================================================
-- Confere o SCHEMA, sem escrever nada (conferencia nao toca em dado de
-- producao: ver sql/caixa-saldo-da-conta-v1.sql).
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'bank_reconciliations'
         and column_name in ('id', 'client_id', 'account_id', 'statement_date', 'beginning_balance',
                             'ending_balance', 'cleared_total', 'cleared_count', 'difference', 'status',
                             'completed_at', 'created_at', 'updated_at', 'created_by')) <> 14
  then
    raise exception 'faltam colunas em bank_reconciliations';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'bank_transactions'
         and column_name in ('reconciliation_id', 'reconciled_at')) <> 2
  then
    raise exception 'faltam reconciliation_id ou reconciled_at em bank_transactions';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.bank_reconciliations'::regclass) then
    raise exception 'a RLS de bank_reconciliations ficou desligada';
  end if;
  if has_table_privilege('anon', 'public.bank_reconciliations', 'select')
     or has_table_privilege('authenticated', 'public.bank_reconciliations', 'select') then
    raise exception 'bank_reconciliations ainda responde ao navegador';
  end if;
  raise notice 'bank_reconciliations: 14 colunas, RLS ligada, fechada para o navegador';
end $$;

select table_name, column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and (table_name = 'bank_reconciliations'
        or (table_name = 'bank_transactions' and column_name in ('reconciliation_id', 'reconciled_at')))
 order by table_name, ordinal_position;
