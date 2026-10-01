-- COLE ESTE ARQUIVO INTEIRO NO SQL EDITOR DO SUPABASE E APERTE RUN.
--
-- GERADO por scripts/juntar-para-colar.mjs -- nao edite a mao.
-- Junta, NA ORDEM, as migracoes abaixo e anota as tres no livro
-- (public.schema_migrations) com o MESMO sha256 que scripts/migrar.mjs
-- calcula: depois disso `--pendentes` diz APLICADO e ninguem roda de novo.
--
-- Cada parte e idempotente: rodar duas vezes nao faz mal.
--
-- Origem: sql/caixa-da-firma-v1.sql, sql/caixa-conciliacao-v1.sql, sql/caixa-conciliacao-v2.sql, sql/caixa-origens-v1.sql, sql/caixa-conciliacao-funcao-v1.sql, sql/contas-a-pagar-v1.sql

create table if not exists public.schema_migrations (
  arquivo     text primary key,
  sha256      text not null,
  aplicado_em timestamptz not null default now(),
  aplicado_por text
);
-- A RLS vai LIGADA pelo proprio arquivo, de proposito: o SQL Editor tem um
-- detector de "tabela criada sem RLS" que, quando acha uma, REESCREVE o
-- script e corta blocos no meio (o erro que sai e `unterminated
-- dollar-quoted string`, numa linha sem defeito). Sem o que acrescentar,
-- ele nao mexe. Quem trabalha nesta tabela e o servidor, com a service role.
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from anon, authenticated;


-- ===================================================================
-- sql/caixa-da-firma-v1.sql
-- ===================================================================

-- sql/caixa-da-firma-v1.sql
-- O CAIXA DA FIRMA: a Peace on Tax como cliente de si mesma.
--
-- POR QUE ASSIM
-- O bookkeeping inteiro (Plaid, importacao, motor de regras, plano de contas,
-- conciliacao, P&L, balanco) e amarrado a `clients.id`. Para a firma ter o
-- proprio livro havia dois caminhos:
--   a) tabelas separadas para o caixa da firma -- duplicaria o motor de
--      classificacao, que o projeto JA carrega em tres lugares e chama de
--      divida aceita. Seria a quarta copia.
--   b) a firma ser uma linha em `clients`, marcada.
-- Escolhido (b). O preco de (b) e que a firma passa a aparecer em toda tela
-- que lista cliente -- seletor de fatura, CRM, contagens, central de
-- bookkeeping. Por isso a marca nao e um rotulo solto: e uma FRONTEIRA.
--
-- O QUE A MARCA DECIDE (no codigo)
--   . canAccessClient  -> a linha da firma e SO DO SOCIO. Nao basta ser da
--     equipe, nem ter `verEmpresas`: o caixa da firma tem folha, honorario e
--     o resultado do ano. Sem isto, todo gerente (que tem `verEmpresas` por
--     nivel) abriria o livro da propria firma.
--   . clientesOcultos  -> a firma sai das listas: seletor de fatura, de
--     contrato, central de bookkeeping e alertas do painel. Ninguem emite
--     fatura para a propria firma por engano.
--   . /api/clients     -> sai da lista e das CONTAGENS. Contar a firma junto
--     com a carteira erra o numero que o socio le no cartao.
-- O livro dela abre em /dashboard/caixa.
--
-- UMA SO. O indice unico parcial e o que garante: duas linhas marcadas
-- dariam dois caixas, e o codigo pega "a" firma.
--
-- A coluna NAO pode ser exigida pelo codigo antes de existir: `idDaFirma`
-- (lib/caixa-firma.ts) trata a ausencia como "ainda nao ha caixa" em vez de
-- derrubar o funil de acesso. Entao rodar esta migracao depois do deploy nao
-- quebra nada -- so o /dashboard/caixa fica pedindo a migracao.
--
-- Idempotente. Nao cria tabela e nao define funcao, entao o detector de RLS
-- do SQL Editor nao tem o que reescrever aqui.

