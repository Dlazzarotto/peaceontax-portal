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
-- O QUE O SQL EDITOR DO SUPABASE FAZ COM ESTE ARQUIVO
-- Ele tem um detector de "tabela criada sem RLS" e, quando acha uma,
-- REESCREVE o script para acrescentar o `enable row level security`. Esse
-- detector e de SQL puro: uma consulta que atribui a uma VARIAVEL de plpgsql
-- e lida como o `SELECT ... INTO <tabela>` do SQL puro, e ele conclui que a
-- migracao criou uma tabela com o nome da variavel. Ao reescrever, corta um
-- bloco no meio e o erro que sai e `unterminated dollar-quoted string`, numa
-- linha sem defeito nenhum.
--
-- Aconteceu duas vezes aqui, e as duas vezes ele mostrou o que inventou:
--   1a: ALTER TABLE achado  (variavel da funcao do consumo)
--   2a: ALTER TABLE t, i, c, r  (variaveis do bloco de conferencia)
--
-- Regra que sai disso, e que esta obedecida abaixo:
--   * a RLS vem escrita no proprio arquivo, para o detector nao ter o que
--     acrescentar;
--   * nenhuma consulta atribui a variavel -- subconsulta no lugar;
--   * a funcao do consumo fica em OUTRO arquivo
--     (sql/codigo-de-autorizacao-funcao-v1.sql), que nao cria tabela e por
--     isso nem chega a ser reescrito.
--
-- Honestidade sobre o que NAO se sabe: sql/permissoes-por-pessoa-v1.sql cria
-- tabela E atribui a variavel, e rodou. Provavelmente porque o aviso de RLS
-- daquela vez nao foi aceito -- a reescrita depende de um clique. Como o
-- clique nao esta na nossa mao, o arquivo e que nao pode dar margem.
--
-- Rode este primeiro e o da funcao depois.
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

-- ── Conferencia ───────────────────────────────────────
-- SEM atribuicao de variavel por consulta -- nem aqui dentro.
-- O SQL Editor do Supabase le uma consulta que atribui a variavel como o
-- `SELECT ... INTO <tabela>` do SQL puro e conclui que a migracao criou uma
-- tabela chamada `t`. Ao acrescentar o `enable row level security` dessas
-- tabelas que nao existem, ele reescreve o script e corta o bloco no meio --
-- o erro que sai e `unterminated dollar-quoted string`. Aconteceu duas
-- vezes: primeiro com uma variavel `achado` na funcao, depois com as
-- variaveis t, i, c e r DESTE bloco (ele mandou
-- `ALTER TABLE t ENABLE ROW LEVEL SECURITY`).
-- Subconsulta no lugar de variavel resolve: nao ha `into` nenhum.
do $$
begin
  if (select count(*) from information_schema.tables
       where table_schema = 'public' and table_name = 'approval_codes') <> 1
  then
    raise exception 'approval_codes nao existe';
  end if;

  if (select count(*) from pg_indexes
       where schemaname = 'public'
         and indexname in ('approval_codes_codigo_uk',
                           'approval_codes_vivos_idx',
                           'approval_codes_por_emissor_idx')) <> 3
  then
    raise exception 'faltam indices em approval_codes (esperado 3)';
  end if;

  if (select count(*) from pg_constraint
       where conname = 'approval_codes_codigo_ck') <> 1
  then
    raise exception 'falta o CHECK do formato do codigo';
  end if;

  if (select relrowsecurity from pg_class
       where oid = 'public.approval_codes'::regclass) is not true
  then
    raise exception 'approval_codes sem RLS -- a tabela responderia ao navegador';
  end if;

  raise notice 'approval_codes: tabela, 3 indices, CHECK e RLS conferidos';
  raise notice 'Agora rode sql/codigo-de-autorizacao-funcao-v1.sql';
end $$;
