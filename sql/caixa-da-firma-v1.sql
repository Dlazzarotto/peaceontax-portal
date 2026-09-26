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
