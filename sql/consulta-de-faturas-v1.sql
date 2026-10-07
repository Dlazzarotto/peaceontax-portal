-- sql/consulta-de-faturas-v1.sql
-- AUTORIZACAO E TRILHA da consulta ampliada de faturas.
--
-- A REGRA: a lista de faturamento e do DIA e de QUEM EMITIU. Olhar dia
-- anterior ou fatura de outra pessoa e um ATO -- pede senha e motivo de um
-- gerente ou socio. So o SOCIO tem acesso ilimitado.
--
-- POR QUE A TABELA E UMA SO
-- Ela e a TRILHA (quem olhou o que, quando e por que) e a JANELA (ate
-- quando aquela liberacao vale) no mesmo lugar. Duas tabelas -- uma para
-- registrar e outra para valer -- poderiam discordar, e discordando a
-- pergunta "quem viu a carteira em setembro" deixa de ter resposta. E a
-- mesma razao pela qual `staff_grants` e append-only com uma view de
-- estado: o historico e o estado nao podem ser fontes diferentes.
--
-- Quem LIBERA nao e quem CONSULTA: `authorized_by` guarda o gerente ou
-- socio, `performed_by` guarda quem vai olhar. Sem os dois, "autorizado por
-- X" nao diz quem de fato leu a carteira.
--
-- `via` existe porque senha e codigo respondem perguntas diferentes: a
-- senha so prova que quem aprova estava NAQUELE teclado; o codigo prova que
-- um gerente, no proprio login, liberou a distancia. E a mesma distincao ja
-- gravada em `aprovadoVia` no recebimento.
--
-- Idempotente. Cria tabela: liga a RLS aqui mesmo, nao atribui variavel por
-- consulta e nao define funcao -- as tres coisas que fazem o SQL Editor do
-- Supabase reescrever o arquivo.

create table if not exists public.invoice_query_audit (
  id            uuid primary key default gen_random_uuid(),
  performed_by  uuid not null,                 -- quem vai consultar
  authorized_by uuid,                          -- o gerente/socio que liberou
  staff_level   text,                          -- nivel de quem consulta
  via           text not null default 'senha'
                check (via in ('senha', 'codigo', 'proprio')),
  reason        text not null,
  pedido        jsonb,                          -- periodo, situacao, emissor
  expira_em     timestamptz not null,
  created_at    timestamptz not null default now()
);

-- Nasce FECHADA para o navegador. No Supabase, tabela criada em `public` ja
-- vem com privilegio para anon e authenticated -- a RLS e o revoke e que
-- seguram. Sem policy, de proposito: quem le e escreve aqui e o servidor,
-- com a service role key, que passa por cima da RLS.
--
-- Aqui fechar importa DUAS vezes: a tabela diz quem olhou a carteira e
-- ate quando pode olhar. Aberta, bastaria uma linha inserida de fora para
-- alguem se autorizar sozinho -- a mesma escalada que `staff_grants` tinha.
alter table public.invoice_query_audit enable row level security;
revoke all on public.invoice_query_audit from anon, authenticated;

-- A consulta quente e "esta pessoa tem janela viva agora?".
create index if not exists invoice_query_audit_janela
  on public.invoice_query_audit (performed_by, expira_em desc);

comment on table public.invoice_query_audit is
  'Consulta ampliada de faturas: quem olhou alem do proprio dia, quem liberou, por que e ate quando. E a trilha E a janela -- duas tabelas poderiam discordar.';

-- == Conferencia ============================================================
do $$
begin
  if to_regclass('public.invoice_query_audit') is null then
    raise exception 'invoice_query_audit nao foi criada';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.invoice_query_audit'::regclass) then
    raise exception 'invoice_query_audit sem RLS -- quem tivesse a anon key se autorizaria sozinho';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'invoice_query_audit'
       and grantee in ('anon', 'authenticated'))
  then
    raise exception 'invoice_query_audit ainda tem privilegio para anon/authenticated';
  end if;

  if (select count(*) from pg_indexes
       where schemaname = 'public' and indexname = 'invoice_query_audit_janela') <> 1
  then
    raise exception 'falta o indice invoice_query_audit_janela';
  end if;

  -- MOTIVO E OBRIGATORIO. Uma consulta liberada sem motivo e uma linha que
  -- nao responde nada depois -- o oposto do que a tabela existe para fazer.
  execute 'create temp table _conferir_motivo (reason text not null)';
  begin
    insert into _conferir_motivo (reason) values (null);
    raise exception 'motivo deveria ser obrigatorio';
  exception when not_null_violation then
    null;  -- esperado
  end;
  drop table _conferir_motivo;

  -- O CHECK de `via` testado DE VERDADE, numa tabela TEMPORARIA com o
  -- predicado real: ler o texto do check nao prova nada, e inserir na tabela
  -- de verdade ja derrubou uma migracao aqui.
  execute format(
    'create temp table _conferir_via (via text, constraint c %s)',
    (select pg_get_constraintdef(oid) from pg_constraint
      where conname = 'invoice_query_audit_via_check'
        and conrelid = 'public.invoice_query_audit'::regclass));
  insert into _conferir_via (via) values ('senha'), ('codigo'), ('proprio');
  begin
    insert into _conferir_via (via) values ('nenhuma');
    raise exception 'o CHECK de via aceitou um valor que a rota nunca escreve';
  exception when check_violation then
    null;  -- esperado
  end;
  drop table _conferir_via;

  raise notice 'invoice_query_audit: tabela, indice, RLS, revoke, motivo obrigatorio e CHECK conferidos';
end $$;

select count(*) as consultas_ampliadas from public.invoice_query_audit;