alter table public.clients
  add column if not exists is_firm boolean not null default false;

comment on column public.clients.is_firm is
  'A propria Peace on Tax. Uma linha so (indice clients_uma_firma). O livro dela e /dashboard/caixa; canAccessClient so libera para o socio.';

-- Uma firma, e uma so. Indice parcial: nao atrapalha os ~mil cadastros.
create unique index if not exists clients_uma_firma
  on public.clients (is_firm) where is_firm;

-- == Conferencia ===========================================================
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'clients'
         and column_name = 'is_firm') <> 1
  then
    raise exception 'clients.is_firm nao existe';
  end if;

  if (select count(*) from pg_indexes
       where schemaname = 'public' and indexname = 'clients_uma_firma') <> 1
  then
    raise exception 'falta o indice clients_uma_firma -- daria para marcar duas firmas';
  end if;

  if (select count(*) from public.clients where is_firm) > 1
  then
    raise exception 'ha mais de um cadastro marcado como firma';
  end if;

  raise notice 'clients.is_firm: coluna e indice unico parcial no lugar';
end $$;

-- Quem e a firma hoje (zero linhas ate o socio criar o caixa em /dashboard/caixa)
select id, name, business_name, type, active
  from public.clients
 where is_firm;


-- ===================================================================
-- sql/caixa-conciliacao-v1.sql
-- ===================================================================

-- sql/caixa-conciliacao-v1.sql
-- CONCILIACAO DE DEPOSITO: as colunas e as contas contabeis.
--
-- O DESENHO (decidido com o socio)
-- A contabilidade fiscal da firma e por REGIME DE CAIXA e a DESPESA vem
-- direto do extrato. A RECEITA nao vem: ela nasce no RECEBIMENTO da fatura
-- (cheque, Zelle, especie, cartao/ACH pelo Stripe) e fica numa conta de
-- passagem -- "Recebimentos a depositar", o Undeposited Funds do QuickBooks.
-- O deposito no banco apenas ESVAZIA essa conta.
--
-- POR QUE NAO LER A RECEITA DO EXTRATO
-- Na MESMA conta caem duas coisas diferentes: o deposito de cheque e Zelle
-- (um a um) e o REPASSE do Stripe, que junta varios pagamentos e chega
-- LIQUIDO da taxa. Lendo so o extrato, a receita bruta nunca fecha -- e e a
-- bruta que o Stripe informa ao IRS no 1099-K. Aqui o repasse de $970 vira
-- $1.000 de receita (que ja entrou no recebimento) e $30 de taxa, despesa
-- dedutivel.
--
-- A conta de passagem FECHA EM ZERO, e e isso que prova a conciliacao:
--   + recebimentos (bruto)  - taxa  - transferencia para o banco  =  0
--
-- AS DUAS COLUNAS
--   payment_id    -- o recebimento (invoice_payments) que originou a linha da
--                    conta de passagem. UNICO: a sincronizacao roda de novo a
--                    cada abertura da tela e nao pode duplicar receita.
--   deposit_tx_id -- qual deposito bancario levou esta linha embora. Nulo =
--                    ainda em transito (e o saldo da conta de passagem).
--
-- Idempotente. Nao cria tabela e nao define funcao (a funcao esta em
-- sql/caixa-conciliacao-funcao-v1.sql), entao o detector de RLS do SQL
-- Editor nao tem o que reescrever aqui.

alter table public.bank_transactions
  add column if not exists payment_id uuid;

alter table public.bank_transactions
  add column if not exists deposit_tx_id uuid;

comment on column public.bank_transactions.payment_id is
  'invoice_payments.id que originou esta linha da conta de passagem. Unico: a sincronizacao e idempotente.';
comment on column public.bank_transactions.deposit_tx_id is
  'bank_transactions.id do deposito bancario que levou esta linha. Nulo = ainda nao depositado.';

