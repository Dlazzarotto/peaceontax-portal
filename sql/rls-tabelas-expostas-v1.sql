-- sql/rls-tabelas-expostas-v1.sql
-- Fechar staff_grants (e a view staff_grants_atual) para o navegador.
--
-- O QUE ACONTECEU
-- Das 18 tabelas do sistema, 16 nascem com `enable row level security` e
-- `revoke all ... from anon, authenticated` -- o padrao que sql/whatsapp-
-- atendimento-v1.sql escreveu e explicou. As DUAS que faltavam sao as duas
-- que eu criei: staff_grants (ja aplicada) e approval_codes (a v1 dela ja
-- ficou corrigida no proprio arquivo).
--
-- POR QUE ISSO IMPORTA
-- No Supabase, tabela nova no schema public nasce com privilegio para anon e
-- authenticated -- a RLS e que segura. Sem RLS, a tabela responde pelo
-- PostgREST a QUALQUER pessoa com a anon key, que esta no navegador de todo
-- mundo que entra no portal.
--
-- Em staff_grants isso nao e vazamento, e ESCALADA: a tabela e append-only e
-- o estado atual e a ultima linha de cada chave. Uma unica linha inserida
-- pelo navegador (`concedido = true`, chave `receber` ou `verTotais`) passa a
-- valer em permissoesDe. Quem concede tinha de ser socio, com senha e motivo;
-- pela porta dos fundos nao precisava de nada disso.
--
-- A VIEW TAMBEM
-- View no Postgres roda com o dono, nao com quem chama: RLS na tabela nao
-- protege quem le pela view. Por isso a view leva revoke propria.
--
-- Nenhuma policy, de proposito: quem trabalha nestas tabelas e o servidor,
-- com a service role key, que passa por cima da RLS.
--
-- Idempotente.

alter table public.staff_grants enable row level security;
revoke all on public.staff_grants       from anon, authenticated;
revoke all on public.staff_grants_atual from anon, authenticated;

-- approval_codes pode ainda nao existir (a migracao dela e outra). Se ja
-- existir, fecha aqui tambem -- rodar as duas em qualquer ordem da no mesmo.
do $$
begin
  if to_regclass('public.approval_codes') is not null then
    execute 'alter table public.approval_codes enable row level security';
    execute 'revoke all on public.approval_codes from anon, authenticated';
  end if;
end $$;

-- == Conferencia ===========================================================
do $$
declare
  g boolean;
  p_tab integer;
  p_view integer;
begin
  select relrowsecurity into g from pg_class where oid = 'public.staff_grants'::regclass;

  -- Privilegio que sobrou para anon/authenticated (esperado: zero)
  select count(*) into p_tab from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'staff_grants'
     and grantee in ('anon','authenticated');
  select count(*) into p_view from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'staff_grants_atual'
     and grantee in ('anon','authenticated');

  raise notice 'staff_grants RLS: % | privilegios anon/authenticated -- tabela: % view: %', g, p_tab, p_view;
  if g is not true or p_tab <> 0 or p_view <> 0 then
    raise exception 'RLS incompleta -- confira os avisos acima';
  end if;
end $$;
