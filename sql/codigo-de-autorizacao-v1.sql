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

-- ── O consumo ────────────────────────────────────────────────────────────
create or replace function public.consumir_codigo_de_autorizacao(
  p_codigo     text,
  p_usado_por  uuid,
  p_invoice_id uuid,
  p_valor      numeric,
  p_forma      text
)
returns table (ok boolean, motivo text, emitido_por uuid)
language plpgsql
as $function$
declare
  achado record;
  emissor uuid;
begin
  -- Primeiro TENTA consumir. A condicao esta no proprio UPDATE, entao dois
  -- pedidos simultaneos com o mesmo codigo nao passam os dois.
  update public.approval_codes ac set
    usado_em   = now(),
    usado_por  = p_usado_por,
    invoice_id = p_invoice_id,
    valor      = p_valor,
    forma      = p_forma
   where ac.codigo = upper(btrim(p_codigo))
     and ac.usado_em is null
     and ac.expira_em > now()
  returning ac.emitido_por into emissor;

  if emissor is not null then
    return query select true, 'ok'::text, emissor;
    return;
  end if;

  -- Nao consumiu: agora sim vale explicar por que.
  select * into achado from public.approval_codes
   where codigo = upper(btrim(p_codigo));

  if achado is null then
    return query select false, 'nao_encontrado'::text, null::uuid;
  elsif achado.usado_em is not null then
    return query select false, 'ja_usado'::text, achado.emitido_por;
  else
    return query select false, 'expirado'::text, achado.emitido_por;
  end if;
end $function$;

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  t integer; i integer; c integer; f integer;
begin
  select count(*) into t from information_schema.tables
   where table_schema = 'public' and table_name = 'approval_codes';
  select count(*) into i from pg_indexes
   where schemaname = 'public'
     and indexname in ('approval_codes_codigo_uk','approval_codes_vivos_idx','approval_codes_por_emissor_idx');
  select count(*) into c from pg_constraint where conname = 'approval_codes_codigo_ck';
  select count(*) into f from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'consumir_codigo_de_autorizacao';
  raise notice 'tabela: % | indices (esperado 3): % | check: % | funcao: %', t, i, c, f;
  if t <> 1 or i <> 3 or c <> 1 or f <> 1 then
    raise exception 'Migracao incompleta -- confira os avisos acima';
  end if;
end $$;