-- Um recebimento, uma linha. Sem isto, sincronizar duas vezes dobraria a
-- receita do ano -- e ninguem notaria ate o P&L.
create unique index if not exists bank_tx_um_por_recebimento
  on public.bank_transactions (payment_id) where payment_id is not null;

create index if not exists bank_tx_por_deposito
  on public.bank_transactions (deposit_tx_id) where deposit_tx_id is not null;

-- As tres contas contabeis do fluxo. O plano de contas e GLOBAL (nao tem
-- client_id), entao so entra o que serve a qualquer cliente -- e serve:
-- todo mundo que recebe por cartao paga taxa.
insert into public.bookkeeping_categories (name, kind)
select v.name, v.kind
  from (values
    ('Receita de serviços',      'income'),
    ('Taxas de processamento',   'expense'),
    ('Depósito de recebimentos', 'non_pnl')
  ) as v(name, kind)
 where not exists (
   select 1 from public.bookkeeping_categories c where c.name = v.name
 );

-- == Conferencia ===========================================================
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'bank_transactions'
         and column_name in ('payment_id', 'deposit_tx_id')) <> 2
  then
    raise exception 'faltam colunas em bank_transactions';
  end if;

  if (select count(*) from pg_indexes
       where schemaname = 'public' and indexname = 'bank_tx_um_por_recebimento') <> 1
  then
    raise exception 'falta o indice unico bank_tx_um_por_recebimento -- sincronizar duas vezes dobraria a receita';
  end if;

  if (select count(*) from public.bookkeeping_categories
       where name in ('Receita de serviços','Taxas de processamento','Depósito de recebimentos')) <> 3
  then
    raise exception 'faltam contas contabeis do fluxo de deposito';
  end if;

  raise notice 'conciliacao de deposito: colunas, indices e contas no lugar';
end $$;

-- O que o P&L vai fazer com cada uma das tres
select name, kind, active
  from public.bookkeeping_categories
 where name in ('Receita de serviços','Taxas de processamento','Depósito de recebimentos')
 order by kind;


-- ===================================================================
-- sql/caixa-conciliacao-v2.sql
-- ===================================================================

-- sql/caixa-conciliacao-v2.sql
-- O indice de "um lancamento por recebimento" tem de ser SIMPLES, nao parcial.
--
-- O QUE QUEBROU
-- A sincronizacao dos recebimentos falhou na firma com:
--   Nao foi possivel lancar os recebimentos: there is no unique or exclusion
--   constraint matching the ON CONFLICT specification
--
-- A v1 criou o indice como PARCIAL (`where payment_id is not null`). Para o
-- Postgres INFERIR um indice parcial num `on conflict (payment_id)`, o
-- comando precisaria repetir o predicado (`on conflict (payment_id) where
-- payment_id is not null`) -- e o PostgREST, que e por onde o servidor fala
-- com o banco, nao tem como mandar esse `where`. Resultado: o upsert nunca
-- encontrava o indice e a tela nao lancava recebimento nenhum.
--
-- POR QUE O SIMPLES RESOLVE E NAO AFROUXA NADA
-- Em UNIQUE, o Postgres trata cada NULL como distinto: as dezenas de
-- milhares de linhas do extrato (todas com payment_id nulo) continuam
-- entrando sem conflito. O que o indice impede e o que a gente quer impedir
-- -- dois lancamentos para o MESMO recebimento, que dobraria a receita do
-- ano. Conferido no PostgreSQL 16, nos dois sentidos.
--
-- Roda DEPOIS de sql/caixa-conciliacao-v1.sql. Idempotente: so troca o
-- indice quando ele ainda e o parcial.

do $$
begin
  if exists (
    select 1 from pg_index i
      join pg_class c on c.oid = i.indexrelid
     where c.relname = 'bank_tx_um_por_recebimento'
       and i.indpred is not null)          -- indpred preenchido = indice PARCIAL
  then
    execute 'drop index public.bank_tx_um_por_recebimento';
  end if;
