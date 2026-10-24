-- sql/rls-tabelas-expostas-v3.sql
-- Fechar para o navegador as tabelas que nasceram no PAINEL do Supabase.
--
-- O QUE A VERIFICACAO ACHOU (depois da v2)
-- A v2 fechou as 8 tabelas que estavam em arquivo .sql e tirou TODA policy
-- forjavel (zero policies com user_metadata ou `using (true)` no banco). Mas a
-- varredura de "quem o navegador ainda alcanca" listou 40 tabelas que ainda
-- CONCEDEM tudo (select/insert/update/delete/truncate) a anon e authenticated.
-- Sao as nascidas no painel, fora de qualquer migracao -- "schema que so existe
-- no banco vira folclore".
--
-- POR QUE IMPORTA, mesmo com RLS ligada
-- Todas tem RLS ligada (a consulta de tabela-sem-RLS voltou vazia). Tabela com
-- RLS + grant mas SEM policy: a RLS nega tudo para quem nao e dono -- segura.
-- Tabela com RLS + grant + uma policy permissiva: alcancavel pela policy. Sete
-- tem policy (bookings, client_folders, meeting_types, folder_templates,
-- staff_availability, staff_time_blocks -- do agendamento/pastas), e varias das
-- 40 sao sensiveis (plaid_items guarda token de banco, client_payment_methods,
-- bank_accounts, invoices). Depender de "nao existe policy" e fragil: a
-- proxima policy criada no painel reabre o acesso sem aviso.
--
-- RODE DEPOIS DO MERGE DESTE PR (e do deploy). Antes dele, duas telas liam
-- estas tabelas direto do navegador e cairiam: a pagina publica /agendar
-- (meeting_types, com a anon key -- o cliente nao conseguiria agendar) e a
-- agenda da equipe (staff_availability, com a sessao). A primeira versao
-- deste cabecalho dizia "zero .from() em client component" e estava ERRADA:
-- a conferencia nao tinha sido feita. As duas telas passaram a ir por
-- /api/agenda/tipos e /api/agenda/disponibilidade, e a auditoria agora
-- recusa tela que leia tabela direto ("O navegador nao le tabela direto").
--
-- POR QUE FECHAR E SEGURO (depois do deploy)
-- Nenhum componente do navegador nem a sessao do cliente le essas tabelas
-- direto -- a auditoria confere os arquivos do navegador, um a um. As rotas
-- publicas tambem nao usam a anon key: /api/agenda/slots, /bookings, /tipos e
-- /api/invite/[token] usam a SERVICE ROLE. Quem trabalha
-- essas tabelas e o servidor com a service role, que passa POR CIMA da RLS e
-- NAO perde nada com o revoke (o revoke so tira anon/authenticated). E a
-- convencao da casa: "tabela nova nasce FECHADA; quem trabalha nelas e o
-- servidor". Mesmo padrao de sql/rls-tabelas-expostas-v1 e -v2.
--
-- As policies `client_own_*`, `staff_*` e `public_read_meeting_types` ficam:
-- com o grant revogado elas ficam inertes (sem privilegio de tabela o
-- PostgREST recusa antes de avaliar policy), e documentam a intencao.
--
-- Idempotente. Roda de novo sem efeito.

do $$
declare
  t text;
  tabelas text[] := array[
    'bank_account_audit', 'bank_accounts', 'bank_reconciliations', 'bank_transactions',
    'billing_counters', 'billing_history_import', 'bookings', 'bookkeeping_categories',
    'bookkeeping_reclass_log', 'bookkeeping_rules', 'chat_messages', 'client_audit',
    'client_folders', 'client_payment_methods', 'doc_counters', 'folder_templates',
    'invoice_audit', 'invoice_installments', 'invoice_items', 'invoice_payments',
    'invoices', 'meeting_types', 'payees', 'payment_plans', 'payment_reversals',
    'plaid_items', 'plan_alerts', 'plan_audit', 'pricing_items', 'quote_audit',
    'quotes', 'recurring_plans', 'signature_requests', 'sms_consent_log',
    'sms_messages', 'sms_sent_marker', 'staff_availability', 'staff_time_blocks',
    'tasks', 'team_members'
  ];
  ehTabela boolean;
begin
  foreach t in array tabelas loop
    -- Pode nao existir neste projeto: condicional, para a migracao nao parar.
    if to_regclass('public.' || t) is null then
      raise notice 'ausente neste projeto (ok): %', t;
      continue;
    end if;
    -- revoke serve para tabela E view; enable rls so para tabela (relkind r),
    -- senao `alter table` numa view daria erro.
    execute format('revoke all on public.%I from anon, authenticated', t);
    select c.relkind = 'r' into ehTabela
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = t;
    if ehTabela then
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;
end $$;

-- == Conferencia ===========================================================
-- Cada tabela que existe: zero privilegio para anon/authenticated e, se for
-- tabela, RLS ligada.
do $$
declare
  t text;
  tabelas text[] := array[
    'bank_account_audit', 'bank_accounts', 'bank_reconciliations', 'bank_transactions',
    'billing_counters', 'billing_history_import', 'bookings', 'bookkeeping_categories',
    'bookkeeping_reclass_log', 'bookkeeping_rules', 'chat_messages', 'client_audit',
    'client_folders', 'client_payment_methods', 'doc_counters', 'folder_templates',
    'invoice_audit', 'invoice_installments', 'invoice_items', 'invoice_payments',
    'invoices', 'meeting_types', 'payees', 'payment_plans', 'payment_reversals',
    'plaid_items', 'plan_alerts', 'plan_audit', 'pricing_items', 'quote_audit',
    'quotes', 'recurring_plans', 'signature_requests', 'sms_consent_log',
    'sms_messages', 'sms_sent_marker', 'staff_availability', 'staff_time_blocks',
    'tasks', 'team_members'
  ];
  grants integer;
  rls boolean;
  ehTabela boolean;
  checadas integer := 0;
begin
  foreach t in array tabelas loop
    if to_regclass('public.' || t) is null then continue; end if;
    checadas := checadas + 1;

    select count(*) into grants
      from information_schema.role_table_grants
     where table_schema = 'public' and table_name = t
       and grantee in ('anon', 'authenticated');

    select c.relkind = 'r', c.relrowsecurity into ehTabela, rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = t;

    if grants <> 0 then
      raise exception 'Tabela % ainda concede % privilegio(s) a anon/authenticated', t, grants;
    end if;
    if ehTabela and rls is not true then
      raise exception 'Tabela % ficou sem RLS', t;
    end if;
  end loop;

  if checadas = 0 then
    raise exception 'Nenhuma das tabelas-alvo existe -- projeto errado?';
  end if;
  raise notice 'OK: % tabelas fechadas para o navegador', checadas;
end $$;

-- == O que AINDA responde ao navegador =====================================
-- Nao muda nada. Depois desta migracao deve vir VAZIO: nenhuma tabela ou view
-- em public concede privilegio direto a anon/authenticated, e nenhuma tabela
-- fica sem RLS. (Se aparecer algo, e o proximo a fechar.)
select 'tabela/view com grant' as problema, table_name as objeto,
       string_agg(distinct privilege_type, ',') as detalhe
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon', 'authenticated')
 group by table_name
union all
select 'tabela sem RLS', c.relname, c.relkind::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
 order by 1, 2;
