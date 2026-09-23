-- sql/codigo-de-autorizacao-v1.sql
-- O codigo que um gerente/socio da para liberar UMA cobranca.
--
-- POR QUE
-- A aprovacao de recebimento em especie pedia o e-mail e a SENHA de um
-- gerente, digitados na maquina de quem esta no balcao. Senha de terceiro em
-- maquina alheia, o Supabase limitando tentativas de login por IP (40
-- atendimentos/dia do mesmo escritorio na temporada), e uma senha liberando
-- infinitas cobrancas sem ninguem saber quantas.
--
-- Agora o gerente abre a aba Autorizacao NO PROPRIO LOGIN, aparece um numero
-- e ele dita. Vale poucos minutos e UMA cobranca: o primeiro uso o queima.
--
-- O CONSUMO E ATOMICO, e isso e o ponto.
-- Dois atendentes com o mesmo numero no papel nao podem liberar duas
-- cobrancas. Quem decide e um UPDATE condicional
-- (`where usado_em is null and expira_em > now()`) com RETURNING: o Postgres
-- serializa, o segundo nao acha linha e recebe 'ja_usado'. Conferir antes e
-- gravar depois, em dois passos, deixaria a janela aberta.
--
--
-- POR QUE A FUNCAO ESTA EM OUTRO ARQUIVO
-- O SQL Editor do Supabase, quando ve `create table`, REESCREVE o script
-- para oferecer o `enable row level security`. O separador de comandos
-- dessa reescrita entende `$$` mas NAO entende tag nomeada (uma tag NOMEADA):
-- ele parte o corpo da funcao no primeiro `;` e o erro que aparece e
-- `unterminated dollar-quoted string`, numa linha sem defeito nenhum.
--
-- A prova esta no proprio projeto: sql/gatilho-saldo-da-fatura-v1.sql usa
-- tag nomeada e rodou (nao cria tabela); sql/permissoes-por-pessoa-v1.sql
-- cria tabela e rodou (so usa $$). Quebra so quando as duas coisas estao
-- no mesmo arquivo. Por isso: arquivo que cria tabela nao define funcao.
--
-- A funcao do consumo esta em sql/codigo-de-autorizacao-funcao-v1.sql.
-- Rode este primeiro e aquele depois.
--
-- Idempotente.

create table if not exists public.approval_codes (
  id           uuid primary key default gen_random_uuid(),
  codigo       text not null,
  emitido_por  uuid not null,                    -- gerente ou socio
  criado_em    timestamptz not null default now(),
  expira_em    timestamptz not null,
  -- Preenchidos no consumo: o que este codigo autorizou, exatamente
  usado_em     timestamptz,
  usado_por    uuid,
  invoice_id   uuid,
  valor        numeric(12,2),
  forma        text
);

-- Codigo nao repete. Sem isto, dois codigos iguais fariam o consumo
-- escolher um deles e o outro ficaria vivo para sempre.
create unique index if not exists approval_codes_codigo_uk
  on public.approval_codes (codigo);

-- A busca do consumo e sempre por codigo ainda nao usado
create index if not exists approval_codes_vivos_idx
  on public.approval_codes (codigo) where usado_em is null;

-- A aba do gerente lista os proprios codigos, os recentes primeiro
create index if not exists approval_codes_por_emissor_idx
  on public.approval_codes (emitido_por, criado_em desc);

-- Oito caracteres do alfabeto de lib/codigo-autorizacao.ts (sem O/0/I/1/L/S/5/Z/2)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'approval_codes_codigo_ck') then
    alter table public.approval_codes add constraint approval_codes_codigo_ck
      check (codigo ~ '^[ACDEFGHJKMNPQRTUVWXY34679]{8}$');
  end if;
end $$;

-- ── Quem enxerga a tabela ───────────────────────────────────
-- RLS ligada e SEM policy e proposital, igual a wa_* : nenhum navegador le
-- nem escreve aqui. Quem trabalha nesta tabela e o servidor, com a service
-- role key, que passa por cima da RLS.
--
-- Sem isto a tabela nasce EXPOSTA no PostgREST para quem tem a anon key --
-- que esta no navegador de todo mundo que entra no portal. Daria para ler um
-- codigo vivo antes de o gerente ditar, e daria para INSERIR um codigo
-- proprio e autorizar a si mesmo. O controle inteiro cairia.
alter table public.approval_codes enable row level security;
revoke all on public.approval_codes from anon, authenticated;

-- ── Conferencia ─────────────────────────────────────────
do $$
declare
  t integer; i integer; c integer; r boolean;
begin
  select count(*) into t from information_schema.tables
   where table_schema = 'public' and table_name = 'approval_codes';
  select count(*) into i from pg_indexes
   where schemaname = 'public'
     and indexname in ('approval_codes_codigo_uk','approval_codes_vivos_idx','approval_codes_por_emissor_idx');
  select count(*) into c from pg_constraint where conname = 'approval_codes_codigo_ck';
  select relrowsecurity into r from pg_class where oid = 'public.approval_codes'::regclass;
  raise notice 'tabela: % | indices (esperado 3): % | check: % | RLS: %', t, i, c, r;
  if t <> 1 or i <> 3 or c <> 1 or r is not true then
    raise exception 'Migracao incompleta -- confira os avisos acima';
  end if;
  raise notice 'Agora rode sql/codigo-de-autorizacao-funcao-v1.sql';
end $$;