end $$;

create unique index if not exists bank_tx_um_por_recebimento
  on public.bank_transactions (payment_id);

-- == Conferencia ===========================================================
do $$
begin
  if (select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname = 'bank_tx_um_por_recebimento') <> 1
  then
    raise exception 'o indice bank_tx_um_por_recebimento sumiu';
  end if;

  if (select i.indpred is not null from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname = 'bank_tx_um_por_recebimento')
  then
    raise exception 'o indice continua PARCIAL -- o on conflict nao vai enxerga-lo';
  end if;

  if not (select i.indisunique from pg_index i join pg_class c on c.oid = i.indexrelid
           where c.relname = 'bank_tx_um_por_recebimento')
  then
    raise exception 'o indice deixou de ser UNICO -- sincronizar duas vezes dobraria a receita';
  end if;

  raise notice 'bank_tx_um_por_recebimento: unico e simples, o on conflict enxerga';
end $$;

select count(*) filter (where payment_id is not null) as lancamentos_de_recebimento,
       count(*)                                        as lancamentos_no_total
  from public.bank_transactions;


-- ===================================================================
-- sql/caixa-origens-v1.sql
-- ===================================================================

-- sql/caixa-origens-v1.sql
-- A ORIGEM do lancamento: deixar o caixa da firma caber no CHECK.
--
-- O QUE QUEBROU
--   new row for relation "bank_transactions" violates check constraint
--   "bank_transactions_source_check"
--
-- `bank_transactions.source` tem um CHECK com lista fechada de origens, e o
-- caixa da firma trouxe tres que nao existiam: `recebimento` (o recebimento
-- de fatura entrando na conta de passagem), `deposito` (a transferencia que
-- esvazia essa conta) e `taxa` (a retida no repasse do Stripe). A funcao
-- `desconciliar_deposito` DEPENDE dessas duas ultimas: ela apaga
-- `where source in ('deposito','taxa')` para nao tocar no que veio do banco.
--
-- POR QUE NINGUEM VIU ANTES
-- O CHECK nao esta em arquivo nenhum: nasceu no painel do Supabase. E o caso
-- que o CLAUDE.md ja descreve -- "schema que so existe no banco vira
-- folclore". Esta migracao traz a regra para o repositorio.
--
-- COMO ELA NAO QUEBRA O QUE JA EXISTE
-- A lista nova e a UNIAO de (a) tudo o que ja esta gravado na tabela e (b) o
-- que o codigo grava hoje. Montada assim, nenhuma linha existente pode ficar
-- de fora -- inclusive origens que alguem criou e que nao estao no codigo.
-- Dropar e recriar com uma lista "que eu acho que e a certa" poderia recusar
-- uma origem antiga e travar a importacao sem aviso.
--
-- Idempotente. Nao cria tabela e nao atribui variavel por consulta (a
-- subconsulta vai dentro do `format`), entao o SQL Editor nao reescreve.

alter table public.bank_transactions
  drop constraint if exists bank_transactions_source_check;

do $$
begin
  execute format(
    'alter table public.bank_transactions add constraint bank_transactions_source_check '
    || 'check (source is null or source = any (%L::text[]))',
    (
      -- A UNIAO, sem repetir e em ordem fixa: `union` ja elimina a duplicata
      -- (um `||` cru deixava `plaid` duas vezes no texto do CHECK) e o
      -- `order by` faz a regra sair igual em toda rodada -- sem isso,
      -- comparar o CHECK de dois bancos acusa diferenca que nao existe.
      select array(
        select distinct origem from (
          -- o que ja esta gravado na tabela...
          select source as origem
            from public.bank_transactions
           where source is not null
          union
          -- ...mais o que o codigo grava hoje (o caixa trouxe os tres ultimos)
          select unnest(array['plaid', 'csv', 'pdf', 'quickbooks', 'manual',
                              'historico', 'regra', 'recebimento', 'deposito',
                              'taxa'])
        ) u
        order by origem
      )
    )
  );
end $$;

-- == Conferencia ===========================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'bank_transactions_source_check'
       and conrelid = 'public.bank_transactions'::regclass)
  then
    raise exception 'o CHECK de source nao foi recriado';
  end if;

  -- As tres do caixa precisam caber. Conferir o TEXTO do CHECK nao prova
  -- nada, mas inserir na tabela de verdade tambem nao serve: a primeira
  -- versao desta conferencia fez `insert into bank_transactions` com tres
  -- colunas e bateu em
  --   null value in column "description" violates not-null constraint
  -- derrubando a migracao INTEIRA (o SQL Editor roda tudo numa transacao,
  -- entao o CHECK novo voltou atras junto). Conferencia nao pode depender
  -- de colunas que ela nao conhece.
  --
  -- Entao: copia-se o CHECK real para uma tabela TEMPORARIA de uma coluna e
  -- testa-se nela. Mesmo predicado, nenhuma dependencia do resto do schema,
  -- e nada tocado em bank_transactions.
  execute format('create temp table _conferir_origem (source text, constraint c %s)',
    (select pg_get_constraintdef(oid) from pg_constraint
      where conname = 'bank_transactions_source_check'
        and conrelid = 'public.bank_transactions'::regclass));
  insert into _conferir_origem (source) values ('recebimento'), ('deposito'), ('taxa');
  drop table _conferir_origem;

  raise notice 'bank_transactions.source: recebimento, deposito e taxa cabem no CHECK';
end $$;

-- As origens que a tabela conhece hoje
select source, count(*) as lancamentos
  from public.bank_transactions
 group by source
 order by count(*) desc;


-- ===================================================================
-- sql/caixa-conciliacao-funcao-v1.sql
-- ===================================================================

-- sql/caixa-conciliacao-funcao-v1.sql
-- Conciliar um deposito com os recebimentos que o compoem -- num passo so.
--
-- POR QUE NO BANCO, E NAO NA ROTA
-- Sao cinco escritas que valem juntas ou nenhuma: a transferencia que esvazia
-- a conta de passagem, a taxa do Stripe, a marca em cada recebimento e a
-- classificacao do deposito. Metade gravada e livro sem conserto -- receita
-- lancada duas vezes ou taxa que nao existe. Conferir-e-gravar em dois passos
-- ja custou caro aqui (ver sql/recebimento-seguro-v1.sql).
--
-- O VALOR E RECALCULADO AQUI. A tela manda IDS; quanto isso soma e quanto
-- sobra de taxa quem decide e o banco. Numero vindo do navegador nao lanca
-- despesa.
--
-- A conta de passagem fecha em ZERO:
--   + recebimentos (bruto)  - taxa  - transferencia para o banco  =  0
--
-- Roda DEPOIS de sql/caixa-conciliacao-v1.sql. Idempotente (create or replace).
-- Nao cria tabela e nao atribui variavel por `select ... into` -- o detector
-- de RLS do SQL Editor le isso como criacao de tabela e reescreve o arquivo.

create or replace function public.conciliar_deposito(
  p_deposito     uuid,
  p_recebimentos uuid[],
  p_conta_taxa   text default 'Taxas de processamento'
) returns table (ok boolean, motivo text, bruto numeric, taxa numeric, transferencia uuid)
language plpgsql
as $function$
declare
  v_cliente uuid;
  v_conta   uuid;
  v_valor   numeric;
  v_data    date;
  v_bruto   numeric;
  v_dif     numeric;
  v_qtd     int;
  v_pedidos int;
  v_transf  uuid;
begin
  v_pedidos := coalesce(array_length(p_recebimentos, 1), 0);
  if v_pedidos = 0 then
    return query select false, 'sem_recebimentos'::text, 0::numeric, 0::numeric, null::uuid;
    return;
  end if;

  -- Trava as duas pontas ANTES de contar: dois depositos nao podem levar o
  -- mesmo recebimento, e o mesmo deposito nao pode ser conciliado duas vezes.
  perform 1 from public.bank_transactions where id = p_deposito for update;
  perform 1 from public.bank_transactions where id = any(p_recebimentos) for update;

  if not exists (select 1 from public.bank_transactions where id = p_deposito) then
    return query select false, 'deposito_nao_encontrado'::text, 0::numeric, 0::numeric, null::uuid;
    return;
  end if;

  v_cliente := (select client_id from public.bank_transactions where id = p_deposito);
  v_valor   := (select amount    from public.bank_transactions where id = p_deposito);
  v_data    := (select tx_date   from public.bank_transactions where id = p_deposito);

  if v_valor <= 0 then
    return query select false, 'nao_e_deposito'::text, 0::numeric, 0::numeric, null::uuid;
    return;
  end if;

  if exists (select 1 from public.bank_transactions where deposit_tx_id = p_deposito) then
    return query select false, 'ja_conciliado'::text, 0::numeric, 0::numeric, null::uuid;
    return;
  end if;

  -- Cada recebimento tem de ser do MESMO cliente, vir de um recebimento de
  -- fatura (payment_id) e ainda nao ter sido depositado.
  v_qtd := (select count(*) from public.bank_transactions
             where id = any(p_recebimentos)
               and client_id = v_cliente
               and payment_id is not null
               and deposit_tx_id is null);
  if v_qtd <> v_pedidos then
    return query select false, 'recebimento_invalido'::text, 0::numeric, 0::numeric, null::uuid;
    return;
  end if;

  v_bruto := (select round(coalesce(sum(amount), 0), 2) from public.bank_transactions
               where id = any(p_recebimentos));
  v_conta := (select account_id from public.bank_transactions
               where id = any(p_recebimentos) order by tx_date, id limit 1);
  v_dif   := round(v_bruto - v_valor, 2);

  -- Deposito MAIOR que os recebimentos e dinheiro sem recebimento lancado.
  -- Nao e taxa negativa: e fatura recebida que ninguem baixou.
  if v_dif < -0.005 then
    return query select false, 'falta_recebimento'::text, v_bruto, v_dif, null::uuid;
    return;
  end if;

  -- 1) A transferencia que esvazia a conta de passagem. Nao e despesa.
  insert into public.bank_transactions
    (client_id, account_id, source, tx_date, fiscal_year, description, amount,
     category, status, deposit_tx_id)
  values
    (v_cliente, v_conta, 'deposito', v_data, extract(year from v_data)::int,
     'Depósito no banco — ' || v_pedidos || ' recebimento(s)', round(-v_valor, 2),
     'Depósito de recebimentos', 'approved', p_deposito)
  returning id into v_transf;

  -- 2) A taxa retida (Stripe). Despesa dedutivel; sem ela a receita bruta
  --    nunca fecha com o banco e o 1099-K nao casa.
  if v_dif > 0.005 then
    insert into public.bank_transactions
      (client_id, account_id, source, tx_date, fiscal_year, description, amount,
       category, status, deposit_tx_id)
    values
      (v_cliente, v_conta, 'taxa', v_data, extract(year from v_data)::int,
       'Taxa retida no repasse', round(-v_dif, 2),
       p_conta_taxa, 'approved', p_deposito);
  end if;

  -- 3) Os recebimentos saem do saldo em transito.
  update public.bank_transactions
     set deposit_tx_id = p_deposito
   where id = any(p_recebimentos);

  -- 4) O deposito no extrato: nao e receita, e a outra ponta da transferencia.
  update public.bank_transactions
     set category = 'Depósito de recebimentos',
         status   = 'approved',
         transfer_match_id = v_transf
   where id = p_deposito;

  update public.bank_transactions
     set transfer_match_id = p_deposito
   where id = v_transf;

  return query select true, 'ok'::text, v_bruto, greatest(v_dif, 0), v_transf;
end
$function$;

-- Desfazer. O socio vai errar a selecao, e sem isto a unica saida seria SQL
-- na mao. Apaga SO o que a conciliacao criou (transferencia e taxa), solta os
-- recebimentos e devolve o deposito ao estado de nao classificado.
create or replace function public.desconciliar_deposito(
  p_deposito uuid
) returns table (ok boolean, motivo text, soltos int)
language plpgsql
as $function$
declare
  v_soltos int;
begin
  perform 1 from public.bank_transactions where id = p_deposito for update;

  if not exists (select 1 from public.bank_transactions where deposit_tx_id = p_deposito) then
    return query select false, 'nao_estava_conciliado'::text, 0;
    return;
  end if;

  -- As linhas criadas pela conciliacao (nunca as que vieram de recebimento)
  delete from public.bank_transactions
   where deposit_tx_id = p_deposito
     and payment_id is null
     and source in ('deposito', 'taxa');

  update public.bank_transactions
     set deposit_tx_id = null
   where deposit_tx_id = p_deposito
     and payment_id is not null;
  get diagnostics v_soltos = row_count;

  update public.bank_transactions
     set category = null, status = 'pending', transfer_match_id = null
   where id = p_deposito;

  return query select true, 'ok'::text, v_soltos;
end
$function$;


-- ===================================================================
-- sql/contas-a-pagar-v1.sql
-- ===================================================================

-- sql/contas-a-pagar-v1.sql
-- CONTAS A PAGAR da firma: a obrigacao ANTES de o dinheiro sair.
--
-- O QUE ESTA TABELA NAO E
-- Ela NAO e contabilidade. O livro da firma e por REGIME DE CAIXA: a
-- despesa nasce quando o dinheiro sai, e isso ja chega pelo extrato
-- (Plaid) e e classificado pelo motor de regras. Se a conta a pagar
-- virasse lancamento, a mesma despesa entraria DUAS vezes -- uma na
-- emissao e outra no pagamento.
--
-- O QUE ELA E
-- O caixa DIARIO: o que a firma deve, para quem e quando vence. Serve
-- para (a) nao esquecer de pagar, (b) projetar o caixa das proximas
-- semanas e (c) fechar o circulo quando o debito aparece no banco.
--
-- O ELO COM O EXTRATO
-- `paid_tx_id` aponta o lancamento bancario que pagou a conta. E o unico
-- vinculo entre os dois mundos: a conta FECHA, e a despesa continua sendo
-- a do banco. O indice unico impede que um mesmo debito pague duas contas
-- -- senao bastaria um clique a mais para a firma "pagar" o dobro no
-- papel e a projecao passar a mentir.
--
-- FORNECEDOR e o cadastro que ja existe (`payees`, com `client_id` da
-- firma e `type = 'vendor'`). Criar uma segunda lista de fornecedores
-- seria a mesma duplicacao que o projeto ja paga caro em outros lugares.
--
-- Idempotente. Cria tabela: liga a RLS aqui mesmo, nao atribui variavel
-- por consulta e nao define funcao -- as tres coisas que fazem o SQL
-- Editor do Supabase reescrever o arquivo.

create table if not exists public.firm_bills (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null,                  -- a firma (clients.is_firm)
  payee         text not null,                  -- nome do fornecedor (payees.name)
  description   text,
  category      text,                           -- conta contabil sugerida
  amount        numeric(14,2) not null check (amount > 0),
  issue_date    date,
  due_date      date not null,
  status        text not null default 'aberta'
                check (status in ('aberta', 'paga', 'cancelada')),
  paid_tx_id    uuid,                           -- bank_transactions.id que pagou
  paid_at       timestamptz,
  cancel_reason text,
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Nasce FECHADA para o navegador: quem trabalha nela e o servidor, com a
-- service role key, que passa por cima da RLS. Sem policy, de proposito.
alter table public.firm_bills enable row level security;
revoke all on public.firm_bills from anon, authenticated;

-- Um debito do banco paga UMA conta. Sem isto, dois cliques fazem a firma
-- "pagar" o dobro no papel e a projecao de caixa passa a mentir.
create unique index if not exists firm_bills_um_pagamento
  on public.firm_bills (paid_tx_id) where paid_tx_id is not null;

create index if not exists firm_bills_abertas
  on public.firm_bills (client_id, due_date) where status = 'aberta';

comment on table public.firm_bills is
  'Contas a pagar da firma. NAO e contabilidade (o livro e por caixa, e a despesa vem do extrato): e o caixa diario -- o que se deve, para quem e quando vence.';
comment on column public.firm_bills.paid_tx_id is
  'bank_transactions.id do debito que pagou. Unico: um debito nao paga duas contas.';

-- == Conferencia ===========================================================
do $$
begin
  if to_regclass('public.firm_bills') is null then
    raise exception 'firm_bills nao foi criada';
  end if;

  if (select count(*) from pg_indexes
       where schemaname = 'public' and indexname = 'firm_bills_um_pagamento') <> 1
  then
    raise exception 'falta o indice firm_bills_um_pagamento -- um debito poderia pagar duas contas';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.firm_bills'::regclass) then
    raise exception 'firm_bills sem RLS -- responderia ao navegador com a anon key';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'firm_bills'
       and grantee in ('anon', 'authenticated'))
  then
    raise exception 'firm_bills ainda tem privilegio para anon/authenticated';
  end if;

  raise notice 'firm_bills: tabela, indice unico de pagamento, RLS e revoke no lugar';
end $$;

select count(*) as contas_a_pagar from public.firm_bills;


-- ===================================================================
-- Anotar no livro de migracoes
-- ===================================================================

insert into public.schema_migrations (arquivo, sha256, aplicado_por)
values
  ('sql/caixa-da-firma-v1.sql', 'fc953f8dd2cec5ba6d64cb174c86b6f02345b9d79501a5592227bdc930191627', 'sql-editor'),
  ('sql/caixa-conciliacao-v1.sql', '64d14946e04d1bf72b79024f1d5a3493b44b8b835d81ac7181c686534dde9958', 'sql-editor'),
  ('sql/caixa-conciliacao-v2.sql', '7a78894c21191dd5085f2fcd149e891a55b85992516c3bde72348a3cd0e98198', 'sql-editor'),
  ('sql/caixa-origens-v1.sql', '4edee9addb76cec1976d5fc1a1ecf5d78156a982eeb433020b38dcd904604a02', 'sql-editor'),
  ('sql/caixa-conciliacao-funcao-v1.sql', '63dfcb7f0a702c9819572d33f736ef512cbcdefb9124f6c7624a7ee89a7ac372', 'sql-editor'),
  ('sql/contas-a-pagar-v1.sql', '1e6dce9089104130fa61f122cbad4d09a2e31ec2e4faff414c32a690765b0ddb', 'sql-editor')
on conflict (arquivo) do update
  set sha256 = excluded.sha256, aplicado_em = now(), aplicado_por = excluded.aplicado_por;

select arquivo, left(sha256, 12) as sha, aplicado_em
  from public.schema_migrations
 where arquivo in ('sql/caixa-da-firma-v1.sql', 'sql/caixa-conciliacao-v1.sql', 'sql/caixa-conciliacao-v2.sql', 'sql/caixa-origens-v1.sql', 'sql/caixa-conciliacao-funcao-v1.sql', 'sql/contas-a-pagar-v1.sql')
 order by arquivo;
